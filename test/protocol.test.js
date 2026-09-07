/**
 * test/protocol.test.js
 * Unit tests for myhome-protocol.js
 */

"use strict";

const assert = require("assert");
let proto;
try {
    proto = require("../myhome-protocol");
} catch (e) {
    proto = require("./myhome-protocol");
}

console.log("Starting unit tests for myhome-protocol.js...\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`  [FAIL] ${name}: ${err.message}`);
        console.error(err.stack);
        failed++;
    }
}

// 1. Authentication tests
test("calcPass: basic numeric password hashing", () => {
    let hash = proto.calcPass("12345", "1234567890");
    assert.strictEqual(typeof hash, "string");
    assert.ok(hash.length > 0);
});

test("calcHMAC: SHA-1 authentication keys generation", () => {
    // 80 digits for SHA-1
    let Ra80 = "12345678901234567890123456789012345678901234567890123456789012345678901234567890";
    let keys = proto.calcHMAC(Ra80, "myPassword123");
    assert.ok(Array.isArray(keys));
    assert.strictEqual(keys.length, 2);
    assert.ok(keys[0].startsWith("*#"));
    assert.ok(keys[1].startsWith("*#"));
});

test("calcHMAC: SHA-256 authentication keys generation", () => {
    // 128 digits for SHA-256
    let Ra128 = "1".repeat(128);
    let keys = proto.calcHMAC(Ra128, "myPassword123");
    assert.ok(Array.isArray(keys));
    assert.strictEqual(keys.length, 2);
});

// 2. Stream framing tests
test("extractFrames: extracts multiple frames from stream chunk", () => {
    let stream = "*1*1*21##*1*0*22##*#4*1*0";
    let res = proto.extractFrames(stream);
    assert.strictEqual(res.frames.length, 2);
    assert.strictEqual(res.frames[0], "*1*1*21##");
    assert.strictEqual(res.frames[1], "*1*0*22##");
    assert.strictEqual(res.remaining, "*#4*1*0");
});

// 3. OWN Read tests (Bus -> MQTT)
test("parseOwnEvent: Light ON (*1*1*21##)", () => {
    let res = proto.parseOwnEvent("*1*1*21##");
    assert.strictEqual(res.mqttMessages.length, 1);
    let msg = res.mqttMessages[0];
    assert.strictEqual(msg.topic, "21/00/light/myhome/status");
    let payload = JSON.parse(msg.payload);
    assert.strictEqual(payload.state, "ON");
    assert.strictEqual(payload.brightness, 255);
    assert.strictEqual(payload.attributes.own_function, "Lighting");
});

test("parseOwnEvent: Light OFF (*1*0*21##)", () => {
    let res = proto.parseOwnEvent("*1*0*21##");
    assert.strictEqual(res.mqttMessages.length, 1);
    let msg = res.mqttMessages[0];
    assert.strictEqual(msg.topic, "21/00/light/myhome/status");
    let payload = JSON.parse(msg.payload);
    assert.strictEqual(payload.state, "OFF");
    assert.strictEqual(payload.brightness, 0);
});

test("parseOwnEvent: Light Dimmer 10 (*1*5*21## -> 50%)", () => {
    let res = proto.parseOwnEvent("*1*5*21##");
    assert.strictEqual(res.mqttMessages.length, 1);
    let payload = JSON.parse(res.mqttMessages[0].payload);
    assert.strictEqual(payload.state, "ON");
    assert.strictEqual(payload.attributes.brightness, 50);
});

test("parseOwnEvent: Light with Bus Interface (*1*1*21#4#02##)", () => {
    let res = proto.parseOwnEvent("*1*1*21#4#02##");
    assert.strictEqual(res.mqttMessages.length, 1);
    assert.strictEqual(res.mqttMessages[0].topic, "21/02/light/myhome/status");
});

test("parseOwnEvent: Cover Opening (*2*1*12##)", () => {
    let res = proto.parseOwnEvent("*2*1*12##");
    assert.strictEqual(res.mqttMessages.length, 1);
    let msg = res.mqttMessages[0];
    assert.strictEqual(msg.topic, "12/00/cover/myhome/status");
    let payload = JSON.parse(msg.payload);
    assert.strictEqual(payload.state, "opening");
});

