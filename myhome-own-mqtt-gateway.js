/**
 * myhome-own-mqtt-gateway.js
 * Node-RED Config Node for BTicino MyHome Gateway connection
 * for node-red-contrib-myhome-own-mqtt
 */

"use strict";

const net = require("net");
const proto = require("./myhome-protocol");

module.exports = function (RED) {
    function MyHomeOwnMqttGatewayNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.host = config.host;
        node.port = parseInt(config.port, 10) || 20000;
        node.pass = config.pass || "";
        node.timeout = (parseInt(config.timeout, 10) || 60) * 1000; // ms
        node.intercommandsdelay = parseInt(config.intercommandsdelay, 10) || proto.INTER_COMMANDS_DELAY;

        if (typeof node.setMaxListeners === "function") {
            node.setMaxListeners(100);
        }

        let persistentObj = { state: "disconnected" };
        let failedConnectionAttempts = 0;
        let isTryingToConnect = false;
        let autoCheckConnection = null;
        let buffer = "";

        node.isConnected = false;
        node.client = undefined;

        const RESTART_CONNECT_TIMEOUT = 500;
        const RESTART_CONNECT_TIMEOUT_MAX = 30000;

        function internalError(cmd_failed, errorMsg) {
            node.isConnected = false;
            node.emit("disconnected", errorMsg);
            if (persistentObj.state !== "disconnected") {
                node.warn(`MyHome Gateway connection issue (${errorMsg}): last state was '${persistentObj.state}', retrying...`);
                persistentObj.state = "disconnected";
            }
            node.disconnect(RESTART_CONNECT_TIMEOUT);
        }

        function checkConnection() {
            if (node.isConnected && node.client && failedConnectionAttempts === 0) {
                try {
                    node.debug("MyHome Gateway: sending keep-alive ACK to gateway...");
                    node.client.write(proto.ACK);
                } catch (e) {
                    internalError("", "Keep-alive write error: " + e.message);
                }
            }
        }

        let reconnectTimer = null;

        function instanciateClient_Connect() {
            if (!node.client) return;
            node.log(`MyHome Gateway: connecting to ${node.host}:${node.port}...`);
            node.client.connect(node.port, node.host, function () {
                node.log(`MyHome Gateway: connected to ${node.host}:${node.port}, initiating OpenWebNet monitoring handshake...`);
            });
        }

        function instanciateClient(delayBeforeRestart) {
            if (isTryingToConnect) return;

            isTryingToConnect = true;
            failedConnectionAttempts++;

            if (!node.client) {
                node.client = new net.Socket();
                setupSocketListeners();
            }

            let restartTimeout = (delayBeforeRestart === undefined) ? RESTART_CONNECT_TIMEOUT : delayBeforeRestart;
            restartTimeout = Math.min(restartTimeout * failedConnectionAttempts, RESTART_CONNECT_TIMEOUT_MAX);

            if (restartTimeout > 0) {
                node.log(`MyHome Gateway: reconnecting in ${restartTimeout / 1000}s (attempt #${failedConnectionAttempts})...`);
            }

            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(function () {
                reconnectTimer = null;
                isTryingToConnect = false;
                instanciateClient_Connect();
            }, restartTimeout);
        }

        function setupSocketListeners() {
            node.client.on("data", function (data) {
                buffer += data.toString();
                let extracted = proto.extractFrames(buffer);
                buffer = extracted.remaining;

                for (let frame of extracted.frames) {
                    node.debug(`MyHome Gateway: raw frame received: '${frame}'`);
                    if (proto.processInitialConnection(proto.START_MONITOR, frame, node.client, node, node, persistentObj, internalError)) {
                        if (!node.isConnected) {
                            node.isConnected = true;
                            failedConnectionAttempts = 0;
                            node.log(`MyHome Gateway: authenticated and monitoring session established.`);
                            node.emit("connected");
                        }

                        // Ignore NACK while connected in monitor session
                        if (frame === proto.NACK) {
                            return;
                        }

                        // Emit frame event for subscriber nodes
                        node.emit("frame", frame);
                    }
                }
            });

            node.client.on("error", function (err) {
                internalError("", "Socket error: " + err.message);
            });

            node.client.on("close", function () {
                internalError("", "Socket closed by remote host");
            });
        }

        node.disconnect = function (restartTimeout) {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            isTryingToConnect = false;
            node.isConnected = false;
            if (node.client) {
                node.client.removeAllListeners("connect");
                node.client.destroy();
                node.client = undefined;
            }

            if (restartTimeout === 0 && autoCheckConnection) {
                clearInterval(autoCheckConnection);
                autoCheckConnection = null;
            }

            if (restartTimeout > 0) {
                instanciateClient(restartTimeout);
            }
        };

        // Send command(s) using command session (*99*0##)
        node.executeCommands = function (commands, successCallback, errorCallback) {
            proto.executeCommand(
                node,
                commands,
                node,
                node.intercommandsdelay,
                true,
                successCallback,
                errorCallback
            );
        };

        // Start initial connection
        instanciateClient(0);

        // Keep-alive timer
        if (node.timeout > 0) {
            autoCheckConnection = setInterval(checkConnection, node.timeout);
        }

        node.on("close", function (done) {
            if (autoCheckConnection) {
                clearInterval(autoCheckConnection);
                autoCheckConnection = null;
            }
            node.disconnect(0);
            done();
        });
    }

    RED.nodes.registerType("myhome-own-mqtt-gateway", MyHomeOwnMqttGatewayNode);
};
