const PendingMapChangeHandlingCapability = require("../../../core/capabilities/PendingMapChangeHandlingCapability");
const RobotFirmwareError = require("../../../core/RobotFirmwareError");

/** @extends PendingMapChangeHandlingCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNPendingMapChangeHandlingCapability extends PendingMapChangeHandlingCapability {
    async hasPendingChange() {
        return this.robot.state.map.metaData.dreamePendingMapChange === true &&
            Date.now() - this.robot.lastLiveMapAt < 120000;
    }

    async acceptChange() {
        // Dreame cw=5 saves a new floor; cw=1 would replace an existing map.
        return this.commitChoice(5);
    }

    async rejectChange() {
        return this.commitChoice(0);
    }

    /** @param {number} choice */
    async commitChoice(choice) {
        if (!await this.hasPendingChange()) {
            throw new Error("No recent new map is waiting to be saved");
        }
        await this.robot.refreshControlState();
        const state = this.robot.getControlReadiness();
        if (![2, 3, 6, 8, 9, 13].includes(state.status) || state.effectiveFault !== 0) {
            throw new Error("Finish the current robot task before saving a map");
        }
        if (choice === 5 && await this.robot.miotHelper.readProperty(6, 7) !== 1) {
            throw new Error("Enable native multi-floor maps before saving a new map");
        }
        const result = await this.robot.sendCommand("action", {
            did: this.robot.deviceId, siid: 6, aiid: 2,
            in: [{piid: 4, value: JSON.stringify({cw: choice})}]
        }, {timeout: 5000, noRetry: true});
        if (result?.code !== 0 || result.out[0].value !== 0) {
            throw new RobotFirmwareError("The firmware did not accept the new-map choice");
        }
        this.markEventsAsProcessed();
        this.robot.pollMap();
    }
}

module.exports = D103CNPendingMapChangeHandlingCapability;
