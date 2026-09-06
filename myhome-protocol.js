/**
 * myhome-protocol.js
 * OpenWebNet (OWN) <-> MQTT Protocol & Translation Engine
 * for node-red-contrib-myhome-own-mqtt
 * 
 * Contains:
 * - Authentication (Basic numeric hash & HMAC SHA-1 / SHA-256)
 * - Frame extraction & buffering from TCP streams
 * - Socket connection handshake state machine
 * - Command execution with sequential queue and inter-command delays
 * - OWN Read: converts SCS OpenWebNet bus events to MQTT topics & JSON payloads
 * - OWN Write: converts MQTT command topics & payloads to OpenWebNet commands (2025 refined engine)
 * - Requests & Sync: generates status request frames for contacts & climate zones
 * - Home Assistant MQTT Auto-Discovery generator
 */

"use strict";

const crypto = require("crypto");
const net = require("net");

// Protocol Constants
const ACK = "*#*1##";
const NACK = "*#*0##";
const START_COMMAND = "*99*0##";
const START_MONITOR = "*99*1##";
const SERVER_REQUIRES_HMAC1 = "*98*1##";
const SERVER_REQUIRES_HMAC2 = "*98*2##";
const INTERFACE = "#4#";
const INTER_COMMANDS_DELAY = 50; // ms

// State Constants
const UNDEFINED = "Undefined";
const UNKNOWN = "unknown";
const GATEWAY_ON = "ON";
const LIGHT_ON = "ON";
const LIGHT_OFF = "OFF";
const DISABLE_ON = "ON";
const DISABLE_OFF = "OFF";
const COVER_OPENING = "opening";
const COVER_CLOSING = "closing";
const COVER_STOPPED = "stopped";
const CLIMATE_MODE_OFF = "off";
const CLIMATE_MODE_HEAT = "heat";
const CLIMATE_MODE_COOL = "cool";
const CLIMATE_MODE_AUTO = "auto";
const CLIMATE_FAN_OFF = "off";
const CLIMATE_FAN_LOW = "low";
const CLIMATE_FAN_MEDIUM = "medium";
const CLIMATE_FAN_HIGH = "high";
const CLIMATE_FAN_AUTO = "auto";
const CLIMATE_FAN_PRESET_AUTO = 0;
const CLIMATE_FAN_PRESET_LOW = 33;
const CLIMATE_FAN_PRESET_MEDIUM = 66;
const CLIMATE_FAN_PRESET_HIGH = 100;
const CLIMATE_VALVE_ON = "ON";
const CLIMATE_VALVE_OFF = "OFF";
const CLIMATE_ACTUATOR_ON = "ON";
const CLIMATE_ACTUATOR_OFF = "OFF";
const CLIMATE_SPLIT_MODE = ["off", "heat", "cool", "fan", "dry", "auto"];
const CLIMATE_SPLIT_SPEED = ["auto", "low", "medium", "high", "silent"];
const CONTACT_ON = "ON";
const CONTACT_OFF = "OFF";
const CONTACT_OPEN = "OPEN";
const CONTACT_CLOSED = "CLOSED";
const AUX_ON = "ON";
const AUX_OFF = "OFF";
const AUX_OPEN = "OPEN";
const AUX_CLOSED = "CLOSED";
const BUTTON_ON = "ON";
const BUTTON_OFF = "OFF";
const BUTTON_PRESSED = "PRESSED";
const BUTTON_HOLD = "HOLD";
const BUTTON_RELEASED = "RELEASED";
const BUTTON_SLOW_RIGHT = "SLOW_RIGHT";
const BUTTON_SLOW_LEFT = "SLOW_LEFT";
const BUTTON_QUICK_RIGHT = "QUICK_RIGHT";
const BUTTON_QUICK_LEFT = "QUICK_LEFT";

// Topic Suffixes
const LIGHT_TOPIC = "light/myhome/status";
const DISABLE_TOPIC = "disable/myhome/status";
const COVER_TOPIC = "cover/myhome/status";
const CLIMATE_TOPIC = "climate/myhome/status";
const CONTACT_TOPIC = "contact/myhome/status";
const AUX_TOPIC = "aux/myhome/status";
const BUTTON_TOPIC = "button/myhome/status";
const BUTTON_PLUS_TOPIC = "button/plus/myhome/status";
const SCENARIOS_TOPIC = "scenarios/myhome/status";
const SCENE_TOPIC = "scene/myhome/status";
const GATEWAY_TOPIC = "gateway/myhome/status";
const CONNECTION_TOPIC = "connection/myhome/status";

////////////////////////////////////////////////////////////////////////
// AUTHENTICATION & PROTOCOL HELPERS
////////////////////////////////////////////////////////////////////////

/**
 * Basic numeric password hashing (OpenWebNet standard)
 */
function calcPass(pass, nonce) {
    let flag = true;
    let num1 = 0x0;
    let num2 = 0x0;
    let password = parseInt(pass, 10);

    for (let i = 0; i < nonce.length; i++) {
        let c = nonce[i];
        if (c !== '0') {
            if (flag) num2 = password;
            flag = false;
        }
        switch (c) {
            case '1':
                num1 = num2 & 0xFFFFFF80;
                num1 = num1 >>> 7;
                num2 = num2 << 25;
                num1 = num1 + num2;
                break;
            case '2':
                num1 = num2 & 0xFFFFFFF0;
                num1 = num1 >>> 4;
                num2 = num2 << 28;
                num1 = num1 + num2;
                break;
            case '3':
                num1 = num2 & 0xFFFFFFF8;
                num1 = num1 >>> 3;
                num2 = num2 << 29;
                num1 = num1 + num2;
                break;
            case '4':
                num1 = num2 << 1;
                num2 = num2 >>> 31;
                num1 = num1 + num2;
                break;
            case '5':
                num1 = num2 << 5;
                num2 = num2 >>> 27;
                num1 = num1 + num2;
                break;
            case '6':
                num1 = num2 << 12;
                num2 = num2 >>> 20;
                num1 = num1 + num2;
                break;
            case '7':
                num1 = num2 & 0x0000FF00;
                num1 = num1 + ((num2 & 0x000000FF) << 24);
                num1 = num1 + ((num2 & 0x00FF0000) >>> 16);
                num2 = (num2 & 0xFF000000) >>> 8;
                num1 = num1 + num2;
                break;
            case '8':
                num1 = num2 & 0x0000FFFF;
                num1 = num1 << 16;
                num1 = num1 + (num2 >>> 24);
                num2 = num2 & 0x00FF0000;
                num2 = num2 >>> 8;
                num1 = num1 + num2;
                break;
            case '9':
                num1 = ~num2;
                break;
            case '0':
                num1 = num2;
                break;
        }
        num2 = num1;
    }
    return (num1 >>> 0).toString();
}

/**
 * Converts decimal digits sequence to hexadecimal string
 */
function digitToHex(toConvertVal) {
    let convertedVal = "";
    for (let i = 0; i < toConvertVal.length; i += 2) {
        let hexVal = parseInt(toConvertVal.slice(i, i + 2), 10).toString(16);
        convertedVal += hexVal;
    }
    return convertedVal;
}

/**
 * Converts hexadecimal string to decimal digits sequence
 */
function hexToDigit(toConvertVal) {
    let convertedVal = "";
    for (let i = 0; i < toConvertVal.length; i++) {
        let hexVal = parseInt(toConvertVal[i], 16);
        convertedVal += ('0' + hexVal).slice(-2);
    }
    return convertedVal;
}

/**
 * Calculates HMAC SHA-1 or SHA-256 for OpenWebNet HMAC authentication
 */
function calcHMAC(Ra, password) {
    const HMAC_COPEN = '736F70653E';
    const HMAC_SOPEN = '636F70653E';

    let shaAlgo;
    if (Ra.length === 80) {
        shaAlgo = 'sha1';
    } else if (Ra.length === 128) {
        shaAlgo = 'sha256';
    } else {
        return null;
    }

    let Rb = crypto.createHmac(shaAlgo, Math.random().toString(36)).digest('hex');
    let pwd = crypto.createHash(shaAlgo).update(password).digest('hex');
    let contentToHash = digitToHex(Ra) + Rb + HMAC_COPEN + HMAC_SOPEN + pwd;
    let connectionRequest = '*#' + hexToDigit(Rb) + '*' + hexToDigit(crypto.createHash(shaAlgo).update(contentToHash).digest('hex')) + '##';
    contentToHash = digitToHex(Ra) + Rb + pwd;
    let expectedResponse = '*#' + hexToDigit(crypto.createHash(shaAlgo).update(contentToHash).digest('hex')) + '##';

    return [connectionRequest, expectedResponse];
}

/**
 * Extracts complete OpenWebNet frames from incoming socket stream data
 */
