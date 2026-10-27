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
const DreameQuirkFactory = require("./DreameQuirkFactory");
const DreameValetudoRobot = require("./DreameValetudoRobot");
const fs = require("fs");
const Logger = require("../../Logger");
const MiioSocket = require("../../miio/MiioSocket");
const MiioValetudoRobot = require("../MiioValetudoRobot");
const QuirksCapability = require("../../core/capabilities/QuirksCapability");
const registerFeatureCapabilities = require("./D103CNFeatureCapabilities");
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
        this.mapFullFrameTimer = null;
        this.mapCloudConnectedAt = 0;
        this.mapLastRefreshAt = 0;
        this.savedMapFingerprint = null;
        this.savedMapSnapshots = 0;
        this.savedMapError = null;
        this.lastLiveMapAt = 0;
        this.pollInFlight = null;
        this.stationActionPending = false;
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
            // These stock MIOT 4/50 tunables match the existing Dreame Gen2
            // contract. Reuse its implementations, rather than another controller.
            const dreame = /** @type {import("./DreameValetudoRobot")} */ (/** @type {unknown} */ (this));
            this.registerCapability(new capabilities.DreameMopExtensionControlCapabilityV2({robot: dreame}));
            this.registerCapability(new capabilities.DreameCollisionAvoidantNavigationControlCapability({robot: dreame}));
            const quirkFactory = new DreameQuirkFactory({robot: dreame});
            this.registerCapability(new QuirksCapability({robot: this, quirks: [
                quirkFactory.getQuirk(DreameQuirkFactory.KNOWN_QUIRKS.EDGE_EXTENSION_FREQUENCY),
                quirkFactory.getQuirk(DreameQuirkFactory.KNOWN_QUIRKS.CARPET_MODE_SENSITIVITY),
                quirkFactory.getQuirk(DreameQuirkFactory.KNOWN_QUIRKS.CARPET_DETECTION_AUTO_DEEP_CLEANING)
            ]}));
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
            registerFeatureCapabilities(this);
            if (this.implConfig.allowManualControl === true) {
                this.registerCapability(new D103CNHighResolutionManualControlCapability({robot: this}));
            }
        }
        // No inherited Gen2 startup auto-writes. Jobs/map edits/settings require explicit API requests.
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
            (args.siid === 3 && args.aiid === 1) || (args.siid === 4 && args.aiid === 1)) ? this.camera.stop() : Promise.resolve();
        const isManual = method === "set_properties" && Array.isArray(args) &&
            args.length === 1 && args[0].siid === 4 && args[0].piid === 15;
        const stationAction = method === "action" && ((args.siid === 4 && [3, 4].includes(args.aiid)) || (args.siid === 15 && args.aiid === 1));
        const pointAction = method === "action" && args.siid === 4 && args.aiid === 1 && args.in.some(p => p.piid === 1 && p.value === 23);
        if (stationAction || pointAction || (this.stationActionPending && method === "action" && args.siid === 4 && args.aiid === 2)) {
            // A station/nav action with a lost ACK must not be blindly replayed.
            options = {...options, timeout: 2000, noRetry: true};
        }
        return prepare.then(() => isManual ? this.sendManualTransport(method, args, options.timeout ?? 350) :
            super.sendCommand(method, args,
                {...options, interface: method === "action" && args.siid === 6 && args.aiid === 1 ? "cloud" : "local"}))
            .then(result => {
                // Several upstream map capabilities otherwise silently return
                // success when an incompatible firmware omits the action result.
                if (method === "action" && args.siid === 6 && args.aiid === 2 &&
                    (result?.code !== 0 || !Array.isArray(result.out) || result.out.length !== 1 ||
                        result.siid !== 6 || result.aiid !== 2 ||
                        result.out[0].piid !== 6 || !Number.isInteger(result.out[0].value))) {
                    throw new Error("D103CN: invalid map edit acknowledgement");
                }
                return result;
            })
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
            const properties = [];
            for (let offset = 0; offset < D103.READ_PROPERTIES.length; offset += 8) {
                const batch = D103.READ_PROPERTIES.slice(offset, offset + 8).map(([siid, piid]) => ({siid: siid, piid: piid}));
                properties.push(...await this.miotHelper.readProperties(batch));
            }
            // Publish the complete poll once, avoiding transient combinations
            // of a new robot state and the previous station countdown/state.
            this.parseAndUpdateState(properties);
            return this.state;
        })();
        try {
            return await this.pollInFlight;
        } finally {
            this.pollInFlight = null;
        }
    }

    /** Bounded, read-only preflight; never joins a potentially retrying UI poll. */
    async refreshDockState() {
        const pairs = [[2, 1], [2, 2], [3, 1], [3, 2], [4, 25], [15, 5], [4, 53], [4, 6], [27, 1], [27, 2], [27, 3], [4, 7]];
        const properties = [];
        for (let i = 0; i < pairs.length; i += 8) {
            const batch = pairs.slice(i, i + 8);
            const result = await this.sendCommand("get_properties", batch.map(([siid, piid]) => ({did: this.deviceId, siid: siid, piid: piid})),
                {timeout: 1000, noRetry: true});
            if (!Array.isArray(result) || !batch.every(([s, p]) => result.some(row => row.siid === s && row.piid === p && row.code === 0 && Number.isInteger(row.value)))) {
                throw new Error("Station state or attachment telemetry is incomplete; no action sent");
            }
            properties.push(...result);
        }
        this.parseAndUpdateState(properties);
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
            const response = await this.sendCommand("get_properties", [[2, 1], [2, 2], [3, 2]].map(([siid, piid]) => ({
                did: this.deviceId, siid: siid, piid: piid
            })), {timeout: 700, noRetry: options.noRetry ?? true});
            if (!Array.isArray(response) || ![[2, 1], [2, 2], [3, 2]].every(([siid, piid]) => response.some(p =>
                p?.siid === siid && p.piid === piid && p.code === 0 && Number.isInteger(p.value) && p.value >= 0))) {
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
        const charging = this.d103State.find(p => p.siid === 3 && p.piid === 2)?.value;
        const dockMopReminder = D103.isDockMopReminder(status, fault, charging);
        const dockTrayReminder = D103.isDockTrayReminder(status, fault, charging);
        const effectiveFault = dockMopReminder || dockTrayReminder ? 0 : fault;
        const age = performance.now() - Math.min(this.lastStateAt, this.lastFaultAt);
        const dock = this.state.getFirstMatchingAttribute({attributeClass: "DockStatusStateAttribute"})?.value;
        const stationBusy = ["drying", "cleaning", "emptying"].includes(dock);
        const ready = effectiveFault === 0 && !stationBusy && !this.stationActionPending && [2, 3, 6, 13, 21, 23].includes(status) && age <= 10000;
        const stationReason = ({drying: "Mops are drying", cleaning: "The station is washing the mops",
            emptying: "The station is emptying the dustbin", pause: "The station operation is paused"})[dock];
        const reason = ready ? null : this.stationActionPending ? "A station request is awaiting acknowledgement" :
            age > 10000 ? "Robot state is stale; waiting for fresh telemetry" :
                effectiveFault > 0 ? `Robot fault ${effectiveFault}; check the robot` :
                    stationReason ? `${stationReason}; manual driving is unavailable during station work` :
                        "Manual driving requires an idle, paused or docked robot";
        return {status: status ?? null, fault: fault ?? null, effectiveFault: effectiveFault ?? null,
            dockMopReminder: dockMopReminder,
            dockTrayReminder: dockTrayReminder,
            ageMs: Number.isFinite(age) ? Math.round(age) : null,
            ready: ready, reason: reason,
            cameraReady: effectiveFault === 0 && [2, 3, 6, 8, 13, 21, 23].includes(status) && age <= 10000,
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
                    message: parsed.status.fault ? (() => {
                        // Dreame family descriptions are indicative; the D103CN
                        // MIOT specification does not define the fault values.
                        const descriptions = require("./D103CNErrorDescriptions.json");
                        const description = descriptions[String(parsed.status.fault)];
                        return description ? `${description} (Dreame code ${parsed.status.fault})` :
                            `Unknown D103CN fault ${parsed.status.fault}; check the robot`;
                    })() : "D103CN unknown/error state; check robot"
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
        for (const [raw, index, presets, type] of [
            [parsed.fan, parsed.fan, FAN_PRESETS, "fan_speed"],
            [parsed.water, parsed.water - 1, WATER_PRESETS, "water_grade"]
        ]) {
            if (presets[index]) {
                // The upstream room/zone encoders reuse the native setting,
                // not the display preset name or a fallback medium value.
                this.state.upsertFirstMatchingAttribute(new attrs.PresetSelectionStateAttribute({
                    type: type, value: presets[index], metaData: {rawValue: raw}
                }));
            }
        }
        if (parsed.dock) {
            // Match upstream Dreame's dock composition: the active auto-empty
            // state takes precedence over the mop dock's wash/dry/pause state.
            // 15/3 is availability, NOT the running state; use 15/5 here.
            const mopDock = DreameValetudoRobot.MOP_DOCK_STATUS_MAP[parsed.station.mopDockStatus];
            const autoEmpty = DreameValetudoRobot.AUTO_EMPTY_DOCK_STATUS_MAP[parsed.station.autoEmptyState];
            const value = autoEmpty && autoEmpty !== "idle" ? autoEmpty : mopDock ?? parsed.dock;
            const remaining = parsed.station.dryingRemainingMinutes;
            const progress = parsed.station.dryingProgressPercent;
            this.state.upsertFirstMatchingAttribute(new attrs.DockStatusStateAttribute({value: value, metaData: {
                mopDockStatus: parsed.station.mopDockStatus, autoEmptyState: parsed.station.autoEmptyState,
                ...(value === "drying" && Number.isInteger(remaining) && remaining > 0 && remaining <= 1440 ?
                    {dryingRemainingMinutes: remaining} : {}),
                ...(value === "drying" && Number.isInteger(progress) && progress >= 0 && progress <= 100 ?
                    {dryingProgressPercent: progress} : {})
            }}));
        }
        if ([0, 1].includes(parsed.attachments.mop)) {
            this.state.upsertFirstMatchingAttribute(new attrs.AttachmentStateAttribute({type: "mop", attached: parsed.attachments.mop === 0}));
        }
        if (Number.isInteger(parsed.attachments.watertank) && parsed.attachments.watertank >= 0) {
            this.state.upsertFirstMatchingAttribute(new attrs.AttachmentStateAttribute({type: "watertank", attached: parsed.attachments.watertank !== 0}));
        }
        for (const [type, raw] of Object.entries(parsed.dockComponents)) {
            const values = type === "water_tank_clean" ? {0: "ok", 1: "missing", 2: "empty"} :
                type === "water_tank_dirty" ? {0: "ok", 1: "full"} : {0: "ok", 1: "missing", 2: "full"};
            if (Number.isInteger(raw)) {
                this.state.upsertFirstMatchingAttribute(new attrs.DockComponentStateAttribute({type: type, value: values[raw] ?? "unknown"}));
            }
        }
        this.lastDiagnostics = parsed.diagnostics;
        this.emitStateAttributesUpdated();
    }

    startup() {
        // Intentionally do not call MiioValetudoRobot.startup(): it prints DID and both secrets.
        Logger.info("Experimental Xiaomi Mijia M30S / D103CN profile; secrets redacted");
        Logger.info(`D103CN controls=${this.implConfig.allowControls === true}, mapPolling=${this.implConfig.enableMapPolling === true}`);
        this.capabilities.GoToLocationCapability?.startRecovery();
        if (this.implConfig.enableMapPolling === true) {
            this.pollMap();
        }
    }

    onCloudConnected() {
        // Upstream fires this even on an empty/unauthenticated datagram. Do not call that auth success.
        Logger.info("D103CN cloud UDP transport seen; authenticated messages still required");
        if (this.implConfig.enableMapPolling === true && this.implConfig.enableLegacyCloudMapPolling === true) {
            this.mapCloudConnectedAt = Date.now();
            clearTimeout(this.mapBootstrapTimer);
            this.mapBootstrapTimer = setTimeout(() => this.pollMap(), 5000);
            this.mapBootstrapTimer.unref();
            clearTimeout(this.mapFullFrameTimer);
            // The factory FDS cache survives an SDK handover. Its old object
            // acknowledgement does not deliver that frame to a new Valetudo.
            // Respect the native 30-second I-frame throttle before refreshing.
            this.mapFullFrameTimer = setTimeout(() => this.pollMap(), 40000);
            this.mapFullFrameTimer.unref();
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
        const refresh = this.mapCloudConnectedAt > 0 &&
            this.mapLastPollAt - this.mapCloudConnectedAt >= 35000 &&
            this.mapLastPollAt - this.lastLiveMapAt > 60000 &&
            this.mapLastPollAt - this.mapLastRefreshAt > 30000;
        if (refresh) {
            this.mapLastRefreshAt = this.mapLastPollAt;
        }
        let result;
        try {
            result = await this.sendCommand("action", {did: this.deviceId, siid: 6, aiid: 1,
                in: [{piid: 2, value: refresh ? '{"frame_type":"I","req_type":2}' :
                    '{"frame_type":"I", "force_type":1, "req_type":1}'}]},
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
            // Same non-map upload types ignored by upstream DreameValetudoRobot.
            // Keep private multi-map metadata out of public application logs.
            if (Buffer.isBuffer(data) && (data[0] === 0x7b || data[0] === 0x5b ||
                (data[0] === 0x42 && data[1] === 0x5a && data[2] === 0x68))) {
                return;
            }
            await this.acceptMap(data);
        }
    }

    getManufacturer() {
        return "Xiaomi";
    }
    getModelDetails() {
        return {supportedAttachments: ["mop", "watertank"], supportedDockComponents: ["water_tank_clean", "water_tank_dirty", "dustbag"]};
    }

    async shutdown() {
        clearInterval(this.capabilities.GoToLocationCapability?.timer);
        clearTimeout(this.mapBootstrapTimer);
        clearTimeout(this.mapFullFrameTimer);
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
