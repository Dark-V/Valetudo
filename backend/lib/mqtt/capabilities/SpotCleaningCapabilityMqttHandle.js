const CapabilityMqttHandle = require("./CapabilityMqttHandle");
const DataType = require("../homie/DataType");
const PropertyMqttHandle = require("../handles/PropertyMqttHandle");

class SpotCleaningCapabilityMqttHandle extends CapabilityMqttHandle {
    /**
     * @param {object} options
     * @param {import("../handles/RobotMqttHandle")} options.parent
     * @param {import("../MqttController")} options.controller
     * @param {import("../../core/ValetudoRobot")} options.robot
     * @param {import("../../core/capabilities/SpotCleaningCapability")} options.capability
     */
    constructor(options) {
        super(Object.assign(options, {friendlyName: "Spot cleaning"}));
        this.capability = options.capability;
        this.registerChild(new PropertyMqttHandle({
            parent: this, controller: this.controller, topicName: "clean", friendlyName: "Spot cleaning",
            datatype: DataType.STRING, format: "same json as the REST interface",
            setter: async value => {
                if (value.length > 4096) {
                    throw new Error("Spot cleaning payload is too long");
                }
                const request = JSON.parse(value);
                if (!request || request.action !== "clean" || !request.coordinates ||
                    !Number.isFinite(request.coordinates.x) || !Number.isFinite(request.coordinates.y)) {
                    throw new Error("Invalid spot cleaning payload");
                }
                await this.capability.start({coordinates: request.coordinates, iterations: request.iterations ?? 1});
            },
            helpText: "Accepts the same JSON as the SpotCleaningCapability REST API. " +
                "Select Spot on the live map, tap a point and long-press Spot clean to copy the payload."
        }));
    }
}

SpotCleaningCapabilityMqttHandle.OPTIONAL = false;
module.exports = SpotCleaningCapabilityMqttHandle;
