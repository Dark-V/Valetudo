const attrs = require("../../entities/state/attributes");
const capabilities = require("./capabilities");
const D103 = require("./D103CNProtocol");
const D103CNHighResolutionManualControlCapability = require("./capabilities/D103CNHighResolutionManualControlCapability");
const D103CNCamera = require("./D103CNCamera");
const D103PublicProfile = require("./D103CNPublicProfile.json");
const DreameMapParser = require("./DreameMapParser");
const DreameMiotHelper = require("./DreameMiotHelper");
const fs = require("fs");
const Logger = require("../../Logger");
const MiioValetudoRobot = require("../MiioValetudoRobot");
const ValetudoRobotError = require("../../entities/core/ValetudoRobotError");
const ValetudoSelectionPreset = require("../../entities/core/ValetudoSelectionPreset");

/** Experimental owner-device port. Not official Valetudo model support. */
class DreameMijiaM30SValetudoRobot extends MiioValetudoRobot {
    constructor(options) {
        // Validate before super creates listeners. Never source or change the factory config.
        if (options.config.get("embedded") !== true || !D103.matchesModel(fs.readFileSync(DEVICE_CONF))) {
            throw new Error("D103CN profile requires the actual D103CN stock OS");
        }
        super(options);
        this.miotHelper = new DreameMiotHelper({robot: this});
        this.d103State = [];
        this.lastDiagnostics = {};
        this.lastStateAt = -Infinity;
        this.lastFaultAt = -Infinity;
        this.controlPollInFlight = null;
        this.controlConsumers = new Set();
        this.controlStateTimer = null;
        this.lastControlPollError = null;
        this.authenticatedCloudMessages = 0;
        this.mapFramesParsed = 0;
        this.pollInFlight = null;
        this.camera = new D103CNCamera(this);

        if (this.implConfig.allowControls === true) {
            this.registerCapability(new capabilities.DreameBasicControlCapability({
                robot: this, miot_actions: {start: {siid: 2, aiid: 1}, pause: {siid: 2, aiid: 2},
                    stop: {siid: 4, aiid: 2}, home: {siid: 3, aiid: 1}}
            }));
            this.registerCapability(new capabilities.DreameFanSpeedControlCapability({
                robot: this, siid: 2, piid: 3,
                presets: FAN_PRESETS.map((name, value) => new ValetudoSelectionPreset({name: name, value: value}))
            }));
            this.registerCapability(new capabilities.DreameWaterUsageControlCapability({
                robot: this, siid: 4, piid: 5,
                presets: WATER_PRESETS.map((name, index) => new ValetudoSelectionPreset({name: name, value: index + 1}))
            }));
            this.registerCapability(new capabilities.DreameSpeakerVolumeControlCapability({robot: this, siid: 7, piid: 1}));
            if (this.implConfig.allowManualControl === true) {
                this.registerCapability(new D103CNHighResolutionManualControlCapability({robot: this}));
            }
        }
        // No inherited Gen2 auto-writes, reset, voice-pack, Wi-Fi reconfiguration, dock or camera controls.
    }

    setEmbeddedParameters() {
        this.deviceConfPath = DEVICE_CONF;
        this.tokenFilePath = "/data/config/miio/device.token";
    }

    get deviceId() {
        if (this.cachedDeviceId === undefined) {
            this.cachedDeviceId = D103.parseDeviceId(fs.readFileSync("/mnt/private/ULI/factory/did.txt"));
        }
        return this.cachedDeviceId;
    }

    get localSecret() {
        // Read every time, preserving upstream RetryWrapper support after a token change.
        return D103.normalizeSecret(fs.readFileSync(this.tokenFilePath));
    }

    get cloudSecret() {
        if (this.cachedCloudSecret === undefined) {
            this.cachedCloudSecret = D103.normalizeSecret(fs.readFileSync("/mnt/private/ULI/factory/key.txt"));
        }
        return this.cachedCloudSecret;
    }

    /**
     * @param {string} method
     * @param {object|Array} args
     * @param {object} options
     */
    sendCommand(method, args = [], options = {}) {
        if (!D103.commandAllowed(method, args, this.implConfig)) {
            return Promise.reject(new Error("D103CN: operation disabled or outside the model-specific allowlist"));
        }
        // State/control uses the already verified local interface. A connected UDP socket is not auth proof.
        const prepare = method === "action" && ((args.siid === 2 && args.aiid === 1) ||
            (args.siid === 3 && args.aiid === 1)) ? this.camera.stop() : Promise.resolve();
        return prepare.then(() => super.sendCommand(method, args,
            {...options, interface: method === "action" && args.siid === 6 ? "cloud" : "local"}))
            .catch(() => {
                throw new Error("D103CN miIO request failed; private response redacted");
            });
    }