function extractFrames(dataString) {
    let frames = [];
    let buffered = dataString;
    while (buffered.length > 0) {
        let match = buffered.match(/(\*.+?##)(.*)/s);
        if (match) {
            frames.push(match[1]);
            buffered = match[2];
        } else {
            break;
        }
    }
    return { frames, remaining: buffered };
}

/**
 * Gateway connection & login handshake state machine
 */
function processInitialConnection(startCommand, packet, netSocket, node, gateway, persistentObj, errorCallback) {
    persistentObj.state = persistentObj.state || 'disconnected';
    persistentObj.HMAC_Auth = persistentObj.HMAC_Auth || [];

    if (persistentObj.state === 'connected') {
        return true;
    }

    if (packet === NACK) {
        let errorMsg = "Gateway connection/authentication failed (NACK). Last state was '" + persistentObj.state + "'";
        persistentObj.state = 'disconnected';
        if (typeof errorCallback === 'function') {
            errorCallback(startCommand, errorMsg);
        }
        return false;
    }

    function completeConnection() {
        persistentObj.state = 'connected';
        return true;
    }

    switch (persistentObj.state) {
        case 'disconnected': {
            if (packet === ACK) {
                persistentObj.state = 'handshake';
                netSocket.write(startCommand);
            }
            return false;
        }
        case 'handshake': {
            if (packet === ACK) {
                return completeConnection();
            } else if (packet === SERVER_REQUIRES_HMAC1 || packet === SERVER_REQUIRES_HMAC2) {
                persistentObj.state = 'authenticating_HMAC';
                netSocket.write(ACK);
            } else {
                let hashKey = packet.match(/^\*#(\d+)##/);
                if (hashKey === null) {
                    if (typeof errorCallback === 'function') {
                        errorCallback(startCommand, 'No valid key received for basic password check: ' + packet);
                    }
                    return false;
                }
                let hashedPwdCommand = '*#' + calcPass(gateway.pass || '12345', hashKey[1]) + '##';
                persistentObj.state = 'authenticating';
                netSocket.write(hashedPwdCommand);
            }
            return false;
        }
        case 'authenticating_HMAC': {
            let Ra = packet.match(/^\*#(\d+)##/);
            if (Ra === null) {
                if (typeof errorCallback === 'function') {
                    errorCallback(startCommand, 'Invalid HMAC random hash (Ra) received: ' + packet);
                }
                return false;
            }
            persistentObj.HMAC_Auth = calcHMAC(Ra[1], gateway.pass || '12345');
            if (!persistentObj.HMAC_Auth) {
                if (typeof errorCallback === 'function') {
                    errorCallback(startCommand, 'Unsupported HMAC key length: ' + Ra[1].length);
                }
                return false;
            }
            persistentObj.state = 'authenticating_HMAC_HashSent';
            netSocket.write(persistentObj.HMAC_Auth[0]);
            return false;
        }
        case 'authenticating_HMAC_HashSent': {
            if (packet === persistentObj.HMAC_Auth[1]) {
                netSocket.write(ACK);
                return completeConnection();
            }
            netSocket.write(NACK);
            if (typeof errorCallback === 'function') {
                errorCallback(startCommand, 'HMAC authentication mismatch on server response: ' + packet);
            }
            return false;
        }
        case 'authenticating': {
            if (packet === ACK) {
                return completeConnection();
            }
            return false;
        }
        default:
            return false;
    }
}

/**
 * Execute command(s) on gateway using a short-lived command session (*99*0##)
 */
function executeCommand(callingNode, commandsInput, gateway, interCommandsDelay, processNextCmdOnFail, successCallback, errorCallback) {
    if (!gateway || !gateway.host || !gateway.port) {
        if (typeof errorCallback === 'function') {
            errorCallback([], "Gateway not configured");
        }
        return;
    }

    let commands = [];
    if (Array.isArray(commandsInput)) {
        commands = commandsInput.flatMap(c => (c || "").toString().match(/\*.+?##/g) || []);
    } else if (typeof commandsInput === 'string') {
        commands = commandsInput.match(/\*.+?##/g) || [];
    }

    if (commands.length === 0) {
        if (typeof successCallback === 'function') {
            successCallback([], [], []);
        }
        return;
    }

    let client = new net.Socket();
    let cmd_responses = [];
    let cmd_sent = '';
    let cmd_sent_count = 0;
    let cmd_failed = [];
    let cmd_failed_count = 0;
    let cmd_success_count = 0;
    let persistentObj = { state: 'disconnected' };
    let buffer = '';

    function internalError(failedCmds, errorMsg) {
        persistentObj.state = 'disconnected';
        client.destroy();
        if (typeof errorCallback === 'function') {
            errorCallback(failedCmds, errorMsg);
        }
    }

    function writeNextCommand() {
        if (cmd_sent_count < commands.length && (cmd_failed_count === 0 || processNextCmdOnFail)) {
            cmd_sent = commands[cmd_sent_count];
            cmd_sent_count++;
            let delay = (cmd_sent_count > 1) ? Math.max(interCommandsDelay || 0, INTER_COMMANDS_DELAY) : 0;
            setTimeout(() => {
                try {
                    client.write(cmd_sent);
                } catch (e) {
                    internalError([cmd_sent], e.message);
                }
            }, delay);
            return;
        }

        client.destroy();
        if (cmd_success_count > 0 || cmd_failed_count === 0) {
            if (typeof successCallback === 'function') {
                successCallback(commands, cmd_responses, cmd_failed);
            }
        } else {
            internalError(cmd_failed, 'All commands (' + cmd_failed_count + ') failed (NACK).');
        }
    }

    client.on('error', function (err) {
        internalError(commands, 'Command socket error: ' + err.message);
    });

    client.on('data', function (data) {
        buffer += data.toString();
        let extracted = extractFrames(buffer);
        buffer = extracted.remaining;

        for (let packet of extracted.frames) {
            if (processInitialConnection(START_COMMAND, packet, client, callingNode, gateway, persistentObj, internalError)) {
                if (cmd_sent !== '') {
                    if (packet === NACK) {
                        cmd_failed_count++;
                        cmd_failed.push(cmd_sent);
                        cmd_sent = '';
                        writeNextCommand();
                    } else if (packet === ACK) {
                        cmd_success_count++;
                        cmd_sent = '';
                        writeNextCommand();
                    } else {
                        cmd_responses.push(packet);
                    }
                } else {
                    writeNextCommand();
                }
            }
        }
    });

    client.connect(gateway.port, gateway.host, function () {
    });

    client.on('close', function () {
        client.destroy();
    });
}

////////////////////////////////////////////////////////////////////////
// OWN READ (BUS EVENT -> MQTT MESSAGES)
////////////////////////////////////////////////////////////////////////

function GetDayOfWeek(dayofweek) {
    dayofweek = parseInt(dayofweek, 10);
    const days = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
    return days[dayofweek] || UNDEFINED;
}

function GetMonth(month) {
    month = parseInt(month, 10);
    const months = ["", "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
    return months[month] || UNDEFINED;
}

function GetGMT(gmt) {
    return (gmt && gmt.startsWith("0")) ? "GMT+" + gmt.substring(1) : "GMT-" + (gmt ? gmt.substring(1) : "0");
}

function GetGatewayModel(model) {
    switch (parseInt(model, 10)) {
        case 2: return "MHServer";
        case 4: return "MH200";
        case 6: return "F452";
        case 7: return "F452V";
        case 11: return "MHServer2";
        case 12: return "F452AV";
        case 13: return "H4684";
        case 15: return "F427 (Open-KNX)";
        case 16: return "F453";
        case 23: return "H4684";
        case 27: return "L4686SDK";
        case 44: return "MH200N";
        case 51: return "F454";
        case 200: return "F454 v2";
        default: return `Unknown Model ${model}`;
    }
}

function GetValveState(value) {
    value = parseInt(value, 10);
    if (value === 0 || value === 3 || value === 4 || value === 5) return CLIMATE_VALVE_OFF;
    if (value === 1 || value === 2 || value === 6 || value === 7 || value === 8) return CLIMATE_VALVE_ON;
    return CLIMATE_VALVE_OFF;
}

function GetActuatorState(value) {
    value = parseInt(value, 10);
    if (value === 0 || value === 3 || value === 4 || value === 5) return CLIMATE_ACTUATOR_OFF;
    if (value === 1 || value === 2 || value === 6 || value === 7 || value === 8 || value === 9) return CLIMATE_ACTUATOR_ON;
    return CLIMATE_ACTUATOR_OFF;
}

function createDefaultClimateZone() {
    return {
        action: "off",
        type: UNKNOWN,
        temperature: {
            master: 0,
            slave: { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, t7: 0, t8: 0 }
        },
        fan: { present: UNKNOWN, preset: UNKNOWN, percentage: 0 },
        knob: UNKNOWN,
        setpoint: { state: 0, offset: 0, heating: 0, cooling: 0 },
        mode: CLIMATE_MODE_OFF,
        mode_function: UNKNOWN,
        remote_control: UNKNOWN,
        central_unit: UNKNOWN,
        valve: { state: "OFF", heating: "OFF", cooling: "OFF" },
        actuator: { state: "OFF", a1: "OFF", a2: "OFF", a3: "OFF", a4: "OFF", a5: "OFF", a6: "OFF", a7: "OFF", a8: "OFF", a9: "OFF" },
        event: UNKNOWN,
        unixtime: Date.now()
    };
}

class StateManager {
    constructor(externalContext) {
        this.context = externalContext || null;
        this.memory = new Map();
    }

    get(key) {
        if (this.context && typeof this.context.get === 'function') {
            let val = this.context.get(key);
            if (val !== undefined && val !== null) return val;
        }
        return this.memory.get(key);
    }

    set(key, val) {
        if (this.context && typeof this.context.set === 'function') {
            try { this.context.set(key, val); } catch (e) { }
        }
        this.memory.set(key, val);
    }
}

/**
 * Parse an incoming OpenWebNet bus frame and generate corresponding MQTT message(s)
 */
function parseOwnEvent(OwnEvent, options = {}, state = null) {
    if (!state) state = new StateManager();

    const MANUFACTURER = options.manufacturer || "BTicino MyHome";
    const POWERED_BY = options.poweredBy || "Bruno Leonardi";
    const CONTACTS_NUMBER_REVERSED = (options.contactsReversed || []).map(String);
    const CLIMATE_ZONES_COUNT = parseInt(options.climateZonesCount, 10) || 0;

    let mqttMessages = [];
    let ResultState = null;
    let DebugText = null;
    let OwnFrame = [];
    let OwnWho = null;
    let OwnWhoName = null;
    let OwnWhoFunction = null;
    let OwnWhat = null;
    let OwnWhere = null;
    let OwnWhereTable = null;
    let OwnAPL = null;
    let OwnZone = 0;
    let OwnZoneSlave = 0;
    let OwnActuator = 0;
    let OwnDimension = null;
    let OwnBus = "00";

    function GetClimateZone(num = 0) {
        let z = state.get(`myhome.climate.zones.${num}`);
        if (!z) {
            z = createDefaultClimateZone();
        }
        return JSON.parse(JSON.stringify(z));
    }

    function SetClimateZone(num, z) {
        let CentralUnit = state.get(`myhome.climate.zones.0`);
        z.central_unit = (CentralUnit !== null && CentralUnit !== undefined) ? true : (num === 0);
        z.type = (num > 0) ? "zone" : "central_unit";
        z.unixtime = Date.now();
        z.event = OwnEvent;
        state.set(`myhome.climate.zones.${num}`, z);
    }

    function GetActionZone(num = 0) {
        let gz = GetClimateZone(num);
        if ((gz.valve.heating || "").toLowerCase() === "on") return "heating";
        if ((gz.valve.cooling || "").toLowerCase() === "on") return "cooling";
        if ((gz.mode || "").toLowerCase() !== "off") return "idle";
        return "off";
    }

    function GlobalWhoStore() {
        let GLOBAL_WHO = {
            name: OwnWhoName,
            function: OwnWhoFunction,
            event: OwnEvent,
            unixtime: Date.now()
        };
        state.set(`myhome.who.${OwnWho}`, GLOBAL_WHO);
    }

    function sendMqtt(topic, payloadObj) {
        let msg = {
            topic: topic,
            payload: JSON.stringify(payloadObj),
            qos: 0,
            retain: false
        };
        mqttMessages.push(msg);
        GlobalWhoStore();
    }

    function GetWho() {
        if (OwnEvent != null && OwnEvent !== ACK && OwnEvent !== NACK && OwnEvent.startsWith("*")) {
            OwnFrame = OwnEvent.substring(1).replace("##", "").split("*");
            OwnWho = OwnFrame[0].replaceAll("#", "");
            OwnWho = parseInt(OwnWho, 10);
        }
        return OwnWho;
    }

    function GetBus() {
        if (OwnEvent != null && OwnEvent !== ACK && OwnEvent !== NACK && OwnEvent.startsWith("*")) {
            let idx = OwnEvent.indexOf(INTERFACE);
            OwnBus = (idx !== -1) ? OwnEvent.substring(idx + INTERFACE.length, idx + INTERFACE.length + 2) : "00";
        }
        return OwnBus;
    }

    function GetWhereTable() {
        OwnWhere = (OwnWhere == null) ? UNDEFINED : OwnWhere;
        OwnAPL = (OwnBus !== "00") ? OwnWhere.toString().replace(INTERFACE + OwnBus, "") : OwnWhere.toString();

        if (OwnWho === 1 || OwnWho === 2) {
            if (OwnAPL === "0") {
                OwnWhereTable = "General";
                OwnAPL = OwnAPL.replaceAll("#", "") + "GEN";
            } else if (OwnAPL === "00" || OwnAPL === "100" || (OwnAPL.length === 1 && parseInt(OwnAPL, 10) > 0 && parseInt(OwnAPL, 10) < 10)) {
                OwnWhereTable = "Area";
                OwnAPL = OwnAPL.replaceAll("#", "") + "A";
            } else if (OwnAPL.startsWith("#")) {
                OwnWhereTable = "Group";
                OwnAPL = OwnAPL.replaceAll("#", "") + "G";
            } else {
                OwnWhereTable = OwnWhoName ? (OwnWhoName.charAt(0).toUpperCase() + OwnWhoName.slice(1)) : "";
            }
        } else {
            OwnWhereTable = OwnWhoName ? (OwnWhoName.charAt(0).toUpperCase() + OwnWhoName.slice(1)) : "";
        }

        OwnAPL = OwnAPL.replace("#", "");
        return OwnWhereTable;
    }

    OwnWho = GetWho();
    OwnBus = GetBus();

    if (OwnWho === 0) {
        OwnWhoFunction = "Scenarios Functions";
        OwnWhoName = "Scenarios";
        OwnWhat = parseInt(OwnFrame[1], 10);
        OwnWhere = OwnFrame[2];
        OwnWhereTable = GetWhereTable();

        if (OwnWhat >= 1 && OwnWhat <= 20) {
            ResultState = OwnWhat;
            DebugText = `Activation ${OwnWhereTable} number ${OwnWhat} from control panel ${parseInt(OwnWhere, 10)}`;
            sendMqtt(`${OwnWhere}/${OwnWhat}/${OwnBus}/${SCENARIOS_TOPIC}`, {
                state: "ON",
                attributes: {
                    manufacturer: MANUFACTURER,
                    powered_by: POWERED_BY,
                    own_function: OwnWhoFunction,
                    own_event: OwnEvent,
                    scenarios: OwnWhat,
                    control_panel: OwnWhere
                }
            });
        } else {
            ResultState = UNDEFINED;
            DebugText = `${OwnWhoFunction} command from module F420 was ignored`;
        }
    } else if (OwnWho === 1) {
        OwnWhoFunction = "Lighting";
        OwnWhoName = "Light";
        let LIGHT_STATE = LIGHT_OFF;
        let LIGHT_BRIGHTNESS = 0;
        let LIGHT_FADE = 255;
        let LIGHT_DELAY = 0;
        let LIGHT_BLINKING = false;

        if (OwnFrame[0] === "1") {
            if (OwnEvent.startsWith("*1*1000#")) {
                OwnWhat = parseInt(OwnFrame[1].replace("1000#", ""), 10);
            } else {
                OwnWhat = parseInt(OwnFrame[1], 10);
            }

            OwnWhere = OwnFrame[2];
            OwnWhereTable = GetWhereTable();

            if (OwnWhat === 1) {
                ResultState = LIGHT_ON;
                LIGHT_STATE = ResultState;
                LIGHT_BRIGHTNESS = 100;
                DebugText = `${OwnWhereTable} ${OwnWhere} is ${LIGHT_STATE}`;
            } else if (OwnWhat >= 2 && OwnWhat <= 10) {
                ResultState = OwnWhat * 10;
                LIGHT_STATE = (ResultState === 0) ? LIGHT_OFF : LIGHT_ON;
                LIGHT_BRIGHTNESS = ResultState;
                DebugText = `${OwnWhereTable} ${OwnWhere} is ${LIGHT_STATE} at ${LIGHT_BRIGHTNESS} %`;
            } else if (OwnWhat >= 11 && OwnWhat <= 18) {
                const delays = { 11: 60, 12: 120, 13: 180, 14: 240, 15: 300, 16: 900, 17: 30, 18: 0.5 };
                ResultState = delays[OwnWhat] || 0;
                if (ResultState) {
                    LIGHT_STATE = LIGHT_ON;
                    LIGHT_BRIGHTNESS = 100;
                    LIGHT_DELAY = ResultState;
                    DebugText = `${OwnWhereTable} ${OwnWhere} is on for ${LIGHT_DELAY} seconds`;
                }
            } else if (OwnWhat >= 20 && OwnWhat <= 29) {
                ResultState = LIGHT_ON;
                LIGHT_STATE = ResultState;
                LIGHT_BRIGHTNESS = 100;
                LIGHT_BLINKING = true;
                DebugText = `${OwnWhereTable} ${OwnWhere} is ${LIGHT_STATE} flashing`;
            } else if (OwnWhat === 0) {
                ResultState = LIGHT_OFF;
                LIGHT_STATE = ResultState;
                LIGHT_BRIGHTNESS = 0;
                DebugText = `${OwnWhereTable} ${OwnWhere} is ${LIGHT_STATE}`;
            } else {
                ResultState = UNDEFINED;
                DebugText = `Unknown ${OwnWhoFunction} for event ${OwnEvent}`;
            }
        } else if (OwnFrame[0] === "#1") {
            OwnWhat = OwnFrame[2];
            OwnWhere = OwnFrame[1];
            OwnWhereTable = GetWhereTable();

            if (OwnWhat === "1" || OwnWhat === "#2" || OwnWhat === "4") {
                ResultState = parseInt(OwnFrame[3], 10) - 100;
                LIGHT_STATE = (ResultState === 0) ? LIGHT_OFF : LIGHT_ON;
                LIGHT_BRIGHTNESS = ResultState;
                LIGHT_FADE = parseInt(OwnFrame[4], 10) || 255;
                DebugText = `${OwnWhereTable} ${OwnWhere} is ${LIGHT_STATE} at ${ResultState} %`;
            } else if (OwnWhat === "2") {
                ResultState = (parseInt(OwnFrame[3], 10) * 3600) + (parseInt(OwnFrame[4], 10) * 60) + parseInt(OwnFrame[5], 10);
                LIGHT_STATE = (ResultState === 0) ? LIGHT_OFF : LIGHT_ON;
                LIGHT_BRIGHTNESS = (ResultState === 0) ? 0 : 100;
                LIGHT_DELAY = ResultState;
                DebugText = `${OwnWhereTable} ${OwnWhere} is ${LIGHT_STATE} for ${LIGHT_DELAY} seconds`;
            } else if (OwnWhat === "8" || OwnWhat === "9" || OwnWhat === "#9") {
                ResultState = UNDEFINED;
                LIGHT_DELAY = parseInt(OwnFrame[3], 10);
                DebugText = `${OwnWhereTable} ${OwnWhere} worked ${LIGHT_DELAY} hours`;
            }
        }

        if (ResultState && ResultState !== UNDEFINED) {
            sendMqtt(`${OwnAPL}/${OwnBus}/${LIGHT_TOPIC}`, {
                state: LIGHT_STATE,
                brightness: (LIGHT_BRIGHTNESS === 0 && LIGHT_STATE === LIGHT_ON) ? 255 : Math.round(LIGHT_BRIGHTNESS * 2.55),
                attributes: {
                    manufacturer: MANUFACTURER,
                    powered_by: POWERED_BY,
                    own_function: OwnWhoFunction,
                    own_event: OwnEvent,
                    own_address: OwnWhere,
                    fade: LIGHT_FADE,
                    delay: LIGHT_DELAY,
                    blinking: LIGHT_BLINKING,
                    brightness: LIGHT_BRIGHTNESS
                }
            });
        }
    } else if (OwnWho === 2) {
        OwnWhoFunction = "Automation";
        OwnWhoName = "Cover";
        OwnWhere = OwnFrame[2];
        let COVER_POSITION = 255;

        if (OwnEvent === "*2*1000#0##" || OwnEvent.startsWith("*2*1000#0*")) {
            OwnWhat = 0;
            OwnWhere = (OwnEvent === "*2*1000#0##") ? "1000" : OwnWhere;
        } else if (OwnEvent === "*2*1000#1##" || OwnEvent.startsWith("*2*1000#1*")) {
            OwnWhat = 1;
            OwnWhere = (OwnEvent === "*2*1000#1##") ? "1000" : OwnWhere;
        } else if (OwnEvent === "*2*1000#2##" || OwnEvent.startsWith("*2*1000#2*")) {
            OwnWhat = 2;
            OwnWhere = (OwnEvent === "*2*1000#2##") ? "1000" : OwnWhere;
        } else if (OwnFrame.length > 5) {
            OwnWhat = parseInt(OwnFrame[2], 10);
            OwnWhere = OwnFrame[1];
            COVER_POSITION = parseInt(OwnFrame[4], 10);
        } else {
            OwnWhat = parseInt(OwnFrame[1], 10);
        }

        OwnWhereTable = GetWhereTable();

        if (OwnWhat === 0 || OwnWhat === 10 || OwnEvent.startsWith("*2*1000#10#") || OwnEvent.startsWith("*2*10#")) {
            ResultState = COVER_STOPPED;
        } else if (OwnWhat === 1 || OwnWhat === 11 || OwnWhat === 13 || OwnEvent.startsWith("*2*1000#11#") || OwnEvent.startsWith("*2*11#")) {
            ResultState = COVER_OPENING;
        } else if (OwnWhat === 2 || OwnWhat === 12 || OwnWhat === 14 || OwnEvent.startsWith("*2*1000#12#") || OwnEvent.startsWith("*2*12#")) {
            ResultState = COVER_CLOSING;
        }

        if (ResultState) {
            DebugText = `${OwnWhereTable} ${OwnWhere} is ${ResultState}` + ((COVER_POSITION !== 255) ? ` at ${COVER_POSITION} %` : "");
            sendMqtt(`${OwnAPL}/${OwnBus}/${COVER_TOPIC}`, {
                state: ResultState,
                position: COVER_POSITION,
                attributes: {
                    manufacturer: MANUFACTURER,
                    powered_by: POWERED_BY,
                    own_function: OwnWhoFunction,
                    own_event: OwnEvent,
                    own_address: OwnWhere,
                    position: COVER_POSITION
                }
            });
        } else {
            ResultState = UNDEFINED;
            DebugText = `Unknown ${OwnWhoFunction} for event ${OwnEvent}`;
        }
    } else if (OwnWho === 4) {
        OwnWhoFunction = "Climate";
        OwnWhoName = "General";

        function sendClimateMqtt(stateVal, zoneNum, funcName, zoneObj) {
            sendMqtt(`${zoneNum}/${funcName}/${CLIMATE_TOPIC}`, {
                state: stateVal,
                preset: zoneObj.fan.preset,
                percentage: zoneObj.fan.percentage,
                attributes: {
                    manufacturer: MANUFACTURER,
                    powered_by: POWERED_BY,
                    own_function: OwnWhoFunction,
                    own_event: OwnEvent,
                    own_address: OwnWhere,
                    zone: zoneNum,
                    fan: zoneObj.fan.present,
                    fan_preset: zoneObj.fan.preset,
                    fan_percentage: zoneObj.fan.percentage,
                    action: zoneObj.action,
                    mode: zoneObj.mode,
                    mode_function: zoneObj.mode_function,
                    central_unit: zoneObj.central_unit
                }
            });
        }

        if (OwnEvent.startsWith("*#4*")) {
            OwnDimension = parseInt(OwnFrame[2], 10);
            OwnWhere = OwnFrame[1].replace("#", "");
            OwnZone = parseInt(OwnWhere, 10);

            if (OwnDimension === 0) {
                OwnWhoName = "Temperature";
                OwnWhereTable = GetWhereTable();
                ResultState = (OwnFrame[3].substring(1, 3) + "." + OwnFrame[3].substring(3, 4));

                let gz = GetClimateZone(OwnZone);
                if (OwnZone > 99) {
                    OwnWhere = OwnFrame[1].substring(1);
                    OwnZone = parseInt(OwnWhere, 10);
                    OwnZoneSlave = parseInt(OwnFrame[1].substring(0, 1), 10);
                    gz = GetClimateZone(OwnZone);
                    gz.temperature.slave[`t${OwnZoneSlave}`] = parseFloat(ResultState);
                    SetClimateZone(OwnZone, gz);
                    sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                    sendClimateMqtt(parseFloat(ResultState), OwnZone, `${OwnZoneSlave}/temperature`, gz);
                    DebugText = `${OwnWhereTable} slave ${OwnZoneSlave} zone ${OwnZone} detects ${ResultState}°C`;
                } else {
                    gz.temperature.master = parseFloat(ResultState);
                    SetClimateZone(OwnZone, gz);
                    sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                    sendClimateMqtt(parseFloat(ResultState), OwnZone, "temperature", gz);
                    DebugText = `${OwnWhereTable} zone ${OwnZone} detects ${ResultState}°C`;
                }
            } else if (OwnDimension === 11 && OwnZone >= 0 && OwnZone <= 99) {
                OwnWhoName = "Fan";
                OwnWhereTable = GetWhereTable();
                let FanSpeed = parseInt(OwnFrame[3], 10);
                let speedPreset = CLIMATE_FAN_AUTO;
                let speedPct = CLIMATE_FAN_PRESET_AUTO;

                if (FanSpeed === 0) { speedPreset = CLIMATE_FAN_AUTO; speedPct = CLIMATE_FAN_PRESET_AUTO; }
                else if (FanSpeed === 1) { speedPreset = CLIMATE_FAN_LOW; speedPct = CLIMATE_FAN_PRESET_LOW; }
                else if (FanSpeed === 2) { speedPreset = CLIMATE_FAN_MEDIUM; speedPct = CLIMATE_FAN_PRESET_MEDIUM; }
                else if (FanSpeed === 3) { speedPreset = CLIMATE_FAN_HIGH; speedPct = CLIMATE_FAN_PRESET_HIGH; }
                else if (FanSpeed === 15) { speedPreset = CLIMATE_FAN_OFF; speedPct = CLIMATE_FAN_PRESET_AUTO; }

                let gz = GetClimateZone(OwnZone);
                gz.fan.present = true;
                gz.fan.preset = speedPreset;
                gz.fan.percentage = speedPct;
                SetClimateZone(OwnZone, gz);
                ResultState = speedPreset;

                sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                sendClimateMqtt(ResultState, OwnZone, "fan", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone} fan speed is set to ${ResultState}`;
            } else if (OwnDimension === 12 && OwnZone >= 0 && OwnZone <= 99) {
                OwnWhoName = "Setpoint";
                OwnWhereTable = GetWhereTable();
                ResultState = (OwnFrame[3].substring(1, 3) + "." + OwnFrame[3].substring(3, 4));

                let gz = GetClimateZone(OwnZone);
                gz.setpoint.state = parseFloat(ResultState);
                if (gz.mode === CLIMATE_MODE_HEAT) gz.setpoint.heating = parseFloat(ResultState);
                else if (gz.mode === CLIMATE_MODE_COOL) gz.setpoint.cooling = parseFloat(ResultState);
                SetClimateZone(OwnZone, gz);

                sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                sendClimateMqtt(parseFloat(ResultState), OwnZone, "setpoint", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone}, setpoint is ${ResultState}°C`;
            } else if (OwnDimension === 13 && OwnZone >= 0 && OwnZone <= 99) {
                OwnWhoName = "Knob";
                OwnWhereTable = GetWhereTable();
                const knobMap = { 0: "0", 1: "1", 11: "-1", 2: "2", 12: "-2", 3: "3", 13: "-3", 4: "OFF", 5: "Protection" };
                ResultState = knobMap[parseInt(OwnFrame[3], 10)] || UNDEFINED;

                let gz = GetClimateZone(OwnZone);
                gz.knob = ResultState;
                SetClimateZone(OwnZone, gz);

                sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                sendClimateMqtt(ResultState, OwnZone, "knob", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone} knob is set to ${ResultState}`;
            } else if (OwnDimension === 14 && OwnZone >= 0 && OwnZone <= 99) {
                OwnWhoName = "Setpoint Offset";
                OwnWhereTable = GetWhereTable();
                ResultState = (OwnFrame[3].substring(1, 3) + "." + OwnFrame[3].substring(3, 4));

                let gz = GetClimateZone(OwnZone);
                gz.setpoint.offset = parseFloat(ResultState);
                SetClimateZone(OwnZone, gz);

                sendClimateMqtt(parseFloat(ResultState), OwnZone, "setpoint/offset", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone}, setpoint is ${ResultState}°C`;
            } else if (OwnDimension === 15 && OwnZone >= 0 && OwnZone <= 99) {
                OwnWhoName = "External Sensor";
                OwnWhere = OwnFrame[1].replace("00", "");
                OwnZone = parseInt(OwnWhere, 10);
                OwnWhereTable = GetWhereTable();
                ResultState = (OwnFrame[4].substring(1, 3) + "." + OwnFrame[4].substring(3, 4));

                let gz = GetClimateZone(OwnZone);
                sendClimateMqtt(parseFloat(ResultState), OwnZone, "temperature/external", gz);
                DebugText = `${OwnWhereTable} external zone ${OwnZone} detects ${ResultState}°C`;
            } else if (OwnDimension === 19 && OwnZone >= 0 && OwnZone <= 99) {
                OwnWhoName = "Valves";
                OwnWhereTable = GetWhereTable();
                let CoolingValve = GetValveState(OwnFrame[3]);
                let HeatingValve = GetValveState(OwnFrame[4]);
                ResultState = (CoolingValve === CLIMATE_VALVE_OFF && HeatingValve === CLIMATE_VALVE_OFF) ? CLIMATE_VALVE_OFF : CLIMATE_VALVE_ON;

                let gz = GetClimateZone(OwnZone);
                gz.valve.state = ResultState;
                gz.valve.heating = HeatingValve;
                gz.valve.cooling = CoolingValve;

                if (HeatingValve.toLowerCase() === "on") gz.action = "heating";
                else if (CoolingValve.toLowerCase() === "on") gz.action = "cooling";
                else if (gz.mode.toLowerCase() !== "off") gz.action = "idle";
                else gz.action = "off";

                SetClimateZone(OwnZone, gz);
                sendClimateMqtt(gz.action, OwnZone, "action", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone} action change to ${gz.action}`;
            } else if (OwnDimension === 20) {
                OwnWhere = OwnFrame[1].split("#")[0];
                OwnZone = parseInt(OwnWhere, 10);
                OwnWhoName = "Actuators";
                OwnWhereTable = GetWhereTable();
                ResultState = GetActuatorState(OwnFrame[3]);

                if (OwnFrame[1] === "0#0") {
                    let totalZones = CLIMATE_ZONES_COUNT;
                    for (let z = 1; z <= totalZones; z++) {
                        let gz = GetClimateZone(z);
                        gz.actuator.state = ResultState;
                        for (let a = 1; a <= 9; a++) gz.actuator[`a${a}`] = ResultState;
                        SetClimateZone(z, gz);
                        sendClimateMqtt(GetActionZone(z), z, "action", gz);
                    }
                    DebugText = `${OwnWhereTable} global actuators is set to ${ResultState}`;
                } else if (OwnFrame[1].endsWith("#0")) {
                    let gz = GetClimateZone(OwnZone);
                    gz.actuator.state = ResultState;
                    for (let a = 1; a <= 9; a++) gz.actuator[`a${a}`] = ResultState;
                    SetClimateZone(OwnZone, gz);
                    sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                    DebugText = `${OwnWhereTable} zone ${OwnZone}, all actuators is set to ${ResultState}`;
                } else {
                    OwnActuator = parseInt(OwnFrame[1].split("#")[1], 10);
                    let gz = GetClimateZone(OwnZone);
                    gz.actuator.state = ResultState;
                    gz.actuator[`a${OwnActuator}`] = ResultState;
                    SetClimateZone(OwnZone, gz);
                    sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                    DebugText = `${OwnWhereTable} zone ${OwnZone}, actuator ${OwnActuator} is set to ${ResultState}`;
                }
            } else if (OwnDimension === 22) {
                OwnFrame[1] = OwnFrame[1].replace("3#", "");
                OwnWhere = OwnFrame[1].split("#")[0];
                OwnZone = parseInt(OwnWhere, 10);
                OwnActuator = parseInt(OwnFrame[1].split("#")[1], 10);
                OwnWhoName = "Split Control";

                let Mode = parseInt(OwnFrame[3], 10);
                let Setpoint = parseInt(OwnFrame[4], 10);
                let Speed = parseInt(OwnFrame[5], 10);
                let Swing = parseInt(OwnFrame[6], 10);

                let gz = GetClimateZone(OwnZone);
                if (Mode >= 0 && Mode <= 5) {
                    sendClimateMqtt(CLIMATE_SPLIT_MODE[Mode], OwnZone, `${OwnActuator}/split/mode`, gz);
                }
                if (!isNaN(Setpoint)) {
                    sendClimateMqtt(Setpoint, OwnZone, `${OwnActuator}/split/setpoint`, gz);
                }
                if (Speed >= 0 && Speed <= 4) {
                    sendClimateMqtt(CLIMATE_SPLIT_SPEED[Speed], OwnZone, `${OwnActuator}/split/speed`, gz);
                }
                if (!isNaN(Swing)) {
                    sendClimateMqtt(Swing === 0 ? "OFF" : "ON", OwnZone, `${OwnActuator}/split/swing`, gz);
                }
                sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                ResultState = OwnWhoName;
                DebugText = `${OwnWhoFunction} ${OwnWhoName} event ${OwnEvent}`;
            }
        } else if (OwnEvent.startsWith("*4*")) {
            OwnWhat = parseInt(OwnFrame[1], 10);
            OwnWhere = (OwnEvent.endsWith("#0##")) ? 0 : OwnFrame[2].replace("#", "");
            OwnZone = parseInt(OwnWhere, 10);

            let gz = GetClimateZone(OwnZone);

            if (OwnWhat === 0 || OwnWhat === 210 || OwnWhat === 211 || OwnWhat === 215 || (OwnWhat >= 2101 && OwnWhat <= 2103) || (OwnWhat >= 2201 && OwnWhat <= 2216) || (OwnWhat >= 23000 && OwnWhat <= 23999)) {
                let ModeFunction = (OwnWhat === 0) ? "cooling" : (OwnWhat === 210 ? "cooling manual" : ((OwnWhat === 215 || (OwnWhat >= 2201 && OwnWhat <= 2216)) ? "cooling scenario" : "cooling program"));
                OwnWhoName = "Conditioning Mode";
                OwnWhereTable = GetWhereTable();
                ResultState = CLIMATE_MODE_COOL;
                gz.mode = ResultState;
                gz.mode_function = ModeFunction;
                SetClimateZone(OwnZone, gz);
                sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                sendClimateMqtt(ResultState, OwnZone, "mode", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone} is set to ${ResultState}`;
            } else if (OwnWhat === 1 || OwnWhat === 110 || OwnWhat === 111 || OwnWhat === 115 || (OwnWhat >= 1101 && OwnWhat <= 1103) || (OwnWhat >= 1201 && OwnWhat <= 1216) || (OwnWhat >= 13000 && OwnWhat <= 13999)) {
                let ModeFunction = (OwnWhat === 1) ? "heating" : (OwnWhat === 110 ? "heating manual" : ((OwnWhat === 115 || (OwnWhat >= 1201 && OwnWhat <= 1216)) ? "heating scenario" : "heating program"));
                OwnWhoName = "Heating Mode";
                OwnWhereTable = GetWhereTable();
                ResultState = CLIMATE_MODE_HEAT;
                gz.mode = ResultState;
                gz.mode_function = ModeFunction;
                SetClimateZone(OwnZone, gz);
                sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                sendClimateMqtt(ResultState, OwnZone, "mode", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone} is set to ${ResultState}`;
            } else if (OwnWhat === 102 || OwnWhat === 103 || OwnWhat === 202 || OwnWhat === 203 || OwnWhat === 302 || OwnWhat === 303) {
                let ModeFunction = UNKNOWN;
                if (OwnWhat === 102) ModeFunction = "heating off protection";
                else if (OwnWhat === 103) ModeFunction = "heating off";
                else if (OwnWhat === 202) ModeFunction = "cooling off protection";
                else if (OwnWhat === 203) ModeFunction = "cooling off";
                else if (OwnWhat === 302) ModeFunction = (gz.mode_function.includes("heat")) ? "heating off protection" : ((gz.mode_function.includes("cool")) ? "cooling off protection" : "generic off protection");
                else if (OwnWhat === 303) ModeFunction = (gz.mode_function.includes("heat")) ? "heating off" : ((gz.mode_function.includes("cool")) ? "cooling off" : "generic off");

                OwnWhoName = "Off Mode";
                OwnWhereTable = GetWhereTable();
                ResultState = CLIMATE_MODE_OFF;
                gz.mode = ResultState;
                gz.mode_function = ModeFunction;
                SetClimateZone(OwnZone, gz);
                sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                sendClimateMqtt(ResultState, OwnZone, "mode", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone} is set to ${ResultState}`;
            } else if (OwnWhat === 311 || OwnWhat === 315 || (OwnWhat >= 3101 && OwnWhat <= 3103) || (OwnWhat >= 33000 && OwnWhat <= 33999)) {
                let ModeFunction = (OwnWhat === 311) ? "generic" : ((OwnWhat >= 3101 && OwnWhat <= 3103) ? "program" : "scenario");
                OwnWhoName = "Auto Mode";
                OwnWhereTable = GetWhereTable();
                ResultState = CLIMATE_MODE_AUTO;
                gz.mode = ResultState;
                gz.mode_function = ModeFunction;
                SetClimateZone(OwnZone, gz);
                sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                sendClimateMqtt(ResultState, OwnZone, "mode", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone} is set to ${ResultState}`;
            } else if (OwnWhat === 20 || OwnWhat === 21) {
                OwnWhoName = "Remote Control";
                OwnWhereTable = GetWhereTable();
                ResultState = (OwnWhat === 20) ? "OFF" : "ON";
                gz.remote_control = ResultState;
                SetClimateZone(OwnZone, gz);
                sendClimateMqtt(GetActionZone(OwnZone), OwnZone, "action", gz);
                sendClimateMqtt(ResultState, OwnZone, "remotecontrol", gz);
                DebugText = `${OwnWhereTable} zone ${OwnZone} is ${ResultState}`;
            } else if ((OwnWhat >= 22 && OwnWhat <= 24) || OwnWhat === 30 || OwnWhat === 31) {
                OwnWhoName = "Central Unit";
                OwnWhereTable = GetWhereTable();
                const cuMap = { 22: "At least one probe OFF", 23: "At least one probe in protection", 24: "At least one probe in manual", 30: "Failure discovered", 31: "Battery KO" };
                ResultState = cuMap[OwnWhat] || "KO";
                let g0 = GetClimateZone(0);
                g0.central_unit = ResultState;
                SetClimateZone(0, g0);
                sendClimateMqtt(ResultState, 0, "centralunit", g0);
                DebugText = `${OwnWhereTable}`;
            }
        }
    } else if (OwnWho === 9) {
        OwnWhoFunction = "Aux Contact";
        OwnWhoName = "Aux";
        OwnWhat = (OwnFrame[1] === "0") ? 0 : 1;
        OwnWhere = OwnFrame[2];
        OwnWhereTable = GetWhereTable();
        ResultState = (OwnWhat === 1) ? AUX_ON : AUX_OFF;
        DebugText = `${OwnWhereTable} address ${OwnWhere} is ` + (OwnWhat === 1 ? "closed" : "open");

        sendMqtt(`${OwnAPL}/${AUX_TOPIC}`, {
            state: ResultState,
            attributes: {
                manufacturer: MANUFACTURER,
                powered_by: POWERED_BY,
                own_function: OwnWhoFunction,
                own_event: OwnEvent,
                contact_state: (OwnWhat === 1) ? AUX_CLOSED : AUX_OPEN
            }
        });
    } else if (OwnWho === 13) {
        OwnWhoFunction = "Gateway";
        OwnWhoName = "Gateway";
        OwnWhat = parseInt(OwnFrame[2], 10);
        OwnWhereTable = GetWhereTable();

        let infoText = "";
        if (OwnWhat === 0 || OwnFrame[2] === "#0") {
            infoText = OwnFrame[3] + ":" + OwnFrame[4] + ":" + OwnFrame[5] + " " + GetGMT(OwnFrame[6]);
        } else if (OwnWhat === 1 || OwnFrame[2] === "#1") {
            infoText = GetDayOfWeek(OwnFrame[3]) + ", " + OwnFrame[4] + " " + GetMonth(OwnFrame[5]) + " " + OwnFrame[6];
        } else if (OwnWhat === 10 || OwnWhat === 50) {
            infoText = OwnFrame[3] + "." + OwnFrame[4] + "." + OwnFrame[5] + "." + OwnFrame[6];
        } else if (OwnWhat === 11) {
            infoText = OwnFrame[3] + "." + OwnFrame[4] + "." + OwnFrame[5] + "." + OwnFrame[6];
        } else if (OwnWhat === 12) {
            let macParts = [];
            for (let i = 3; i < 9; i++) {
                let m = parseInt(OwnFrame[i], 10).toString(16);
                macParts.push((m.length === 1 ? "0" : "") + m);
            }
            infoText = macParts.join(":");
        } else if (OwnWhat === 15) {
            infoText = GetGatewayModel(OwnFrame[3]);
        } else if (OwnWhat === 16) {
            infoText = "ver. " + OwnFrame[3] + " rel. " + OwnFrame[4] + " build " + OwnFrame[5];
        } else if (OwnWhat === 19) {
            infoText = OwnFrame[3] + ":" + OwnFrame[4] + ":" + OwnFrame[5] + ":" + OwnFrame[6];
        } else if (OwnWhat === 22 || OwnFrame[2] === "#22") {
            infoText = OwnFrame[8] + "/" + OwnFrame[9] + "/" + OwnFrame[10] + " " + OwnFrame[3] + ":" + OwnFrame[4] + ":" + OwnFrame[5] + " " + GetGMT(OwnFrame[6]);
        } else if (OwnWhat === 23) {
            infoText = "ver. " + OwnFrame[3] + " rel. " + OwnFrame[4] + " build " + OwnFrame[5];
        } else if (OwnWhat === 24) {
            infoText = "ver. " + OwnFrame[3] + " rel. " + OwnFrame[4] + " build " + OwnFrame[5];
        } else if (OwnWhat === 51 || OwnWhat === 52) {
            infoText = OwnFrame[3] + "." + OwnFrame[4] + "." + OwnFrame[5] + "." + OwnFrame[6];
        }

        if (infoText) {
            ResultState = infoText;
            DebugText = `${OwnWhoFunction} is ${ResultState}`;
            sendMqtt(GATEWAY_TOPIC, {
                state: GATEWAY_ON,
                attributes: {
                    manufacturer: MANUFACTURER,
                    powered_by: POWERED_BY,
                    own_function: OwnWhoFunction,
                    own_event: OwnEvent,
                    info: ResultState
                }
            });
        }
    } else if (OwnWho === 14) {
        OwnWhoFunction = "Light Special";
        OwnWhoName = "Light";
        OwnWhat = (OwnFrame[1] === "0") ? 0 : 1;
        OwnWhere = OwnFrame[2];
        OwnWhereTable = GetWhereTable();
        ResultState = (OwnWhat === 1) ? DISABLE_OFF : DISABLE_ON;
        DebugText = `${OwnWhereTable} ${OwnWhere} disable mode is ${ResultState}`;

        sendMqtt(`${OwnAPL}/${OwnBus}/${DISABLE_TOPIC}`, {
            state: ResultState,
            attributes: {
                manufacturer: MANUFACTURER,
                powered_by: POWERED_BY,
                own_function: OwnWhoFunction,
                own_event: OwnEvent
            }
        });
    } else if (OwnWho === 15) {
        OwnWhoFunction = "CEN";
        OwnWhoName = "Button";
        let BUTTON_NUMBER = parseInt(OwnFrame[1], 10);
        let BUTTON_PARAMETER = (OwnFrame[1].indexOf("#") === -1) ? 0 : parseInt(OwnFrame[1].slice(-1), 10);
        OwnWhere = OwnFrame[2].replace("#3", "");
        OwnWhereTable = GetWhereTable();

        function sendCenMqtt(st, tr) {
            sendMqtt(`${OwnAPL}/${BUTTON_NUMBER}/${OwnBus}/${BUTTON_TOPIC}`, {
                state: st,
                trigger: tr,
                attributes: {
                    manufacturer: MANUFACTURER,
                    powered_by: POWERED_BY,
                    own_function: OwnWhoFunction,
                    own_event: OwnEvent,
                    button_number: BUTTON_NUMBER,
                    trigger: tr
                }
            });
        }

        if (BUTTON_PARAMETER === 0) {
            ResultState = BUTTON_PRESSED;
            DebugText = `${OwnWhereTable} ${BUTTON_NUMBER} address ${OwnWhere} has been pressed`;
            sendCenMqtt(BUTTON_ON, BUTTON_PRESSED);
            sendCenMqtt(BUTTON_OFF, BUTTON_RELEASED);
        } else if (BUTTON_PARAMETER === 1 || BUTTON_PARAMETER === 2) {
            ResultState = BUTTON_RELEASED;
            DebugText = `${OwnWhereTable} ${BUTTON_NUMBER} address ${OwnWhere} it was released`;
            sendCenMqtt(BUTTON_OFF, BUTTON_RELEASED);
        } else if (BUTTON_PARAMETER === 3) {
            ResultState = BUTTON_HOLD;
            DebugText = `${OwnWhereTable} ${BUTTON_NUMBER} address ${OwnWhere} is held down`;
            sendCenMqtt(BUTTON_ON, BUTTON_HOLD);
        }
    } else if (OwnWho === 17) {
        OwnWhoFunction = "Scene Programmer";
        OwnWhoName = "Scene";
        OwnWhat = parseInt(OwnFrame[1], 10);
        OwnWhere = OwnFrame[2];
        OwnWhereTable = GetWhereTable();

        const sceneMap = { 1: "STARTED", 2: "STOPPED", 3: "ENABLED", 4: "DISABLED" };
        ResultState = sceneMap[OwnWhat] || UNDEFINED;

        if (ResultState !== UNDEFINED) {
            let st = (OwnWhat === 1) ? "ON" : "OFF";
            DebugText = `${OwnWhereTable} number ${OwnWhere} is ${ResultState}`;
            sendMqtt(`${OwnAPL}/${OwnBus}/${SCENE_TOPIC}`, {
                state: st,
                attributes: {
                    manufacturer: MANUFACTURER,
                    powered_by: POWERED_BY,
                    own_function: OwnWhoFunction,
                    own_event: OwnEvent,
                    started: (OwnWhat === 1),
                    stopped: (OwnWhat === 2),
                    enabled: (OwnWhat === 3),
                    disabled: (OwnWhat === 4)
                }
            });
        }
    } else if (OwnWho === 25) {
        if (OwnEvent.startsWith("*25*31#") || OwnEvent.startsWith("*25*32#")) {
            OwnWhoFunction = "Dry Contact";
            OwnWhoName = "Contact";
            let is31 = OwnEvent.startsWith("*25*31#");
            let CONTACT_NUMBER = parseInt(OwnFrame[2].substring(1), 10);
            OwnWhere = OwnFrame[2];
            OwnWhereTable = GetWhereTable();
            let CONTACT_IS_REVERSED = CONTACTS_NUMBER_REVERSED.includes(CONTACT_NUMBER.toString());

            let isClosed = is31 ? !CONTACT_IS_REVERSED : CONTACT_IS_REVERSED;
            ResultState = isClosed ? CONTACT_ON : CONTACT_OFF;
            let contactState = isClosed ? CONTACT_CLOSED : CONTACT_OPEN;
            DebugText = `${OwnWhereTable} address ${OwnWhere} is ` + (isClosed ? "closed" : "open") + (CONTACT_IS_REVERSED ? " (REVERSED)" : "");

            sendMqtt(`${CONTACT_NUMBER}/${CONTACT_TOPIC}`, {
                state: ResultState,
                attributes: {
                    manufacturer: MANUFACTURER,
                    powered_by: POWERED_BY,
                    own_function: OwnWhoFunction,
                    own_event: OwnEvent,
                    contact_number: CONTACT_NUMBER,
                    contact_state: contactState,
                    contact_reversed: CONTACT_IS_REVERSED
                }
            });
        } else if (OwnEvent.startsWith("*25*21#") || OwnEvent.startsWith("*25*22#") || OwnEvent.startsWith("*25*23#") || OwnEvent.startsWith("*25*24#")) {
            OwnWhoFunction = "CEN+";
            OwnWhoName = "Button";
            let BUTTON_NUMBER = parseInt(OwnFrame[1].substring(3), 10);
            OwnWhere = OwnFrame[2].substring(1);
            OwnWhereTable = GetWhereTable();

            function sendCenPlusMqtt(st, tr) {
                sendMqtt(`${OwnAPL}/${BUTTON_NUMBER}/${BUTTON_PLUS_TOPIC}`, {
                    state: st,
                    trigger: tr,
                    attributes: {
                        manufacturer: MANUFACTURER,
                        powered_by: POWERED_BY,
                        own_function: OwnWhoFunction,
                        own_event: OwnEvent,
                        button_number: BUTTON_NUMBER,
                        trigger: tr
                    }
                });
            }

            if (OwnEvent.startsWith("*25*21#")) {
                ResultState = BUTTON_PRESSED;
                DebugText = `${OwnWhereTable} ${BUTTON_NUMBER} address ${OwnWhere} has been pressed`;
                sendCenPlusMqtt(BUTTON_ON, BUTTON_PRESSED);
                sendCenPlusMqtt(BUTTON_OFF, BUTTON_RELEASED);
            } else if (OwnEvent.startsWith("*25*22#")) {
                ResultState = BUTTON_PRESSED;
                DebugText = `${OwnWhereTable} ${BUTTON_NUMBER} address ${OwnWhere} has been pressed`;
                sendCenPlusMqtt(BUTTON_ON, BUTTON_PRESSED);
            } else if (OwnEvent.startsWith("*25*23#")) {
                ResultState = BUTTON_HOLD;
                DebugText = `${OwnWhereTable} ${BUTTON_NUMBER} address ${OwnWhere} is held down`;
                sendCenPlusMqtt(BUTTON_ON, BUTTON_HOLD);
            } else if (OwnEvent.startsWith("*25*24#")) {
                ResultState = BUTTON_RELEASED;
                DebugText = `${OwnWhereTable} ${BUTTON_NUMBER} address ${OwnWhere} it was released after hold pressure`;
                sendCenPlusMqtt(BUTTON_OFF, BUTTON_RELEASED);
            }
        } else if (OwnEvent.startsWith("*25*25#") || OwnEvent.startsWith("*25*26#") || OwnEvent.startsWith("*25*27#") || OwnEvent.startsWith("*25*28#")) {
            OwnWhoFunction = "Rotary Selector";
            OwnWhoName = "Selector";
            let BUTTON_NUMBER = parseInt(OwnFrame[1].substring(3), 10);
            OwnWhere = OwnFrame[2].substring(1);
            OwnWhereTable = GetWhereTable();

            const rotMap = {
                "25#": { state: BUTTON_SLOW_RIGHT, text: "slowly turned clockwise" },
                "26#": { state: BUTTON_QUICK_RIGHT, text: "quickly turned clockwise" },
                "27#": { state: BUTTON_SLOW_LEFT, text: "slowly turned counter-clockwise" },
                "28#": { state: BUTTON_QUICK_LEFT, text: "quickly turned counter-clockwise" }
            };
            let rotKey = OwnFrame[1].substring(0, 3);
            let rot = rotMap[rotKey] || { state: BUTTON_PRESSED, text: "turned" };
            ResultState = rot.state;
            DebugText = `${OwnWhereTable} ${BUTTON_NUMBER} address ${OwnWhere} has ${rot.text}`;

            sendMqtt(`${OwnAPL}/${BUTTON_NUMBER}/${BUTTON_TOPIC}`, {
                state: BUTTON_ON,
                trigger: ResultState,
                attributes: {
                    manufacturer: MANUFACTURER,
                    powered_by: POWERED_BY,
                    own_function: OwnWhoFunction,
                    own_event: OwnEvent,
                    button_number: BUTTON_NUMBER,
                    trigger: ResultState
                }
            });
        }
    } else {
        ResultState = UNDEFINED;
        if (OwnEvent === ACK) DebugText = "ACK";
        else if (OwnEvent === NACK) DebugText = "NACK";
        else DebugText = `Event ${OwnEvent} ignored or unhandled`;
    }

    let status;
    if (OwnWho && ResultState != null && ResultState !== UNDEFINED) {
        status = { fill: "green", shape: "dot", text: DebugText || "Processed" };
    } else if (OwnWho && ResultState != null && ResultState === UNDEFINED) {
        status = { fill: "red", shape: "ring", text: DebugText || "No result" };
    } else if (OwnWho && ResultState == null) {
        status = { fill: "red", shape: "ring", text: `Unknown event ${OwnEvent} for Who ${OwnWho}` };
    } else {
        status = { fill: "yellow", shape: "ring", text: DebugText || `Event ${OwnEvent}` };
    }

    return {
        mqttMessages,
        rawFrame: OwnEvent,
        status,
        who: OwnWho,
        resultState: ResultState,
        debugText: DebugText
    };
}

////////////////////////////////////////////////////////////////////////
// OWN WRITE (MQTT COMMAND -> SCS BUS FRAMES) - 2025 REFINED ENGINE
////////////////////////////////////////////////////////////////////////

function splitTemperature(temp) {
    if (temp == null) return null;
    const num = Number(temp);
    if (isNaN(num)) return null;
    const intPart = Math.trunc(num);
    const decPart = Math.abs(num - intPart).toFixed(2).slice(2);
    return { intPart, decPart };
}

function getTemperature(temp) {
    const parts = splitTemperature(temp);
    if (!parts) return "0";
    let { intPart, decPart } = parts;
    let value = Number(`${intPart}.${decPart}`);
    if (value < 5) value = 5;
    if (value > 40) value = 40;
    intPart = Math.floor(value);
    decPart = Math.round((value - intPart) * 100).toString().padStart(2, "0");
    const intStr = intPart.toString().padStart(2, "0");
    return `${intStr}${decPart}`;
}

/**
 * Parses WHERE, BUS, and optional WHAT from an MQTT command topic
 * Supports:
 * - <WHERE>/<BUS>/.../set  (e.g. 21/00/light/myhome/set)
 * - <WHERE>/<BUS>/<WHAT>/.../set (e.g. 21/00/12/light/myhome/set for timed lights)
 * - <WHERE>/.../set (e.g. 21/light/myhome/set, bus defaults to "00")
 */
function getWhatWhere(topicString) {
    if (typeof topicString !== "string") return null;
    const tokens = topicString.split("/");
    if (tokens.length < 2) return null;

    let whereRaw = tokens[0];
    if (whereRaw == null || whereRaw === "") return null;

    let bus = "00";
    let what = null;

    if (tokens.length >= 5) {
        // e.g. WHERE / BUS / WHAT / light / myhome / set
        bus = tokens[1] || "00";
        what = parseInt(tokens[2], 10) || null;
    } else if (tokens.length === 4) {
        // e.g. WHERE / BUS / light / myhome / set  or  WHERE / WHAT / light / set
        if (/^\d{2}$/.test(tokens[1])) {
            bus = tokens[1];
        } else {
            what = parseInt(tokens[1], 10) || null;
        }
    }

    const where = (bus !== "00") ? `${whereRaw}#4#${bus}` : whereRaw;
    return { what, where };
}

function getBrightness(payload) {
    let _payload = payload;
    if (_payload == null) return 0;
    if (typeof _payload === "boolean") return _payload ? 255 : 0;
    if (typeof _payload === "string") {
        const str = _payload.trim().toLowerCase();
        if (str === "on" || str === "true") return 255;
        if (str === "off" || str === "false" || str === "") return 0;
        _payload = Number(str);
    }
    if (typeof _payload !== "number" || !Number.isFinite(_payload) || isNaN(_payload)) return 0;
    return Math.min(Math.max(_payload, 0), 255);
}

/**
 * Compiles an incoming MQTT command topic + payload into OpenWebNet command frame(s)
 */
function buildOwnCommands(topic, payload, options = {}, state = null) {
    if (!state) state = new StateManager();

    // Check if direct raw OWN frame was passed
    if (typeof payload === 'string' && payload.startsWith("*") && payload.endsWith("##")) {
        return [payload.trim()];
    }
    if (Array.isArray(payload) && payload.length > 0 && typeof payload[0] === 'string' && payload[0].startsWith("*")) {
        return payload.map(p => p.trim());
    }

    if (!topic || typeof topic !== 'string') return [];

    const topicString = topic.trim();
    let commandString = (typeof payload === 'string') ? payload.trim().toLowerCase() : String(payload).trim().toLowerCase();
    let commandNumber = (typeof payload === 'number' && Number.isFinite(payload)) ? payload : (Number(payload) || null);

    const isSync = topicString.endsWith("myhome/sync") || topicString.endsWith("sync/myhome/set");
    const isLight = topicString.endsWith("light/myhome/set");
    const isBrightness = topicString.endsWith("brightness/myhome/set");
    const isCover = topicString.endsWith("cover/myhome/set");
    const isScene = topicString.endsWith("scene/myhome/set");
    const isScenarios = topicString.endsWith("scenarios/myhome/set");
    const isClimate = topicString.endsWith("climate/myhome/set");

    if (!isSync && payload === null) return [];

    function getGlobalClimateMode(zone = 0) {
        const mode = state.get(`myhome.climate.zones.${zone}.mode`) ?? "off";
        const func = (state.get(`myhome.climate.zones.${zone}.mode_function`) ?? "off").toLowerCase();
        if (mode !== "off") return mode;
        const mapping = [
            { pattern: /heat(?:ing)?/, result: "heat" },
            { pattern: /cool(?:ing)?/, result: "cool" },
            { pattern: /auto|generic/, result: "auto" }
        ];
        for (const { pattern, result } of mapping) {
            if (pattern.test(func)) return result;
        }
        return "off";
    }

    // Sync command
    if (isSync) {
        let parts = getWhatWhere(topicString);
        let commands = [];
        if (parts && parts.what != null) {
            commands.push(`*#${parts.what}*${parts.where}##`);
        }
        let syncReqs = buildSyncRequests(options.contacts_number, options.climate_zones, state);
        commands.push(...syncReqs);
        return commands;
    }

    // Light command
    if (isLight) {
        let parts = getWhatWhere(topicString);
        if (!parts) return [];
        let what = parts.what;
        let isOn = (commandString === 'on' || commandString === 'true' || commandNumber === 1 || getBrightness(payload) > 0);
        if (isOn) {
            what = (what != null && ((what >= 11 && what <= 18) || (what >= 20 && what <= 29))) ? what : 1;
        } else {
            what = 0;
        }
        return [`*1*${what}*${parts.where}##`];
    }

    // Brightness command
    if (isBrightness) {
        let parts = getWhatWhere(topicString);
        if (!parts) return [];
        let bri = getBrightness(payload);
        let level100 = Math.round((bri / 2.55) + 100);
        level100 = Math.min(Math.max(level100, 100), 200);
        return (level100 <= 100) ? [`*1*0*${parts.where}##`] : [`*#1*${parts.where}*#1*${level100}*0##`];
    }

    // Cover command
    if (isCover) {
        let parts = getWhatWhere(topicString);
        if (!parts) return [];
        const cmdMap = { "stop": 0, "open": 1, "close": 2 };
        let cmd = cmdMap[commandString] ?? 0;
        return [`*2*${cmd}*${parts.where}##`];
    }

    // Scene command
    if (isScene) {
        let parts = getWhatWhere(topicString);
        if (!parts) return [];
        const cmdMap = { "on": 1, "1": 1, "off": 2, "2": 2, "enabled": 3, "3": 3, "disabled": 4, "4": 4 };
        let cmd = cmdMap[commandString] ?? 2;
        return [`*17*${cmd}*${parts.where}##`];
    }

    // Scenarios command
    if (isScenarios) {
        let parts = getWhatWhere(topicString);
        if (!parts) return [];
        let cmd = (commandNumber >= 1 && commandNumber <= 20) ? commandNumber : null;
        if (cmd === null) return [];
        return [`*0*${cmd}*${parts.where}##`];
    }

    // Climate command
    if (isClimate) {
        let temperature = getTemperature(commandString) || null;
        let climateOff = parseInt(options.climate_off_mode || '0', 10) || 0;
        let zoneRaw = topicString.split("/")[0] || null;
        if (zoneRaw == null) return [];
        let zone = parseInt(zoneRaw, 10);
        let commands = [];
        let globalClimateMode = getGlobalClimateMode(0) ?? "off";
        let isCentralUnit = (state.get(`myhome.climate.zones.0`) != null) || (zone === 0);

        const isClimateSPD = topicString.endsWith("setpoint/delta/climate/myhome/set");
        const isClimateSP = topicString.endsWith("setpoint/climate/myhome/set");
        const isClimateMode = topicString.endsWith("mode/climate/myhome/set");
        const isClimateFan = topicString.endsWith("fan/climate/myhome/set");

        if (isClimateSPD) {
            let setpointDelta = parseInt(commandNumber, 10) || 0;
            if (setpointDelta === 0) return [];

            let zonesList = isCentralUnit ? [0] : (options.climate_zones || '').split(",").map(z => parseInt(z.trim(), 10)).filter(z => !isNaN(z));
            for (let z of zonesList) {
                if (z < 0 || z > 99) continue;
                let cMode = getGlobalClimateMode(z) ?? "off";
                let setpointTarget = state.get(`myhome.climate.zones.${z}.setpoint.state`) || 20;
                if (typeof setpointTarget === 'number') {
                    setpointTarget += setpointDelta;
                    let tempFormatted = getTemperature(setpointTarget);
                    if (cMode === "off") {
                        commands.push(`*#4*${z}##`);
                    } else if (cMode === "heat") {
                        commands.push(`*#4*${z}*#7*1*1*${tempFormatted}##`);
                    } else if (cMode === "cool") {
                        commands.push(`*#4*${z}*#7*2*1*${tempFormatted}##`);
                    } else if (cMode === "auto" || cMode === "generic") {
                        commands.push(`*#4*${z}*#7*3*1*${tempFormatted}##`);
                    }
                }
            }
            return commands;
        } else if (isClimateSP && temperature) {
            let cMode = getGlobalClimateMode(zone) ?? "off";
            if (cMode === "heat") {
                commands.push(`*#4*${zone}*#7*1*1*${temperature}##`);
            } else if (cMode === "cool") {
                commands.push(`*#4*${zone}*#7*2*1*${temperature}##`);
            } else if (cMode === "auto" || cMode === "generic") {
                commands.push(`*#4*${zone}*#7*3*1*${temperature}##`);
            }
            commands.push(`*#4*${zone}##`);
            return commands;
        } else if (isClimateMode) {
            let cMode = (commandString === "on") ? getGlobalClimateMode(zone) : commandString;
            let gMode = isCentralUnit ? globalClimateMode : cMode;

            if (isCentralUnit) {
                if (cMode === "off") {
                    return [climateOff === 0 ? `*4*303*#0##` : `*4*302*#0##`];
                } else if (cMode === "heat") {
                    return [`*4*1*#0##`];
                } else if (cMode === "cool") {
                    return [`*4*0*#0##`];
                } else if (cMode === "auto" || cMode === "generic") {
                    return [`*#4*#0*#14*${temperature || "2100"}*3##`];
                }
            } else if (cMode === "off") {
                commands.push(climateOff === 0 ? `*4*303*${zone}##` : `*4*302*${zone}##`);
            } else if (cMode === "heat" && gMode === cMode && gMode !== "off") {
                let t = state.get(`myhome.climate.zones.${zone}.setpoint.heating`) || state.get(`myhome.climate.zones.${zone}.setpoint.state`) || 20;
                commands.push(`*#4*${zone}*#7*1*1*${getTemperature(t)}##`);
            } else if (cMode === "cool" && gMode === cMode && gMode !== "off") {
                let t = state.get(`myhome.climate.zones.${zone}.setpoint.cooling`) || state.get(`myhome.climate.zones.${zone}.setpoint.state`) || 22;
                commands.push(`*#4*${zone}*#7*2*1*${getTemperature(t)}##`);
            } else if (cMode === "auto" || cMode === "generic") {
                let t = state.get(`myhome.climate.zones.${zone}.setpoint.offset`) || state.get(`myhome.climate.zones.${zone}.setpoint.state`) || 23;
                commands.push(`*#4*${zone}*#7*3*1*${getTemperature(t)}##`);
            }
            commands.push(`*#4*${zone}##`);
            return commands;
        } else if (isClimateFan) {
            if (commandString === "low" || commandNumber === 1 || (commandNumber >= 4 && commandNumber <= 33)) {
                commands.push(`*#4*${zone}*#11*1##`);
            } else if (commandString === "medium" || commandNumber === 2 || (commandNumber >= 34 && commandNumber <= 66)) {
                commands.push(`*#4*${zone}*#11*2##`);
            } else if (commandString === "high" || commandNumber === 3 || commandNumber >= 67) {
                commands.push(`*#4*${zone}*#11*3##`);
            } else {
                commands.push(`*#4*${zone}*#11*0##`);
            }
            commands.push(`*#4*${zone}*11##`);
            return commands;
        }
    }

    return [];
}

/**
 * Builds status sync request commands for configured contacts and climate zones
 */
function buildSyncRequests(contactsRaw, zonesRaw, state = null) {
    let commands = [];

    if (contactsRaw) {
        const contacts = contactsRaw.toString().trim().split(",")
            .map(num => parseInt(num.trim(), 10))
            .filter(num => Number.isInteger(num) && num >= 1 && num <= 201);
        for (let num of contacts) {
            commands.push(`*#25*3${num}##`);
        }
    }

    if (zonesRaw) {
        const zones = zonesRaw.toString().trim().split(",")
            .map(num => parseInt(num.trim(), 10))
            .filter(num => Number.isInteger(num) && num >= 0 && num <= 99);

        for (let zone of zones) {
            if (zone === 0) {
                commands.push(`*#4*#0##`);
            } else {
                commands.push(`*#4*${zone}##`);
                commands.push(`*#4*${zone}*0##`);
                if (state) {
                    let fanZone = state.get(`myhome.climate.zones.${zone}.fan.present`);
                    if (fanZone === true || fanZone === "unknown") {
                        commands.push(`*#4*${zone}*11##`);
                    }
                } else {
                    commands.push(`*#4*${zone}*11##`);
                }
                commands.push(`*#4*${zone}*19##`);
                commands.push(`*#4*${zone}*20##`);
                commands.push(`*4*40*${zone}##`);
            }
        }
    }

    return commands;
}

////////////////////////////////////////////////////////////////////////
// HOME ASSISTANT MQTT AUTO-DISCOVERY ENGINE
////////////////////////////////////////////////////////////////////////

/**
 * Generates Home Assistant MQTT discovery configuration messages
 */
function buildDiscoveryMessage(deviceType, id, options = {}) {
    const prefix = options.prefix || "homeassistant";
    const bus = options.bus || "00";

    let devId = "";
    if (deviceType === "climate") {
        devId = `myhome_climate_zone_${id}`;
    } else if (deviceType === "contact") {
        devId = `myhome_contact_${id}`;
    } else if (deviceType === "aux") {
        devId = `myhome_aux_${id}`;
    } else if (deviceType === "gateway") {
        devId = `myhome_gateway_connection`;
    } else {
        devId = `myhome_${deviceType}_${id}_${bus}`.replace(/#/g, "_").toLowerCase();
    }

    const deviceBlock = {
        identifiers: ["myhome_bticino_scs"],
        name: options.gatewayName || "BTicino MyHome SCS",
        manufacturer: "BTicino / Legrand",
        model: "OpenWebNet Gateway",
        sw_version: "node-red-contrib-myhome-own-mqtt 1.0"
    };

    let config = null;
    let component = "";

    switch (deviceType) {
        case "light": {
            component = "light";
            config = {
                name: `MyHome Light ${id}`,
                unique_id: devId,
                schema: "default",
                state_topic: `${id}/${bus}/${LIGHT_TOPIC}`,
                command_topic: `${id}/${bus}/light/myhome/set`,
                state_value_template: "{{ value_json.state }}",
                payload_on: "ON",
                payload_off: "OFF",
                brightness_state_topic: `${id}/${bus}/${LIGHT_TOPIC}`,
                brightness_command_topic: `${id}/${bus}/brightness/myhome/set`,
                brightness_value_template: "{{ value_json.brightness }}",
                brightness_scale: 255,
                device: deviceBlock
            };
            break;
        }
        case "cover": {
            component = "cover";
            config = {
                name: `MyHome Cover ${id}`,
                unique_id: devId,
                state_topic: `${id}/${bus}/${COVER_TOPIC}`,
                command_topic: `${id}/${bus}/cover/myhome/set`,
                value_template: "{{ value_json.state }}",
                payload_open: "open",
                payload_close: "close",
                payload_stop: "stop",
                state_open: "opening",
                state_opening: "opening",
                state_closed: "closing",
                state_closing: "closing",
                state_stopped: "stopped",
                device: deviceBlock
            };
            break;
        }
        case "climate": {
            component = "climate";
            let zone = id;
            config = {
                name: `MyHome Climate Zone ${zone}`,
                unique_id: devId,
                current_temperature_topic: `${zone}/temperature/${CLIMATE_TOPIC}`,
                current_temperature_template: "{{ value_json.state }}",
                temperature_command_topic: `${zone}/setpoint/climate/myhome/set`,
                temperature_state_topic: `${zone}/setpoint/${CLIMATE_TOPIC}`,
                temperature_state_template: "{{ value_json.state }}",
                mode_command_topic: `${zone}/mode/climate/myhome/set`,
                mode_state_topic: `${zone}/mode/${CLIMATE_TOPIC}`,
                mode_state_template: "{{ value_json.state }}",
                modes: ["off", "heat", "cool", "auto"],
                action_topic: `${zone}/action/${CLIMATE_TOPIC}`,
                action_template: "{{ value_json.state }}",
                fan_mode_command_topic: `${zone}/fan/climate/myhome/set`,
                fan_mode_state_topic: `${zone}/fan/${CLIMATE_TOPIC}`,
                fan_mode_state_template: "{{ value_json.state }}",
                fan_modes: ["auto", "low", "medium", "high"],
                min_temp: 5,
                max_temp: 40,
                temp_step: 0.5,
                temperature_unit: "C",
                device: deviceBlock
            };
            break;
        }
        case "contact": {
            component = "binary_sensor";
            config = {
                name: `MyHome Contact ${id}`,
                unique_id: devId,
                state_topic: `${id}/${CONTACT_TOPIC}`,
                value_template: "{{ value_json.state }}",
                payload_on: "ON",
                payload_off: "OFF",
                device_class: "opening",
                device: deviceBlock
            };
            break;
        }
        case "aux": {
            component = "binary_sensor";
            config = {
                name: `MyHome Aux ${id}`,
                unique_id: devId,
                state_topic: `${id}/${AUX_TOPIC}`,
                value_template: "{{ value_json.state }}",
                payload_on: "ON",
                payload_off: "OFF",
                device: deviceBlock
            };
            break;
        }
        case "gateway": {
            component = "binary_sensor";
            config = {
                name: "MyHome Gateway Connection",
                unique_id: devId,
                state_topic: CONNECTION_TOPIC,
                value_template: "{{ value_json.state }}",
                payload_on: "ON",
                payload_off: "OFF",
                device_class: "connectivity",
                device: deviceBlock
            };
            break;
        }
        default:
            return null;
    }

    return {
        topic: `${prefix}/${component}/${devId}/config`,
        payload: JSON.stringify(config),
        qos: 0,
        retain: true
    };
}

module.exports = {
    // Protocol Constants
    ACK,
    NACK,
    START_COMMAND,
    START_MONITOR,
    SERVER_REQUIRES_HMAC1,
    SERVER_REQUIRES_HMAC2,
    INTERFACE,
    INTER_COMMANDS_DELAY,

    // Topics
    LIGHT_TOPIC,
    DISABLE_TOPIC,
    COVER_TOPIC,
    CLIMATE_TOPIC,
    CONTACT_TOPIC,
    AUX_TOPIC,
    BUTTON_TOPIC,
    BUTTON_PLUS_TOPIC,
    SCENARIOS_TOPIC,
    SCENE_TOPIC,
    GATEWAY_TOPIC,
    CONNECTION_TOPIC,

    // Auth & Stream
    calcPass,
    calcHMAC,
    digitToHex,
    hexToDigit,
    extractFrames,
    processInitialConnection,
    executeCommand,

    // Conversion
    StateManager,
    parseOwnEvent,
    buildOwnCommands,
    buildSyncRequests,
    buildDiscoveryMessage,
    getTemperature,
    splitTemperature,
    getBrightness
};
