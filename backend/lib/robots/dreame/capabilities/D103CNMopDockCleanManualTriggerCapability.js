const DreameMopDockCleanManualTriggerCapability = require("./DreameMopDockCleanManualTriggerCapability");
const MopDockCleanManualTriggerCapability = require("../../../core/capabilities/MopDockCleanManualTriggerCapability");
const run = require("./D103CNStationControl");

/** @extends MopDockCleanManualTriggerCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNMopDockCleanManualTriggerCapability extends MopDockCleanManualTriggerCapability {
    constructor(options) {
        super(options);
        this.upstream = new DreameMopDockCleanManualTriggerCapability({robot: /** @type {any} */ (this.robot)});
    }
    async startCleaning() {
        return run(this.robot, ["idle", "pause"], ["water_tank_clean", "water_tank_dirty"], true, () => this.upstream.startCleaning());
    }
    async stopCleaning() {
        return run(this.robot, ["cleaning", "pause"], [], false, () => this.upstream.stopCleaning());
    }
}

module.exports = D103CNMopDockCleanManualTriggerCapability;