    sendCloud(msg, options = {}) {
        if (msg && typeof msg.method === "string" && !D103.commandAllowed(msg.method, msg.params, this.implConfig)) {
            return Promise.reject(new Error("D103CN: cloud command disabled by policy"));
        }
        return super.sendCloud(msg, options);
    }

    async pollState() {
        if (this.pollInFlight) {
            return this.pollInFlight;
        }
        this.pollInFlight = (async () => {
            // Bound packet size; do not run concurrent local RPCs on factory firmware.
            for (let offset = 0; offset < D103.READ_PROPERTIES.length; offset += 8) {
                const batch = D103.READ_PROPERTIES.slice(offset, offset + 8).map(([siid, piid]) => ({siid: siid, piid: piid}));
                this.parseAndUpdateState(await this.miotHelper.readProperties(batch));
            }
            return this.state;
        })();
        try {
            return await this.pollInFlight;
        } finally {
            this.pollInFlight = null;
        }
    }

    /** Refresh only status/fault, independent of which UI page is open. */
    async refreshControlState() {
        if (performance.now() - Math.min(this.lastStateAt, this.lastFaultAt) < 2000) {
            return;
        }
        if (this.controlPollInFlight) {
            return this.controlPollInFlight;
        }
        this.controlPollInFlight = (async () => {
            const response = await this.sendCommand("get_properties", [1, 2].map(piid => ({
                did: this.deviceId, siid: 2, piid: piid
            })), {timeout: 700, noRetry: true});
            if (!Array.isArray(response) || ![1, 2].every(piid => response.some(p =>
                p?.siid === 2 && p.piid === piid && p.code === 0 && Number.isInteger(p.value) && p.value >= 0))) {
                throw new Error("D103CN status/fault readback is incomplete");
            }
            this.parseAndUpdateState(response);
            this.lastControlPollError = null;
        })();
        try {
            await this.controlPollInFlight;
        } catch (e) {
            this.lastControlPollError = "Status/fault refresh failed";
            throw e;
        } finally {
            this.controlPollInFlight = null;
        }
    }

    /** @param {string} consumer */
    beginControlMonitoring(consumer) {
        this.controlConsumers.add(consumer);
        if (!this.controlStateTimer) {
            this.controlStateTimer = setInterval(() => {
                this.refreshControlState().catch(() => {}); // Existing age guards fail closed on loss of telemetry.
            }, 1000);
            this.controlStateTimer.unref();
        }
    }

    /** @param {string} consumer */
    endControlMonitoring(consumer) {
        this.controlConsumers.delete(consumer);
        if (this.controlConsumers.size === 0) {
            clearInterval(this.controlStateTimer);
            this.controlStateTimer = null;
        }
    }

    getControlReadiness() {
        const status = this.d103State.find(p => p.siid === 2 && p.piid === 1)?.value;
        const fault = this.d103State.find(p => p.siid === 2 && p.piid === 2)?.value;
        const age = performance.now() - Math.min(this.lastStateAt, this.lastFaultAt);
        return {status: status ?? null, fault: fault ?? null,
            ageMs: Number.isFinite(age) ? Math.round(age) : null,
            ready: fault === 0 && [2, 3, 6, 13, 21, 23].includes(status) && age <= 10000,
            refreshError: this.lastControlPollError};
    }

    parseAndUpdateState(data) {
        if (!Array.isArray(data)) {
            return;
        }
        for (const p of data) {
            if (p && p.code === 0 && D103.READ_PROPERTIES.some(([s, i]) => p.siid === s && p.piid === i)) {
                if (p.siid === 2 && p.piid === 1 && Number.isInteger(p.value)) {
                    this.lastStateAt = performance.now();
                }
                if (p.siid === 2 && p.piid === 2 && Number.isInteger(p.value)) {
                    this.lastFaultAt = performance.now();
                }
                this.d103State = this.d103State.filter(old => old.siid !== p.siid || old.piid !== p.piid);
                this.d103State.push(p);
            }
        }
        const parsed = D103.summarizeState(this.d103State);
        if (parsed.status) {
            this.state.upsertFirstMatchingAttribute(new attrs.StatusStateAttribute({
                value: parsed.status.value, flag: parsed.status.flag, metaData: parsed.status.metaData,
                error: parsed.status.value === "error" ? new ValetudoRobotError({
                    severity: {kind: ValetudoRobotError.SEVERITY_KIND.UNKNOWN, level: ValetudoRobotError.SEVERITY_LEVEL.ERROR},
                    subsystem: ValetudoRobotError.SUBSYSTEM.UNKNOWN,
                    vendorErrorCode: String(parsed.status.fault ?? "unknown"),
                    message: parsed.status.fault ? `D103CN fault ${parsed.status.fault}` : "D103CN unknown/error state; check robot"
                }) : undefined
            }));
        }
        if (parsed.battery) {
            this.state.upsertFirstMatchingAttribute(new attrs.BatteryStateAttribute(parsed.battery));
        }
        for (const [raw, presets, type] of [[parsed.fan, FAN_PRESETS, "fan_speed"], [parsed.water - 1, WATER_PRESETS, "water_grade"]]) {
            if (presets[raw]) {
                this.state.upsertFirstMatchingAttribute(new attrs.PresetSelectionStateAttribute({type: type, value: presets[raw]}));
            }
        }
        if (parsed.dock) {
            this.state.upsertFirstMatchingAttribute(new attrs.DockStatusStateAttribute({value: parsed.dock}));
        }
        this.lastDiagnostics = parsed.diagnostics;
        this.emitStateAttributesUpdated();
    }

