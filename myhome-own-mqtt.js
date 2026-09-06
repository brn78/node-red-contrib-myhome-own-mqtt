/**
 * myhome-own-mqtt.js
 * Main Node-RED Node for BTicino MyHome SCS OpenWebNet <-> MQTT Bridge
 * for node-red-contrib-myhome-own-mqtt
 * 
 * Inputs: 1 (MQTT command topic e.g. .../light/myhome/set, or raw OWN command)
 * Outputs: 2 (Port 1: MQTT formatted messages, Port 2: raw OWN event in chiaro as-is)
 */

"use strict";

const proto = require("./myhome-protocol");

module.exports = function (RED) {
    function MyHomeOwnMqttNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Config parameters
        node.gateway = RED.nodes.getNode(config.gateway);
        node.contacts_number = config.contacts_number || "";
        node.contacts_number_reversed = config.contacts_number_reversed || "";
        node.climate_zones = config.climate_zones || "";
        node.climate_off_mode = config.climate_off_mode || "0";
        node.watchdog = config.watchdog !== false;
        node.watchdog_interval = parseInt(config.watchdog_interval, 10) || 60;
        node.auto_sync = config.auto_sync !== false;
        node.sync_interval = parseInt(config.sync_interval, 10) || 300;
        node.mqtt_discovery = config.mqtt_discovery === true;
        node.discovery_prefix = (config.discovery_prefix || "homeassistant").trim();
        node.debug_log = config.debug_log === true;
        node.debug_warn = config.debug_warn === true;
        node.debug_error = config.debug_error === true;

        // State Manager wrapping Node-RED global/flow context
        const stateStore = new proto.StateManager(node.context().global);

        // Keep track of discovered entities to avoid duplicate retained discovery floods
        const discoveredEntities = new Set();

        let watchdogTimer = null;
        let syncTimer = null;
        let initialSyncTimeout = null;

        // Initial node status
        node.status({ fill: "blue", shape: "ring", text: "Initializing..." });

        if (!node.gateway) {
            node.status({ fill: "red", shape: "dot", text: "No gateway configured" });
            return;
        }

        const options = {
            contactsReversed: node.contacts_number_reversed.split(",").map(s => s.trim()).filter(Boolean),
            climateZones: node.climate_zones.split(",").map(s => s.trim()).filter(Boolean),
            climateZonesCount: node.climate_zones.split(",").map(s => s.trim()).filter(Boolean).length,
            climate_off_mode: node.climate_off_mode,
            contacts_number: node.contacts_number,
            climate_zones: node.climate_zones,
            manufacturer: "BTicino MyHome",
            poweredBy: "Bruno Leonardi"
        };

        /**
         * Publish Home Assistant Discovery config for an entity
         */
        function publishDiscovery(deviceType, id, extra = {}) {
            if (!node.mqtt_discovery) return;
            const key = `${deviceType}_${id}_${extra.bus || "00"}`;
            if (discoveredEntities.has(key)) return;
            discoveredEntities.add(key);

            const disco = proto.buildDiscoveryMessage(deviceType, id, {
                prefix: node.discovery_prefix,
                gatewayName: (node.gateway && node.gateway.name) ? node.gateway.name : "BTicino MyHome SCS",
                bus: extra.bus || "00"
            });

            if (disco) {
                // Send discovery message on Output 1 (MQTT) with retain: true
                node.send([
                    {
                        topic: disco.topic,
                        payload: disco.payload,
                        qos: 0,
                        retain: true,
                        _msgid: RED.util.generateId()
                    },
                    null
                ]);
            }
        }

        /**
         * Publish discovery for all statically configured zones & contacts
         */
        function publishAllConfiguredDiscoveries() {
            if (!node.mqtt_discovery) return;

            // Gateway connectivity binary_sensor
            publishDiscovery("gateway", "status");

            // Configured dry contacts
            if (node.contacts_number) {
                const contacts = node.contacts_number.split(",").map(s => s.trim()).filter(Boolean);
                for (let c of contacts) {
                    publishDiscovery("contact", c);
                }
            }

            // Configured climate zones
            if (node.climate_zones) {
                const zones = node.climate_zones.split(",").map(s => s.trim()).filter(Boolean);
                for (let z of zones) {
                    let zNum = parseInt(z, 10);
                    if (!isNaN(zNum) && zNum > 0) {
                        publishDiscovery("climate", zNum);
                    }
                }
            }
        }

        /**
         * Send connection status update to MQTT Output 1
         */
        function sendConnectionStatus(stateStr) {
            const update = {
                state: stateStr,
                attributes: {
                    manufacturer: "BTicino MyHome",
                    powered_by: "Bruno Leonardi",
                    function: "Connection watchdog"
                }
            };
            node.send([
                {
                    topic: proto.CONNECTION_TOPIC,
                    payload: JSON.stringify(update),
                    qos: 0,
                    retain: false,
                    _msgid: RED.util.generateId()
                },
                null
            ]);
        }

        /**
         * Trigger bus status sync for contacts and climate
         */
        function triggerSync() {
            if (!node.gateway || !node.gateway.isConnected) return;
            const syncCmds = proto.buildSyncRequests(node.contacts_number, node.climate_zones, stateStore);
            if (syncCmds.length > 0) {
                if (node.debug_log) node.log(`Triggering MyHome sync (${syncCmds.length} commands)...`);
                node.gateway.executeCommands(syncCmds, function () {
                    if (node.debug_log) node.log("MyHome sync requests dispatched successfully.");
                }, function (failed, errMsg) {
                    if (node.debug_warn) node.warn(`MyHome sync partially failed: ${errMsg}`);
                });
            }
        }

        // Gateway event: frame received on monitoring session
        const onFrame = function (frame) {
            const result = proto.parseOwnEvent(frame, options, stateStore);

            // Output 1: Formatted MQTT messages
            if (result.mqttMessages && result.mqttMessages.length > 0) {
                for (let m of result.mqttMessages) {
                    node.send([
                        {
                            topic: m.topic,
                            payload: m.payload,
                            qos: m.qos || 0,
                            retain: m.retain || false,
                            _msgid: RED.util.generateId()
                        },
                        null
                    ]);

                    // Auto-discovery on dynamic discovery
                    if (node.mqtt_discovery) {
                        if (m.topic.includes("/light/myhome/status")) {
                            let parts = m.topic.split("/");
                            publishDiscovery("light", parts[0], { bus: parts[1] });
                        } else if (m.topic.includes("/cover/myhome/status")) {
                            let parts = m.topic.split("/");
                            publishDiscovery("cover", parts[0], { bus: parts[1] });
                        } else if (m.topic.includes("/climate/myhome/status")) {
                            let parts = m.topic.split("/");
                            let zNum = parseInt(parts[0], 10);
                            if (!isNaN(zNum) && zNum > 0) {
                                publishDiscovery("climate", zNum);
                            }
                        } else if (m.topic.includes("/contact/myhome/status")) {
                            let parts = m.topic.split("/");
                            publishDiscovery("contact", parts[0]);
                        } else if (m.topic.includes("/aux/myhome/status")) {
                            let parts = m.topic.split("/");
                            publishDiscovery("aux", parts[0]);
                        }
                    }
                }
            }

            // Output 2: Raw OWN frame as-is
            node.send([
                null,
                {
                    payload: frame,
                    topic: "myhome/own/event",
                    _msgid: RED.util.generateId()
                }
            ]);

            // Update node status
            if (result.status) {
                node.status(result.status);
            }

            if (node.debug_log && result.debugText) {
                node.log(`OWN: ${result.debugText}`);
            }
        };

        // Gateway event: connected
        const onConnected = function () {
            node.status({ fill: "green", shape: "dot", text: "Connected" });
            sendConnectionStatus("ON");

            if (node.mqtt_discovery) {
                publishAllConfiguredDiscoveries();
            }

            if (node.auto_sync) {
                if (initialSyncTimeout) clearTimeout(initialSyncTimeout);
                initialSyncTimeout = setTimeout(function () {
                    triggerSync();
                }, 2000);
            }
        };

        // Gateway event: disconnected
        const onDisconnected = function (reason) {
            node.status({ fill: "red", shape: "dot", text: reason ? `Disconnected: ${reason}` : "Disconnected" });
            sendConnectionStatus("OFF");
        };

        // Attach listeners to gateway
        node.gateway.on("frame", onFrame);
        node.gateway.on("connected", onConnected);
        node.gateway.on("disconnected", onDisconnected);

        // Check if gateway is already connected when this node starts
        if (node.gateway.isConnected) {
            onConnected();
        }

        // Watchdog gateway model query: *#13**15##
        if (node.watchdog && node.watchdog_interval > 0) {
            watchdogTimer = setInterval(function () {
                if (node.gateway && node.gateway.isConnected) {
                    node.gateway.executeCommands(["*#13**15##"], null, function (failed, err) {
                        if (node.debug_warn) node.warn(`Watchdog check failed: ${err}`);
                    });
                }
            }, node.watchdog_interval * 1000);
        }

        // Periodic sync timer
        if (node.sync_interval > 0) {
            syncTimer = setInterval(function () {
                triggerSync();
            }, node.sync_interval * 1000);
        }

        /**
         * Handle incoming flow input messages
         */
        node.on("input", function (msg, send, done) {
            // Filter out /status topics to prevent loops
            if (msg.topic && typeof msg.topic === 'string' && msg.topic.endsWith("/status")) {
                if (done) done();
                return;
            }

            // Convert buffer payload to string if needed
            if (Buffer.isBuffer(msg.payload)) {
                msg.payload = msg.payload.toString();
            }

            let commands = [];

            if (msg.topic && typeof msg.topic === 'string') {
                // MQTT command topic (or sync)
                commands = proto.buildOwnCommands(msg.topic, msg.payload, options, stateStore);
            } else if (msg.payload) {
                // Direct OWN command(s)
                commands = proto.buildOwnCommands(null, msg.payload, options, stateStore);
            }

            if (commands.length > 0) {
                if (node.debug_log) node.log(`Executing ${commands.length} OWN command(s): ${commands.join(", ")}`);
                node.gateway.executeCommands(
                    commands,
                    function (cmds, responses, failed) {
                        if (node.debug_log) node.log(`Command(s) executed: ${cmds.join(", ")}`);
                        if (done) done();
                    },
                    function (failed, errorMsg) {
                        if (node.debug_error) node.error(`Failed executing commands [${failed.join(", ")}]: ${errorMsg}`);
                        node.status({ fill: "red", shape: "ring", text: "Command error: " + errorMsg });
                        if (done) done(new Error(errorMsg));
                    }
                );
            } else {
                if (done) done();
            }
        });

        // Cleanup on node close
        node.on("close", function (removed, done) {
            if (watchdogTimer) clearInterval(watchdogTimer);
            if (syncTimer) clearInterval(syncTimer);
            if (initialSyncTimeout) clearTimeout(initialSyncTimeout);

            if (node.gateway) {
                node.gateway.removeListener("frame", onFrame);
                node.gateway.removeListener("connected", onConnected);
                node.gateway.removeListener("disconnected", onDisconnected);
            }

            discoveredEntities.clear();
            node.status({});
            done();
        });
    }

    RED.nodes.registerType("myhome-own-mqtt", MyHomeOwnMqttNode);
};
