const DreameMopDockDryManualTriggerCapability = require("./DreameMopDockDryManualTriggerCapability");
const MopDockDryManualTriggerCapability = require("../../../core/capabilities/MopDockDryManualTriggerCapability");
const run = require("./D103CNStationControl");

/** @extends MopDockDryManualTriggerCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNMopDockDryManualTriggerCapability extends MopDockDryManualTriggerCapability {
    constructor(options) {
        super(options);
        this.upstream = new DreameMopDockDryManualTriggerCapability({robot: /** @type {any} */ (this.robot)});
    }
    async startDrying() {
        return run(this.robot, ["idle", "pause"], [], true, () => this.upstream.startDrying());
    }
    async stopDrying() {
        return run(this.robot, ["drying"], [], false, () => this.upstream.stopDrying());
    }
}

module.exports = D103CNMopDockDryManualTriggerCapability;
