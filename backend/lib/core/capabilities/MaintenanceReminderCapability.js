const Capability = require("./Capability");
const NotImplementedError = require("../NotImplementedError");

/**
 * @template {import("../ValetudoRobot")} T
 * @extends Capability<T>
 */
class MaintenanceReminderCapability extends Capability {
    /** @param {string} reminder */
    async acknowledge(reminder) {
        throw new NotImplementedError();
    }

    getType() {
        return MaintenanceReminderCapability.TYPE;
    }

    getProperties() {
        return {supportedReminders: []};
    }
}

MaintenanceReminderCapability.TYPE = "MaintenanceReminderCapability";
module.exports = MaintenanceReminderCapability;
