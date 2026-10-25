const attrs = require("../../entities/state/attributes");
const capabilities = require("./capabilities");
const crypto = require("crypto");
const D103 = require("./D103CNProtocol");
const D103CNCamera = require("./D103CNCamera");
const D103CNCurrentStatisticsCapability = require("./capabilities/D103CNCurrentStatisticsCapability");
const D103CNHighResolutionManualControlCapability = require("./capabilities/D103CNHighResolutionManualControlCapability");
const D103CNOperationModeControlCapability = require("./capabilities/D103CNOperationModeControlCapability");
const D103CNSavedMap = require("./D103CNSavedMap");
const D103PublicProfile = require("./D103CNPublicProfile.json");
const dgram = require("dgram");
const DreameMapParser = require("./DreameMapParser");
const DreameMiotHelper = require("./DreameMiotHelper");
const fs = require("fs");
const Logger = require("../../Logger");
const MiioSocket = require("../../miio/MiioSocket");
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
        this.mapLastPollAt = null;
        this.mapLastError = null;
        this.mapBootstrapTimer = null;
        this.savedMapFingerprint = null;
        this.savedMapSnapshots = 0;
        this.savedMapError = null;
        this.lastLiveMapAt = 0;
        this.pollInFlight = null;
        this.camera = new D103CNCamera(this);
        const manualUdp = dgram.createSocket("udp4");
        manualUdp.bind(0, this.ip);
        this.manualSocketError = false;
        manualUdp.on("error", () => {
            this.manualSocketError = true;
        });
        this.manualSocket = new MiioSocket({socket: manualUdp, token: this.localSecret,
            deviceId: this.deviceId, rinfo: {address: this.ip, port: MiioSocket.PORT},
            timeout: 350, name: "d103-manual", isCloudSocket: false});
        this.registerCapability(new D103CNCurrentStatisticsCapability({robot: this}));

        if (this.implConfig.allowControls === true) {
            this.registerCapability(new D103CNOperationModeControlCapability({
                robot: this, presets: Object.entries(D103.OPERATION_MODES).map(([name, value]) =>
                    new ValetudoSelectionPreset({name: name, value: value}))
            }));
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
        const isManual = method === "set_properties" && Array.isArray(args) &&
            args.length === 1 && args[0].siid === 4 && args[0].piid === 15;
        return prepare.then(() => isManual ? this.sendManualTransport(method, args, options.timeout ?? 350) :
            super.sendCommand(method, args,
                {...options, interface: method === "action" && args.siid === 6 ? "cloud" : "local"}))
            .catch(e => {
                const reason = e?.constructor?.name === "MiioTimeoutError" ? "timeout" :
                    e?.constructor?.name === "RetryWrapperSurrenderError" ? "telemetry channel busy or stamp invalid" : "request rejected";
                throw new Error(`D103CN ${isManual ? "manual" : "miIO"} request failed: ${reason}; private response redacted`);
            });
    }

    /**
     * Independent authenticated UDP transactions. No telemetry mutex, queues or retries.
     * Reuses a recent stamp obtained by authenticated local requests, never an invented handshake.
     * @param {string} method
     * @param {Array} args
     * @param {number} timeout
     */
    sendManualTransport(method, args, timeout) {
        if (!D103.commandAllowed(method, args, this.implConfig) || this.manualSocketError ||
            Object.keys(this.manualSocket.pendingRequests).length !== 0) {
            return Promise.reject(new Error("D103CN dedicated manual transport unavailable or busy"));
        }
        const normalStamp = this.localSocket.miioSocket.codec.stamp;
        if (normalStamp.isValid()) {
            this.manualSocket.codec.stamp = normalStamp;
        }
        if (!this.manualSocket.codec.stamp.isValid()) {
            return Promise.reject(new Error("D103CN manual transport requires a fresh authenticated stamp"));
        }
        const token = this.localSecret;
        if (!this.manualSocket.codec.token.equals(token)) {
            this.manualSocket.codec.setToken(token);
        }
        return this.manualSocket.sendMessage({id: crypto.randomInt(1, 0x7fffffff), method: method, params: args}, {timeout: timeout});
    }

    /** Read-only hardware check of both independent channels; no manual enable or motor payload. */
    async probeManualTransport() {
        await this.refreshControlState();
        const properties = [1, 2].map(piid => ({did: this.deviceId, siid: 2, piid: piid}));
        const started = performance.now();
        const responses = await Promise.all([
            this.sendCommand("get_properties", properties, {timeout: 700, noRetry: true}),
            this.sendManualTransport("get_properties", properties, 700)
        ]);
        if (!responses.every(response => Array.isArray(response) && response.length === 2 &&
            response.every(p => p.code === 0 && Number.isInteger(p.value)))) {
            throw new Error("D103CN parallel channel readback incomplete");
        }
        return {independentTransport: true, authenticatedReadback: true,
            latencyMs: Math.round(performance.now() - started), motorPayloadsSent: false};
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

    /**
     * Refresh only status/fault, independent of which UI page is open.
     * @param {{noRetry?: boolean, force?: boolean}} options Read-only camera startup may handshake after idle.
     */
    async refreshControlState(options = {}) {
        if (options.force !== true && performance.now() - Math.min(this.lastStateAt, this.lastFaultAt) < 2000) {
            return;
        }
        if (this.controlPollInFlight) {
            return this.controlPollInFlight;
        }
        this.controlPollInFlight = (async () => {
            const response = await this.sendCommand("get_properties", [1, 2].map(piid => ({
                did: this.deviceId, siid: 2, piid: piid
            })), {timeout: 700, noRetry: options.noRetry ?? true});
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
            refreshError: age <= 2000 ? null : this.lastControlPollError};
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
        if (parsed.operationMode) {
            this.state.upsertFirstMatchingAttribute(new attrs.PresetSelectionStateAttribute({
                type: attrs.PresetSelectionStateAttribute.TYPE.OPERATION_MODE, value: parsed.operationMode
            }));
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
        if (this.implConfig.enableMapPolling === true) {
            this.pollMap();
        }
    }

    onCloudConnected() {
        // Upstream fires this even on an empty/unauthenticated datagram. Do not call that auth success.
        Logger.info("D103CN cloud UDP transport seen; authenticated messages still required");
        if (this.implConfig.enableMapPolling === true && this.implConfig.enableLegacyCloudMapPolling === true) {
            clearTimeout(this.mapBootstrapTimer);
            this.mapBootstrapTimer = setTimeout(() => this.pollMap(), 5000);
            this.mapBootstrapTimer.unref();
        }
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
        if (this.implConfig.enableMapPolling !== true) {
            return;
        }
        if (Date.now() - this.lastLiveMapAt > 60000) {
            try {
                const saved = D103CNSavedMap.READ_NEW(this.savedMapFingerprint);
                if (saved) {
                    this.savedMapFingerprint = saved.fingerprint;
                    this.state.map = saved.map;
                    this.savedMapSnapshots++;
                    this.savedMapError = null;
                    this.emitMapUpdated();
                }
            } catch (e) {
                this.savedMapError = "Local saved-map read/format validation failed";
            }
        }
        if (this.implConfig.enableLegacyCloudMapPolling !== true || !this.dummyCloud.miioSocket.connected) {
            return;
        }
        // Bootstrap with a read-only encrypted map request. Waiting for a map
        // notification before ever asking for a map deadlocks an idle SDK.
        const peer = this.dummyCloud.miioSocket.rinfo?.address;
        if (peer !== "127.0.0.1" && peer !== this.ip) {
            this.mapLastError = "Map bridge peer is not this robot";
            return;
        }
        this.mapLastPollAt = Date.now();
        let result;
        try {
            result = await this.sendCommand("action", {did: this.deviceId, siid: 6, aiid: 1,
                in: [{piid: 2, value: '{"frame_type":"I", "force_type":1, "req_type":1}'}]},
            {timeout: 7000, interface: "cloud"});
        } catch (e) {
            this.mapLastError = "Local SDK map request was not acknowledged";
            throw e;
        }
        if (result?.code === 0 && Array.isArray(result.out)) {
            this.mapLastError = null;
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
            parsed.metaData.source = "D103CN live SDK map";
            this.state.map = parsed;
            this.mapFramesParsed++;
            this.lastLiveMapAt = Date.now();
            this.mapLastError = null;
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
        clearTimeout(this.mapBootstrapTimer);
        clearTimeout(this.mapPollTimeout);
        clearInterval(this.controlStateTimer);
        this.controlStateTimer = null;
        const manual = this.capabilities.HighResolutionManualControlCapability;
        if (manual) {
            await manual.disableManualControl().catch(() => Logger.warn("D103CN shutdown stop was not acknowledged"));
        }
        await this.camera.stop().catch(() => Logger.warn("D103CN camera shutdown restoration was not acknowledged"));
        await this.manualSocket.shutdown();
        await super.shutdown();
    }
    getModelName() {
        return "Mijia M30S (D103CN, experimental)";
    }
    getProperties() {
        return {experimental: true, controlsEnabled: this.implConfig.allowControls === true,
            cloudAuthenticatedMessages: this.authenticatedCloudMessages, mapFramesParsed: this.mapFramesParsed,
            mapBridge: {connected: this.dummyCloud.miioSocket.connected,
                lastPollAt: this.mapLastPollAt, lastError: this.mapLastError},
            savedMap: {snapshotsLoaded: this.savedMapSnapshots, lastError: this.savedMapError,
                displayed: this.state.map.metaData.savedMapSnapshot === true},
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
