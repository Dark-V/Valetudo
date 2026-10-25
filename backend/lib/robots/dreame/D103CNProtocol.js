/* D103CN-specific pure parsing/policy. No sockets, robot emulation or filesystem IO. */
const crypto = require("crypto");
const featurePolicy = require("./D103CNFeaturePolicy");
const zlib = require("zlib");

const READ_PROPERTIES = Object.freeze([
    [2, 1], [2, 2], [2, 3], [3, 1], [3, 2],
    [4, 1], [4, 2], [4, 3], [4, 5], [4, 23], [4, 25], [7, 1]
]);
// Stock packed clean-setting 4/23: low byte selects operation mode;
// upper bytes contain mop washing/wetness settings and must be preserved.
const OPERATION_MODES = Object.freeze({vacuum_and_mop: 0, mop: 1, vacuum: 2, vacuum_then_mop: 3});
function validCleanSettings(value) {
    return Number.isInteger(value) && value >= 0 && value <= 999999999 && value % 256 <= 3;
}

function operationMode(value) {
    return validCleanSettings(value) ? Object.keys(OPERATION_MODES).find(name => OPERATION_MODES[name] === value % 256) : undefined;
}

function withOperationMode(value, preset) {
    if (!validCleanSettings(value) || !Object.hasOwn(OPERATION_MODES, preset)) {
        throw new Error("D103CN: unsupported clean settings or operation mode");
    }
    return value - value % 256 + OPERATION_MODES[preset];
}

// Upstream DreameGen2 maps 68 to a docked mop-attachment reminder.
// Require both a known stationary dock state and actual charging here;
// do not suppress it during navigation/cleaning or discard other faults.
function isDockMopReminder(status, fault, charging) {
    return fault === 68 && charging === 1 && [6, 8, 9, 13, 20, 21, 22, 30].includes(status);
}
const BASIC_ACTIONS = Object.freeze([[2, 1], [2, 2], [4, 2], [3, 1]]);
// Public MIOT action IDs; intentionally NOT advertised as working dock capabilities yet.
const DOCK_ACTIONS = Object.freeze([[2, 4], [2, 6], [2, 8], [2, 9], [2, 10]]);

function normalizeSecret(input) {
    let value = Buffer.from(input);
    // A raw 16-byte token may itself contain LF. Never trim it indiscriminately.
    if (value.length === 17 && value[16] === 10) {
        value = value.subarray(0, 16);
    } else if (value.length === 18 && value[16] === 13 && value[17] === 10) {
        value = value.subarray(0, 16);
    } else if (/^[a-f\d]{32}(?:\r?\n)?$/i.test(value.toString("latin1"))) {
        value = Buffer.from(value.toString("latin1").trim(), "hex");
    }
    if (value.length !== 16 || value.equals(Buffer.alloc(16)) || value.equals(Buffer.alloc(16, 255))) {
        throw new Error("D103CN: invalid 16-byte secret; contents redacted");
    }
    return Buffer.from(value);
}

function parseDeviceId(input) {
    const value = Buffer.from(input).toString("latin1").trim();
    if (!/^\d{1,10}$/.test(value) || Number(value) < 1 || Number(value) >= 0xffffffff) {
        throw new Error("D103CN: invalid factory DID; contents redacted");
    }
    return Number(value);
}

function matchesModel(input) {
    // Do not execute/source device.conf: it deliberately contains the owner's SSH/UART hooks.
    return Buffer.from(input).toString("utf8").split(/\r?\n/)
        .some(line => line === "model=xiaomi.vacuum.d103cn");
}

function containsPair(list, siid, id) {
    return list.some(pair => pair[0] === siid && pair[1] === id);
}

const MANUAL_LIMITS = Object.freeze({velocity: 100, rotation: 90, deadmanMs: 800});

function manualPayload(vector, audioHint = false) {
    if (!vector || !Number.isFinite(vector.velocity) || !Number.isFinite(vector.angle) ||
        Math.abs(vector.velocity) > 1 || Math.abs(vector.angle) > 180) {
        throw new Error("D103CN: invalid manual movement vector");
    }
    return JSON.stringify({
        spdv: Math.round(vector.velocity * MANUAL_LIMITS.velocity),
        spdw: Math.round(-vector.angle * MANUAL_LIMITS.rotation / 180),
        audio: audioHint ? "true" : "false",
        random: crypto.randomInt(65535)
    });
}

