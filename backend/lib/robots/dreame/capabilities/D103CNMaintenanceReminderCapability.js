const MaintenanceReminderCapability = require("../../../core/capabilities/MaintenanceReminderCapability");
const {sleep} = require("../../../utils/misc");

/** @extends MaintenanceReminderCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNMaintenanceReminderCapability extends MaintenanceReminderCapability {
    getProperties() {
        return {supportedReminders: ["mop_tray"]};
    }

    async acknowledge(reminder) {
        if (reminder !== "mop_tray") {
            throw new Error("Unsupported maintenance reminder");
        }
        const robot = this.robot;
        if (robot.stationActionPending || robot.capabilities.HighResolutionManualControlCapability?.active ||
            robot.capabilities.HighResolutionManualControlCapability?.enabling) {
            throw new Error("Wait for the current control request to finish");
        }
        robot.stationActionPending = true;
        try {
            await robot.refreshDockState();
            const value = (siid, piid) => robot.d103State.find(p => p.siid === siid && p.piid === piid)?.value;
            if (value(2, 2) !== 114) {
                // Already gone: retain the real current status, never clear a
                // different warning to satisfy an outdated browser button.
                return;
            }
            if (![6, 8, 13].includes(value(2, 1)) || value(3, 2) !== 1 || value(4, 7) !== 0) {
                throw new Error("Acknowledge tray cleaning while docked, charging and without an unfinished cleaning task");
            }
            // Factory MsgClean::ActClearWarn is registered as action 3 and
            // consumes piid 10 as a JSON string. Same encoder as Dreame's
            // clear_warning; target only this maintenance code, never all errors.
            await robot.miotHelper.executeAction(4, 3, [{piid: 10, value: "[114]"}]);
            for (const delay of [200, 500, 1000]) {
                await sleep(delay);
                await robot.refreshDockState();
                if (value(2, 2) !== 114) {
                    return;
                }
            }
            throw new Error("The firmware has not cleared the tray reminder; it remains visible");
        } finally {
            robot.stationActionPending = false;
        }
    }
}

module.exports = D103CNMaintenanceReminderCapability;
