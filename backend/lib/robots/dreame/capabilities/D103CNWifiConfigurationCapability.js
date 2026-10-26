const ValetudoWifiStatus = require("../../../entities/core/ValetudoWifiStatus");
const Wifi = require("../D103CNWifi");
const WifiConfigurationCapability = require("../../../core/capabilities/WifiConfigurationCapability");

/** @extends WifiConfigurationCapability<import("../DreameMijiaM30SValetudoRobot")> */
class D103CNWifiConfigurationCapability extends WifiConfigurationCapability {
    async getWifiStatus() {
        return new ValetudoWifiStatus(await Wifi.status());
    }
    async setWifiConfiguration(config) {
        await this.robot.refreshDockState();
        const value = (s, p) => this.robot.d103State.find(x => x.siid === s && x.piid === p)?.value;
        if (![2, 3, 6, 8, 13].includes(value(2, 1)) || value(4, 7) !== 0 ||
            this.robot.camera.child || this.robot.capabilities.HighResolutionManualControlCapability?.active ||
            this.robot.capabilities.HighResolutionManualControlCapability?.enabling) {
            throw new Error("Change Wi-Fi while stationary, without an unfinished task, camera or manual control session");
        }
        await Wifi.configure(config);
    }
    getProperties() {
        return {provisionedReconfigurationSupported: true, recoverySupported: true,
            recovery: {connectTimeoutSeconds: 90, rollbackTimeoutSeconds: 60, fallbackAddress: "192.168.5.1",
                phase: Wifi.transactionState()}, supportedBand: "2.4ghz", credentialsType: "wpa2_psk"};
    }
}
module.exports = D103CNWifiConfigurationCapability;