function validManualPayload(value) {
    if (typeof value !== "string" || value.length > 160) {
        return false;
    }
    try {
        const p = JSON.parse(value);
        return p !== null && !Array.isArray(p) &&
            Object.keys(p).sort().join(",") === "audio,random,spdv,spdw" &&
            Number.isInteger(p.spdv) && Math.abs(p.spdv) <= MANUAL_LIMITS.velocity &&
            Number.isInteger(p.spdw) && Math.abs(p.spdw) <= MANUAL_LIMITS.rotation &&
            Number.isInteger(p.random) && p.random >= 0 && p.random < 65535 &&
            (p.audio === "true" || p.audio === "false");
    } catch (_) {
        return false;
    }
}

function commandAllowed(method, args, policy = {}) {
    if (method === "get_properties") {
        return Array.isArray(args) && args.length > 0 && args.length <= 16 &&
            args.every(p => p && (containsPair(READ_PROPERTIES, p.siid, p.piid) ||
                containsPair(featurePolicy.READ_PROPERTIES, p.siid, p.piid) ||
                // Large settings JSON is read on demand by the upstream
                // capabilities, independently of the normal telemetry batches.
                (args.length === 1 && p.siid === 4 && p.piid === 50)));
    }
    if (method === "action" && args && Array.isArray(args.in)) {
        if (policy.allowControls === true && featurePolicy.actionAllowed(args)) {
            return true;
        }
        if (policy.allowControls === true && args.in.length === 0 &&
            containsPair(BASIC_ACTIONS, args.siid, args.aiid)) {
            return true;
        }
        // Map request is not a cleaning action, but remains a separate, explicit trial step.
        return policy.enableMapPolling === true && args.siid === 6 && args.aiid === 1 &&
            args.in.length === 1 && args.in[0].piid === 2 &&
            [
                '{"frame_type":"I", "force_type":1, "req_type":1}',
                '{"frame_type":"I","req_type":2}'
            ].includes(args.in[0].value);
    }
    if (method === "set_properties" && policy.allowControls === true && Array.isArray(args) &&
        args.length > 0 && args.length <= 3) {
        if (policy.allowManualControl === true && args.length === 1 && args[0]?.siid === 4 && args[0]?.piid === 15) {
            return validManualPayload(args[0].value);
        }
        if (args.length === 1 && args[0]?.siid === 4 && args[0]?.piid === 50) {
            // Same single-tunable serialization as upstream DreameUtils.
            // Do not rewrite the entire stock settings list or unrelated fields.
            try {
                if (typeof args[0].value !== "string" || args[0].value.length > 80) {
                    return false;
                }
                const tunable = JSON.parse(args[0].value);
                return tunable !== null && !Array.isArray(tunable) &&
                    Object.keys(tunable).sort().join(",") === "k,v" &&
                    ((["MopExtrSwitch", "LessColl", "CarpetFineClean"].includes(tunable.k) && [0, 1].includes(tunable.v)) ||
                    (tunable.k === "ExtrFreq" && [1, 2, 7].includes(tunable.v)));
            } catch (_) {
                return false;
            }
        }
        return args.every(p => featurePolicy.writeAllowed(p) || (p && Number.isInteger(p.value) && (
            (p.siid === 2 && p.piid === 3 && p.value >= 0 && p.value <= 3) ||
            (p.siid === 4 && p.piid === 5 && p.value >= 1 && p.value <= 3) ||
            (p.siid === 4 && p.piid === 23 && args.length === 1 && validCleanSettings(p.value)) ||
            (p.siid === 7 && p.piid === 1 && p.value >= 0 && p.value <= 100)
        )));
    }
    return false;
}