    startup() {
        // Intentionally do not call MiioValetudoRobot.startup(): it prints DID and both secrets.
        Logger.info("Experimental Xiaomi Mijia M30S / D103CN profile; secrets redacted");
        Logger.info(`D103CN controls=${this.implConfig.allowControls === true}, mapPolling=${this.implConfig.enableMapPolling === true}`);
    }

    onCloudConnected() {
        // Upstream fires this even on an empty/unauthenticated datagram. Do not call that auth success.
        Logger.info("D103CN cloud UDP transport seen; authenticated messages still required");
    }

    onIncomingCloudMessage(msg) {
        this.authenticatedCloudMessages++;
        if (this.authenticatedCloudMessages === 1 && this.implConfig.enableMapPolling === true) {
            this.pollMap();
        }
        if (msg.method === "properties_changed" && Array.isArray(msg.params)) {
            this.parseAndUpdateState(msg.params.map(p => ({...p, code: p.code ?? 0})));
            for (const p of msg.params) {
                if (this.implConfig.enableMapPolling === true && p.siid === 6 && p.piid === 1 && typeof p.value === "string") {
                    this.acceptMap(p.value).catch(() => Logger.warn("D103CN: map rejected; private payload not logged"));
                }
            }
        } else if (super.onIncomingCloudMessage(msg)) {
            return true;
        }
        // Acknowledge actual requests only, not replies; never echo their private contents to logs.
        if (msg.id !== undefined && typeof msg.method === "string") {
            this.sendCloud({id: msg.id, result: ["ok"]}).catch(() => Logger.warn("D103CN cloud acknowledgement failed"));
        }
        return true;
    }

    async executeMapPoll() {
        if (this.implConfig.enableMapPolling !== true || this.authenticatedCloudMessages === 0) {
            return;
        }
        const result = await this.sendCommand("action", {did: this.deviceId, siid: 6, aiid: 1,
            in: [{piid: 2, value: '{"frame_type":"I", "force_type":1, "req_type":1}'}]},
        {timeout: 7000, interface: "cloud"});
        if (result?.code === 0 && Array.isArray(result.out)) {
            for (const p of result.out) {
                if (p.piid === 1 && typeof p.value === "string" && p.value.length > 15) {
                    await this.acceptMap(p.value);
                }
            }
        }
    }

    async acceptMap(data) {
        const raw = D103.decodeMapEnvelope(data, {iv: this.implConfig.mapIv ?? D103PublicProfile.publicMapIv});
        const parsed = await DreameMapParser.PARSE(raw);
        if (parsed) {
            this.state.map = parsed;
            this.mapFramesParsed++;
            this.emitMapUpdated();
        }
    }

    async handleUploadedFDSData(data) {
        if (this.implConfig.enableMapPolling === true) {
            await this.acceptMap(data);
        }
    }

    getManufacturer() {
        return "Xiaomi";
    }

    async shutdown() {
        clearInterval(this.controlStateTimer);
        this.controlStateTimer = null;
        const manual = this.capabilities.HighResolutionManualControlCapability;
        if (manual) {
            await manual.disableManualControl().catch(() => Logger.warn("D103CN shutdown stop was not acknowledged"));
        }
        await this.camera.stop().catch(() => Logger.warn("D103CN camera shutdown restoration was not acknowledged"));
        await super.shutdown();
    }
    getModelName() {
        return "Mijia M30S (D103CN, experimental)";
    }
    getProperties() {
        return {experimental: true, controlsEnabled: this.implConfig.allowControls === true,
            cloudAuthenticatedMessages: this.authenticatedCloudMessages, mapFramesParsed: this.mapFramesParsed,
            diagnostics: this.lastDiagnostics, controlReadiness: this.getControlReadiness()};
    }

    static IMPLEMENTATION_AUTO_DETECTION_HANDLER() {
        // Explicit selection only until this port passes owner-device validation.
        return false;
    }
}

const DEVICE_CONF = "/data/config/miio/device.conf";
const FAN_PRESETS = ["low", "medium", "high", "max"];
const WATER_PRESETS = ["low", "medium", "high"];
module.exports = DreameMijiaM30SValetudoRobot;
