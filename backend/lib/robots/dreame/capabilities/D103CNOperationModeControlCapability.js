const D103 = require("../D103CNProtocol");
const OperationModeControlCapability = require("../../../core/capabilities/OperationModeControlCapability");

/** @extends OperationModeControlCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNOperationModeControlCapability extends OperationModeControlCapability {
    constructor(options) {
        super(options);
        this.changing = false;
    }

    /**
     * Change only the mode; never start a task or overwrite the other packed settings.
     * @param {string} preset
     */
    async selectPreset(preset) {
        if (!this.presets.some(p => p.name === preset)) {
            throw new Error("Invalid operation mode");
        }
        if (this.changing) {
            throw new Error("Operation mode change already in progress");
        }
        this.changing = true;
        try {
            await this.robot.refreshControlState({noRetry: false, force: true});
            const readiness = this.robot.getControlReadiness();
            // Mode selection is a settings write, not manual driving. A dock's
            // drying cycle does not prevent preparing the next cleaning mode.
            if (readiness.fault !== 0 || readiness.ageMs === null || readiness.ageMs > 2000 ||
                ![2, 6, 8, 13].includes(readiness.status) || this.robot.camera.state().running) {
                throw new Error("Stop the current task and camera before changing the cleaning mode");
            }
            const current = await this.robot.miotHelper.readProperty(4, 23);
            const value = D103.withOperationMode(current, preset);
            if (value !== current) {
                await this.robot.miotHelper.writeProperty(4, 23, value);
            }
            for (const waitMs of [100, 300, 700]) {
                if (value !== current) {
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
                const actual = await this.robot.miotHelper.readProperty(4, 23);
                if (actual === value) {
                    this.robot.parseAndUpdateState([{siid: 4, piid: 23, code: 0, value: actual}]);
                    return;
                }
                if (actual !== current) {
                    throw new Error("Firmware returned different clean settings; no further writes performed");
                }
            }
            throw new Error("Firmware did not confirm the requested cleaning mode");
        } finally {
            this.changing = false;
        }
    }
}

module.exports = D103CNOperationModeControlCapability;