function summarizeState(properties) {
    const values = new Map();
    for (const p of Array.isArray(properties) ? properties : []) {
        if (p && p.code === 0 && Number.isInteger(p.value) && containsPair(READ_PROPERTIES, p.siid, p.piid)) {
            values.set(`${p.siid}/${p.piid}`, p.value);
        }
    }
    const status = values.get("2/1");
    const stateMap = {
        1: "cleaning", 2: "idle", 3: "paused", 4: "error", 5: "returning", 6: "docked",
        7: "cleaning", 8: "docked", 9: "docked", 10: "returning", 11: "moving",
        12: "cleaning", 13: "docked", 14: "idle", 19: "idle", 20: "docked", 21: "docked",
        22: "docked", 23: "manual_control", 30: "docked"
    };
    const fault = values.get("2/2");
    const level = values.get("3/1");
    const charging = values.get("3/2");
    const mopReminder = isDockMopReminder(status, fault, charging);
    const activeFault = fault > 0 && !mopReminder ? fault : undefined;
    return {
        status: status === undefined ? undefined : {
            value: activeFault ? "error" : stateMap[status] ?? "error",
            flag: status === 11 ? "mapping" : "none",
            metaData: {miotStatus: status, workMode: values.get("4/1"),
                unmapped: stateMap[status] === undefined, upgrading: status === 14,
                nativeFault: fault, mopAttachmentReminder: mopReminder},
            fault: activeFault
        },
        battery: level >= 0 && level <= 100 ? {
            level: level, flag: charging === 1 ? (level === 100 ? "charged" : "charging") :
                charging === 2 ? "discharging" : "none"
        } : undefined,
        fan: values.get("2/3"), water: values.get("4/5"), operationMode: operationMode(values.get("4/23")),
        dock: status === undefined || stateMap[status] === undefined ? undefined :
            ({8: "drying", 9: "cleaning", 20: "cleaning", 21: "pause", 22: "emptying", 30: "cleaning"})[status] ?? "idle",
        // No speculative conversion of clean_area to cm²: retain its raw value for diagnostics.
        diagnostics: {cleanTimeMinutes: values.get("4/2"), cleanAreaRaw: values.get("4/3"),
            washStationRaw: values.get("4/25"), workModeRaw: values.get("4/1"), cleanSettingsRaw: values.get("4/23"),
            faultRaw: fault, dockMopReminder: mopReminder}
    };
}

function decodeMapEnvelope(input, options = {}) {
    const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    if (typeof text !== "string" || text.length > 8 * 1024 * 1024) {
        throw new Error("D103CN: unsupported map envelope");
    }
    const parts = text.trim().split(",");
    if (parts.length > 2 || !/^[A-Za-z\d+/_=-]+$/.test(parts[0])) {
        throw new Error("D103CN: invalid map base64 envelope");
    }
    let packed = Buffer.from(parts[0].replace(/_/g, "/").replace(/-/g, "+"), "base64");
    const key = parts[1] ?? options.key;
    if (key !== undefined) {
        if (typeof options.iv !== "string" || Buffer.byteLength(options.iv) !== 16 ||
            typeof key !== "string" || key.length < 1 || key.length > 512 || packed.length % 16 !== 0) {
            throw new Error("D103CN: encrypted map requires its actual 16-byte IV and per-map key");
        }
        // Matches Tasshack's envelope: ASCII first 32 chars of SHA256(key).hexdigest(), NOT raw SHA256 bytes.
        const aesKey = Buffer.from(crypto.createHash("sha256").update(key).digest("hex").slice(0, 32));
        const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, Buffer.from(options.iv));
        decipher.setAutoPadding(false); // zlib ignores the trailing vendor padding.
        packed = Buffer.concat([decipher.update(packed), decipher.final()]);
    }
    let raw;
    try {
        raw = zlib.inflateSync(packed, {maxOutputLength: 16 * 1024 * 1024});
    } catch (_) {
        throw new Error("D103CN: map inflate failed; no map data logged");
    }
    if (raw.length < 27 || raw[4] !== 73) {
        throw new Error("D103CN: only complete I-frames are supported; request an I-frame");
    }
    const width = raw.readInt16LE(19);
    const height = raw.readInt16LE(21);
    if (width < 0 || height < 0 || 27 + width * height > raw.length) {
        throw new Error("D103CN: invalid/truncated map geometry");
    }
    return raw;
}

module.exports = {READ_PROPERTIES: READ_PROPERTIES, BASIC_ACTIONS: BASIC_ACTIONS, DOCK_ACTIONS: DOCK_ACTIONS,
    OPERATION_MODES: OPERATION_MODES, validCleanSettings: validCleanSettings,
    operationMode: operationMode, withOperationMode: withOperationMode,
    isDockMopReminder: isDockMopReminder,
    MANUAL_LIMITS: MANUAL_LIMITS, manualPayload: manualPayload, validManualPayload: validManualPayload,
    normalizeSecret: normalizeSecret, parseDeviceId: parseDeviceId,
    matchesModel: matchesModel, commandAllowed: commandAllowed, summarizeState: summarizeState, decodeMapEnvelope: decodeMapEnvelope};