test("parseOwnEvent: Cover Closing (*2*2*12##)", () => {
    let res = proto.parseOwnEvent("*2*2*12##");
    assert.strictEqual(res.mqttMessages.length, 1);
    let payload = JSON.parse(res.mqttMessages[0].payload);
    assert.strictEqual(payload.state, "closing");
});

test("parseOwnEvent: Cover Stopped (*2*0*12##)", () => {
    let res = proto.parseOwnEvent("*2*0*12##");
    assert.strictEqual(res.mqttMessages.length, 1);
    let payload = JSON.parse(res.mqttMessages[0].payload);
    assert.strictEqual(payload.state, "stopped");
});

test("parseOwnEvent: Climate Temperature (*#4*1*0*0215## -> 21.5°C)", () => {
    let state = new proto.StateManager();
    let res = proto.parseOwnEvent("*#4*1*0*0215##", {}, state);
    assert.ok(res.mqttMessages.length >= 2); // action + temperature
    let tempMsg = res.mqttMessages.find(m => m.topic === "1/temperature/climate/myhome/status");
    assert.ok(tempMsg);
    let payload = JSON.parse(tempMsg.payload);
    assert.strictEqual(payload.state, 21.5);
});

test("parseOwnEvent: Climate Setpoint (*#4*1*12*0205*3## -> 20.5°C)", () => {
    let state = new proto.StateManager();
    let res = proto.parseOwnEvent("*#4*1*12*0205*3##", {}, state);
    let spMsg = res.mqttMessages.find(m => m.topic === "1/setpoint/climate/myhome/status");
    assert.ok(spMsg);
    let payload = JSON.parse(spMsg.payload);
    assert.strictEqual(payload.state, 20.5);
});

test("parseOwnEvent: Climate Fan Speed (*#4*1*11*2## -> medium)", () => {
    let state = new proto.StateManager();
    let res = proto.parseOwnEvent("*#4*1*11*2##", {}, state);
    let fanMsg = res.mqttMessages.find(m => m.topic === "1/fan/climate/myhome/status");
    assert.ok(fanMsg);
    let payload = JSON.parse(fanMsg.payload);
    assert.strictEqual(payload.state, "medium");
    assert.strictEqual(payload.percentage, 66);
});

test("parseOwnEvent: Climate Heat Mode (*4*1*1##)", () => {
    let state = new proto.StateManager();
    let res = proto.parseOwnEvent("*4*1*1##", {}, state);
    let modeMsg = res.mqttMessages.find(m => m.topic === "1/mode/climate/myhome/status");
    assert.ok(modeMsg);
    let payload = JSON.parse(modeMsg.payload);
    assert.strictEqual(payload.state, "heat");
});

test("parseOwnEvent: Dry Contact standard closed (*25*31#1*31## -> ON/CLOSED)", () => {
    let res = proto.parseOwnEvent("*25*31#1*31##", { contactsReversed: ["2"] });
    assert.strictEqual(res.mqttMessages.length, 1);
    let msg = res.mqttMessages[0];
    assert.strictEqual(msg.topic, "1/contact/myhome/status");
    let payload = JSON.parse(msg.payload);
    assert.strictEqual(payload.state, "ON");
    assert.strictEqual(payload.attributes.contact_state, "CLOSED");
    assert.strictEqual(payload.attributes.contact_reversed, false);
});

test("parseOwnEvent: Dry Contact reversed closed (*25*31#1*32## with contact 2 reversed -> OFF/OPEN)", () => {
    let res = proto.parseOwnEvent("*25*31#1*32##", { contactsReversed: ["2"] });
    assert.strictEqual(res.mqttMessages.length, 1);
    let msg = res.mqttMessages[0];
    assert.strictEqual(msg.topic, "2/contact/myhome/status");
    let payload = JSON.parse(msg.payload);
    assert.strictEqual(payload.state, "OFF");
    assert.strictEqual(payload.attributes.contact_state, "OPEN");
    assert.strictEqual(payload.attributes.contact_reversed, true);
});

test("parseOwnEvent: CEN+ button press (*25*21#0*210##)", () => {
    let res = proto.parseOwnEvent("*25*21#0*210##");
    assert.strictEqual(res.mqttMessages.length, 2); // ON then emulated release OFF
    let m1 = JSON.parse(res.mqttMessages[0].payload);
    let m2 = JSON.parse(res.mqttMessages[1].payload);
    assert.strictEqual(m1.state, "ON");
    assert.strictEqual(m1.trigger, "PRESSED");
    assert.strictEqual(m2.state, "OFF");
    assert.strictEqual(m2.trigger, "RELEASED");
});

