const D103 = require("../D103CNProtocol");
const HighResolutionManualControlCapability = require("../../../core/capabilities/HighResolutionManualControlCapability");
const Logger = require("../../../Logger");

/**
 * Owner-device joystick. Construction and state queries never issue commands.
 * @extends HighResolutionManualControlCapability<import("../DreameMijiaM30SValetudoRobot")>
 */
class D103CNHighResolutionManualControlCapability extends HighResolutionManualControlCapability {
    /** @param {{robot: import("../DreameMijiaM30SValetudoRobot")}} options */
    constructor(options) {
        super(options);
        this.active = false;
        this.enabling = false;
        this.session = 0;
        this.moving = false;
        this.lastInput = 0;
        this.lastSent = 0;
        /** @type {Promise<void>|null} */
        this.pending = null;
        /** @type {Promise<void>|null} */
        this.stopping = null;
        this.timer = undefined;
        this.watchdogBusy = false;
        this.lastError = null;
        this.lastAckAt = 0;
        this.lastAckLatencyMs = null;
    }

    assertReady() {
        const readiness = this.robot.getControlReadiness();
        if (!readiness.ready) {
            throw new Error(readiness.reason ?? "Manual control is not ready; refresh robot state");
        }
    }

    /** @param {string} payload */
    async write(payload) {
        if (this.pending) {
            throw new Error("D103CN manual channel busy; stale commands are not queued");
        }
        this.pending = (async () => {
            const began = performance.now();
            const vector = JSON.parse(payload);
            // Real stock trace: successful zero keepalive ACK arrived after 552 ms.
            // Stationary/stop ACKs get 1 s; moving ACKs stay below the 800 ms deadman.
            const timeout = vector.spdv === 0 && vector.spdw === 0 ? 1000 : 700;
            this.lastSent = began; // Keepalive cadence starts at dispatch, not at the delayed ACK.
            const result = await this.robot.sendCommand("set_properties", [{
                did: this.robot.deviceId, siid: 4, piid: 15, value: payload
            }], {timeout: timeout, noRetry: true});
            if (!Array.isArray(result) || result.length !== 1 || result[0].code !== 0) {
                const code = Number.isInteger(result?.[0]?.code) ? result[0].code : "invalid reply";
                throw new Error(`D103CN manual command rejected: ${code}`);
            }
            this.lastAckAt = performance.now();
            this.lastAckLatencyMs = Math.round(this.lastAckAt - began);
        })();
        try {
            await this.pending;
        } finally {
            this.pending = null;
        }
    }

    async enableManualControl() {
        if (this.active) {
            return;
        }
        if (this.enabling || this.stopping) {
            throw new Error("D103CN manual mode is changing");
        }
        this.enabling = true;
        this.lastError = null;
        const session = ++this.session;
        try {
            await this.robot.refreshControlState();
            this.assertReady();
            await this.robot.camera.factoryForManual();
            this.assertReady();
            await this.write(D103.manualPayload({velocity: 0, angle: 0}, true));
            if (session !== this.session || this.stopping) {
                throw new Error("D103CN manual enable cancelled");
            }
            this.active = true;
            this.robot.beginControlMonitoring("manual");
            this.moving = false;
            this.lastInput = performance.now();
            this.timer = setInterval(() => {
                this.watchdog().catch(e => Logger.warn("D103CN manual watchdog failure", {reason: e.message}));
            }, 100);
            this.timer.unref();
        } finally {
            this.enabling = false;
        }
    }

    async manualControlActive() {
        return this.active;
    }

    /** @param {import("../../../entities/core/ValetudoManualMovementVector")} vector */
    async manualControl(vector) {
        if (!this.active || this.stopping || this.pending) {
            throw new Error("D103CN manual control is disabled or busy");
        }
        // Validate before changing the watchdog input timestamp.
        const payload = D103.manualPayload(vector);
        try {
            this.assertReady();
            this.lastInput = performance.now();
            await this.write(payload);
            this.moving = vector.velocity !== 0 || vector.angle !== 0;
        } catch (e) {
            this.lastError = e.message;
            await this.disableManualControl().catch(() => Logger.warn("D103CN manual error stop was not acknowledged"));
            throw e;
        }
    }

    async watchdog() {
        if (!this.active || this.watchdogBusy) {
            return;
        }
        this.watchdogBusy = true;
        try {
            this.assertReady();
            if (this.moving && performance.now() - this.lastInput >= D103.MANUAL_LIMITS.deadmanMs) {
                await this.disableManualControl();
            } else if (!this.moving && !this.pending && performance.now() - this.lastSent >= 700) {
                await this.write(D103.manualPayload({velocity: 0, angle: 0}));
            }
        } catch (e) {
            this.lastError = e.message;
            await this.disableManualControl();
            throw e;
        } finally {
            this.watchdogBusy = false;
        }
    }

    async disableManualControl() {
        if (this.stopping) {
            return this.stopping;
        }
        if (!this.active && !this.enabling && !this.pending) {
            return;
        }
        this.active = false;
        this.robot.endControlMonitoring("manual");
        this.session++;
        this.moving = false;
        clearInterval(this.timer);
        this.timer = undefined;
        this.stopping = (async () => {
            if (this.pending) {
                await this.pending.catch(() => {});
            }
            let lastError;
            for (let n = 0; n < 3; n++) {
                try {
                    await this.write(D103.manualPayload({velocity: 0, angle: 0}));
                    return;
                } catch (e) {
                    lastError = e;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
            throw lastError;
        })();
        try {
            await this.stopping;
        } finally {
            this.stopping = null;
        }
    }

    getProperties() {
        return {experimental: true, cameraRequired: false, liveCamera: this.robot.camera.state().available,
            maxLinearCommand: D103.MANUAL_LIMITS.velocity,
            maxAngularCommand: D103.MANUAL_LIMITS.rotation, deadmanTimeoutMs: D103.MANUAL_LIMITS.deadmanMs,
            movingAckTimeoutMs: 700, stationaryAckTimeoutMs: 1000,
            motionTested: false};
    }

    getDiagnostics() {
        return {error: this.lastError, pending: !!this.pending, moving: this.moving,
            readiness: this.robot.getControlReadiness(),
            lastAckLatencyMs: this.lastAckLatencyMs,
            lastAckAgeMs: this.lastAckAt ? Math.round(performance.now() - this.lastAckAt) : null};
    }
}

module.exports = D103CNHighResolutionManualControlCapability;
