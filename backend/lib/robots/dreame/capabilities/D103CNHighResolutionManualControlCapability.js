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
    }

    assertReady() {
        const status = this.robot.d103State.find(p => p.siid === 2 && p.piid === 1)?.value;
        const fault = this.robot.d103State.find(p => p.siid === 2 && p.piid === 2)?.value;
        if (fault !== 0 || ![2, 3, 6, 13, 23].includes(status) ||
            performance.now() - this.robot.lastStateAt > 10000) {
            throw new Error("D103CN manual control requires recent idle/paused/docked state without a fault");
        }
    }

    /** @param {string} payload */
    async write(payload) {
        if (this.pending) {
            throw new Error("D103CN manual channel busy; stale commands are not queued");
        }
        this.pending = (async () => {
            const result = await this.robot.sendCommand("set_properties", [{
                did: this.robot.deviceId, siid: 4, piid: 15, value: payload
            }], {timeout: 350, noRetry: true});
            if (!Array.isArray(result) || result.length !== 1 || result[0].code !== 0) {
                throw new Error("D103CN manual command was not acknowledged");
            }
            this.lastSent = performance.now();
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
        this.assertReady();
        this.enabling = true;
        const session = ++this.session;
        try {
            await this.robot.camera.factoryForManual();
            await this.write(D103.manualPayload({velocity: 0, angle: 0}, true));
            if (session !== this.session || this.stopping) {
                throw new Error("D103CN manual enable cancelled");
            }
            this.active = true;
            this.moving = false;
            this.lastInput = performance.now();
            this.timer = setInterval(() => {
                this.watchdog().catch(() => Logger.warn("D103CN manual watchdog stop was not acknowledged"));
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
            motionTested: false};
    }
}

module.exports = D103CNHighResolutionManualControlCapability;
