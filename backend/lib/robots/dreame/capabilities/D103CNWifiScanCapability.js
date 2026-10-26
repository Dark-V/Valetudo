const ValetudoWifiNetwork = require("../../../entities/core/ValetudoWifiNetwork");
const Wifi = require("../D103CNWifi");
const WifiScanCapability = require("../../../core/capabilities/WifiScanCapability");

class D103CNWifiScanCapability extends WifiScanCapability {
    async scan() {
        // Read the supplicant's scan cache. A page visit must not interrupt the
        // live link by forcing the vendor driver into a new radio scan.
        let raw;
        try {
            raw = await Wifi.run("/usr/bin/wpa_cli", ["-i", "wlan0", "scan_results"]);
        } catch (e) {
            if ((await Wifi.status()).details.ips?.includes("192.168.5.1")) {
                return [];
            }
            throw e;
        }
        return raw.split("\n").flatMap(line => {
            const fields = line.split("\t");
            if (fields.length < 5 || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(fields[0])) {
                return [];
            }
            const signal = Number(fields[2]);
            return [new ValetudoWifiNetwork({bssid: fields[0], details: {ssid: fields.slice(4).join("\t"),
                ...(Number.isFinite(signal) ? {signal: signal} : {})}})];
        }).slice(0, 50);
    }
}
module.exports = D103CNWifiScanCapability;
