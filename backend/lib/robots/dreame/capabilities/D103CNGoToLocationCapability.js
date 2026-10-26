const DreameAICameraGoToLocationCapability = require("./DreameAICameraGoToLocationCapability");

/** Reuses the upstream native mode-23 tpoint encoder; never substitutes cleaning. */
class D103CNGoToLocationCapability extends DreameAICameraGoToLocationCapability {
    constructor(options) {
        super(options);
        /** @type {import("../DreameMijiaM30SValetudoRobot")} */
        this.d103Robot = options.robot;
    }
    async goTo(target) {
        const point = target?.coordinates;
        if (!point || ![point.x, point.y].every(n => Number.isFinite(n) && n >= 0 && n <= 5120)) {
            throw new Error("Go-to target must be inside the Valetudo map coordinate range");
        }
        await this.d103Robot.refreshDockState();
        const ready = this.d103Robot.getControlReadiness();
        if (!ready.ready || ![2, 3, 6, 13].includes(ready.status)) {
            throw new Error(ready.reason ?? "Go-to requires an idle, paused or docked robot");
        }
        const battery = this.robot.state.getFirstMatchingAttribute({attributeClass: "BatteryStateAttribute"});
        if (!Number.isFinite(battery?.level) || battery.level < 15) {
            throw new Error("Charge the robot above 15% before sending it to a point");
        }
        if (this.d103Robot.stationActionPending || this.d103Robot.state.map.metaData.savedMapSnapshot === true) {
            throw new Error("Go-to requires the current live map and no pending station request");
        }
        await super.goTo(target);
    }
}

module.exports = D103CNGoToLocationCapability;
