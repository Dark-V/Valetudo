const AutoEmptyDockManualTriggerCapability = require("../../../core/capabilities/AutoEmptyDockManualTriggerCapability");
const DreameAutoEmptyDockManualTriggerCapability = require("./DreameAutoEmptyDockManualTriggerCapability");
const run = require("./D103CNStationControl");

/** @extends AutoEmptyDockManualTriggerCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNAutoEmptyDockManualTriggerCapability extends AutoEmptyDockManualTriggerCapability {
    constructor(options) {
        super(options);
        this.upstream = new DreameAutoEmptyDockManualTriggerCapability({robot: /** @type {any} */ (this.robot)});
    }
    async triggerAutoEmpty() {
        return run(this.robot, ["idle"], ["dustbag"], false, () => this.upstream.triggerAutoEmpty());
    }
}

module.exports = D103CNAutoEmptyDockManualTriggerCapability;
