/**
 * test/lifecycle.test.js
 * Tests node instantiation and mock Node-RED registration
 */

const EventEmitter = require('events');
const assert = require('assert');

const registeredNodes = {};
const mockNodes = {};

const mockRED = {
  nodes: {
    createNode: function(node, config) {
      const emitter = new EventEmitter();
      Object.assign(node, {
        on: emitter.on.bind(emitter),
        once: emitter.once.bind(emitter),
        emit: emitter.emit.bind(emitter),
        removeListener: emitter.removeListener.bind(emitter),
        removeAllListeners: emitter.removeAllListeners.bind(emitter),
        addListener: emitter.addListener.bind(emitter),
        setMaxListeners: emitter.setMaxListeners.bind(emitter)
      });
      node.status = function(st) {};
      node.log = function(msg) {};
      node.warn = function(msg) {};
      node.error = function(msg) {};
      node.debug = function() {};
      node.context = function() {
        return {
          global: {
            get: () => null,
            set: () => {}
          }
        };
      };
    },
    registerType: function(type, ctor) {
      registeredNodes[type] = ctor;
    },
    getNode: function(id) {
      return mockNodes[id] || null;
    }
  },
  util: {
    generateId: () => 'id_123'
  }
};

try {
  require('../myhome-own-mqtt-gateway.js')(mockRED);
  require('../myhome-own-mqtt.js')(mockRED);
} catch (e) {
  require('./myhome-own-mqtt-gateway.js')(mockRED);
  require('./myhome-own-mqtt.js')(mockRED);
}

assert.ok(registeredNodes['myhome-own-mqtt-gateway'], 'Gateway node registered');
assert.ok(registeredNodes['myhome-own-mqtt'], 'Main node registered');

// Instantiate gateway
const gw = {};
registeredNodes['myhome-own-mqtt-gateway'].call(gw, {
  host: '127.0.0.1',
  port: 20000,
  pass: '12345'
});
gw.disconnect(0);
mockNodes['gw1'] = gw;

// Instantiate main node
const mn = {};
let sentMessages = [];
mn.send = function(msg) {
  sentMessages.push(msg);
};

registeredNodes['myhome-own-mqtt'].call(mn, {
  name: 'Test Bridge',
  gateway: 'gw1',
  contacts_number: '1,2',
  climate_zones: '1,2',
  mqtt_discovery: true,
  discovery_prefix: 'homeassistant'
});

// Simulate gateway connected
gw.emit('connected');

// Simulate incoming frame on bus
gw.emit('frame', '*1*1*21##');

// Check that Output 1 got MQTT and Output 2 got OWN
let lightStatusMsg = sentMessages.find(pair => pair[0] && pair[0].topic === '21/00/light/myhome/status');
assert.ok(lightStatusMsg, 'Found MQTT light status on port 1');
let payloadObj = JSON.parse(lightStatusMsg[0].payload);
assert.strictEqual(payloadObj.state, 'ON');

let ownRawMsg = sentMessages.find(pair => pair[1] && pair[1].payload === '*1*1*21##');
assert.ok(ownRawMsg, 'Found raw OWN frame on port 2');
assert.strictEqual(ownRawMsg[1].payload, '*1*1*21##');

// Cleanup
mn.emit('close', false, () => {});
gw.emit('close', () => {});

console.log('Node-RED node lifecycle and dual-output tests passed successfully!');
process.exit(0);