test("parseOwnEvent: Gateway Diagnostic Model (*#13**15*51## -> F454)", () => {
    let res = proto.parseOwnEvent("*#13**15*51##");
    assert.strictEqual(res.mqttMessages.length, 1);
    let msg = res.mqttMessages[0];
    assert.strictEqual(msg.topic, "gateway/myhome/status");
    let payload = JSON.parse(msg.payload);
    assert.strictEqual(payload.attributes.info, "F454");
});

// 4. OWN Write tests (MQTT -> Bus)
test("buildOwnCommands: Light ON", () => {
    let cmds = proto.buildOwnCommands("21/00/light/myhome/set", "on");
    assert.deepStrictEqual(cmds, ["*1*1*21##"]);
});

test("buildOwnCommands: Light OFF", () => {
    let cmds = proto.buildOwnCommands("21/00/light/myhome/set", "off");
    assert.deepStrictEqual(cmds, ["*1*0*21##"]);
});

test("buildOwnCommands: Light Dimmer Brightness", () => {
    let cmds = proto.buildOwnCommands("21/00/brightness/myhome/set", 128);
    // 128 / 2.55 + 100 = 150
    assert.deepStrictEqual(cmds, ["*#1*21*#1*150*0##"]);
});

test("buildOwnCommands: Cover Open/Stop/Close", () => {
    assert.deepStrictEqual(proto.buildOwnCommands("12/00/cover/myhome/set", "open"), ["*2*1*12##"]);
    assert.deepStrictEqual(proto.buildOwnCommands("12/00/cover/myhome/set", "stop"), ["*2*0*12##"]);
    assert.deepStrictEqual(proto.buildOwnCommands("12/00/cover/myhome/set", "close"), ["*2*2*12##"]);
});

test("buildOwnCommands: Climate Setpoint (21.5°C)", () => {
    let state = new proto.StateManager();
    state.set("myhome.climate.zones.1.mode", "heat");
    let cmds = proto.buildOwnCommands("1/setpoint/climate/myhome/set", 21.5, {}, state);
    assert.deepStrictEqual(cmds, ["*#4*1*#7*1*1*2150##", "*#4*1##"]);
});

test("buildOwnCommands: Climate Mode OFF", () => {
    let cmds = proto.buildOwnCommands("1/mode/climate/myhome/set", "off", { climate_off_mode: "0" });
    assert.deepStrictEqual(cmds, ["*4*303*1##", "*#4*1##"]);
});

test("buildOwnCommands: Direct Raw OWN command", () => {
    let cmds = proto.buildOwnCommands(null, "*1*1*33##");
    assert.deepStrictEqual(cmds, ["*1*1*33##"]);
});

test("buildSyncRequests: generates requests for contacts and climate zones", () => {
    let cmds = proto.buildSyncRequests("1,2", "1,2");
    assert.ok(cmds.includes("*#25*31##"));
    assert.ok(cmds.includes("*#25*32##"));
    assert.ok(cmds.includes("*#4*1##"));
    assert.ok(cmds.includes("*#4*1*0##"));
    assert.ok(cmds.includes("*#4*2##"));
});

// 5. Auto-Discovery tests
test("buildDiscoveryMessage: generates Home Assistant light config", () => {
    let disco = proto.buildDiscoveryMessage("light", "21", { prefix: "homeassistant", bus: "00" });
    assert.strictEqual(disco.topic, "homeassistant/light/myhome_light_21_00/config");
    assert.strictEqual(disco.retain, true);
    let payload = JSON.parse(disco.payload);
    assert.strictEqual(payload.name, "MyHome Light 21");
    assert.strictEqual(payload.state_topic, "21/00/light/myhome/status");
    assert.strictEqual(payload.command_topic, "21/00/light/myhome/set");
    assert.strictEqual(payload.brightness_scale, 255);
});

test("buildDiscoveryMessage: generates Home Assistant climate config", () => {
    let disco = proto.buildDiscoveryMessage("climate", 1, { prefix: "homeassistant" });
    assert.strictEqual(disco.topic, "homeassistant/climate/myhome_climate_zone_1/config");
    let payload = JSON.parse(disco.payload);
    assert.strictEqual(payload.current_temperature_topic, "1/temperature/climate/myhome/status");
    assert.strictEqual(payload.temperature_command_topic, "1/setpoint/climate/myhome/set");
    assert.deepStrictEqual(payload.modes, ["off", "heat", "cool", "auto"]);
});

test("buildDiscoveryMessage: generates Home Assistant contact config", () => {
    let disco = proto.buildDiscoveryMessage("contact", 1, { prefix: "homeassistant" });
    assert.strictEqual(disco.topic, "homeassistant/binary_sensor/myhome_contact_1/config");
    let payload = JSON.parse(disco.payload);
    assert.strictEqual(payload.device_class, "opening");
    assert.strictEqual(payload.state_topic, "1/contact/myhome/status");
});

// 6. Regression tests for subflow parity & Home Assistant compatibility
test("parseOwnEvent: CEN+ button 2 address 2 strips family prefix (*25*21#2*22##)", () => {
    let res = proto.parseOwnEvent("*25*21#2*22##");
    assert.strictEqual(res.mqttMessages[0].topic, "2/2/button/plus/myhome/status");
    let payload = JSON.parse(res.mqttMessages[0].payload);
    assert.strictEqual(payload.state, "ON");
    assert.strictEqual(payload.trigger, "PRESSED");
    assert.strictEqual(payload.attributes.powered_by, "Bruno Leonardi");
    assert.strictEqual(payload.attributes.button_number, 2);
});

test("parseOwnEvent: Dimmer level dimension parsing (*#1*11*#1*150*0##)", () => {
    let res = proto.parseOwnEvent("*#1*11*#1*150*0##");
    assert.strictEqual(res.mqttMessages.length, 1);
    assert.strictEqual(res.mqttMessages[0].topic, "11/00/light/myhome/status");
    let payload = JSON.parse(res.mqttMessages[0].payload);
    assert.strictEqual(payload.attributes.brightness, 50);
});

test("parseOwnEvent: Climate valves topic (*#4*1*19*1*1##)", () => {
    let res = proto.parseOwnEvent("*#4*1*19*1*1##");
    let vMsg = res.mqttMessages.find(m => m.topic === "1/valves/climate/myhome/status");
    assert.ok(vMsg, "valves topic should be published");
    let payload = JSON.parse(vMsg.payload);
    assert.strictEqual(payload.state, "ON");
    assert.strictEqual(payload.attributes.zone, 1);
});

test("parseOwnEvent: Climate actuators topic (*#4*1*20*1##)", () => {
    let res = proto.parseOwnEvent("*#4*1*20*1##");
    let aMsg = res.mqttMessages.find(m => m.topic === "1/actuators/climate/myhome/status");
    assert.ok(aMsg, "actuators topic should be published");
});

test("parseOwnEvent: Gateway model and firmware attributes", () => {
    let rModel = proto.parseOwnEvent("*#13**15*51##");
    let pModel = JSON.parse(rModel.mqttMessages[0].payload);
    assert.strictEqual(pModel.attributes.model, "F454");

    let rFw = proto.parseOwnEvent("*#13**16*1*0*40##");
    let pFw = JSON.parse(rFw.mqttMessages[0].payload);
    assert.strictEqual(pFw.attributes.firmware, "ver. 1 rel. 0 build 40");
});

test("buildOwnCommands: Climate mode heat sends setpoint and status check", () => {
    let cmds = proto.buildOwnCommands("1/mode/climate/myhome/set", "heat");
    assert.ok(cmds.includes("*#4*1*#7*1*1*2000##"));
    assert.ok(cmds.includes("*#4*1##"));
});

test("buildOwnCommands: Climate setpoint delta targets specific zone", () => {
    let state = new proto.StateManager();
    state.set("myhome.climate.zones.2.mode", "heat");
    state.set("myhome.climate.zones.2.setpoint.state", 20);
    let cmds = proto.buildOwnCommands("2/setpoint/delta/climate/myhome/set", 1, {}, state);
    assert.deepStrictEqual(cmds, ["*#4*2*#7*1*1*2100##"]);
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
    process.exit(1);
}
