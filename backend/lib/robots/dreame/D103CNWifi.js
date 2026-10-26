const crypto = require("crypto");
const fs = require("fs");
const {execFile, spawn} = require("child_process");
const {promisify} = require("util");

const execute = promisify(execFile);
const ROOT = "/data/.valetudo/wifi-transaction";

async function run(file, args) {
    try {
        const result = await execute(file, args, {timeout: 5000, maxBuffer: 131072, encoding: "utf8"});
        return result.stdout;
    } catch (_) {
        // execFile errors include stdout/stderr and arguments. Do not leak them.
        throw new Error("Native Wi-Fi tool failed");
    }
}

async function status() {
    const fields = {};
    const raw = await run("/usr/bin/wpa_cli", ["-i", "wlan0", "status"]);
    for (const line of raw.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) {
            fields[line.slice(0, i)] = line.slice(i + 1);
        }
    }
    const details = {};
    if (fields.wpa_state === "COMPLETED") {
        details.ssid = fields.ssid;
        details.bssid = fields.bssid;
        details.frequency = "2.4ghz";
        details.ips = fields.ip_address ? [fields.ip_address] : [];
        return {state: "connected", details: details};
    }
    return {state: "not_connected", details: details};
}

function transactionState() {
    try {
        const value = fs.readFileSync(ROOT + "/state", "utf8").trim();
        return ["queued", "stopping", "connecting", "connected", "rolling_back", "restored", "ap_recovery", "failed"].includes(value) ? value : "unknown";
    } catch (_) {
        return "none";
    }
}

async function configure(config) {
    const ssid = config.ssid;
    const password = config.credentials?.typeSpecificSettings?.password;
    // The factory MJAC shell parser strips quotes and does not preserve arbitrary
    // SSIDs. Do not claim support for names it cannot safely round-trip.
    if (typeof ssid !== "string" || Buffer.byteLength(ssid) < 1 || Buffer.byteLength(ssid) > 32 ||
        /[^\x20-\x7e]|["'\\$`]/.test(ssid) || ssid.trim() !== ssid ||
        config.credentials?.type !== "wpa2_psk" || typeof password !== "string" ||
        Array.from(password).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        !(/^[a-fA-F0-9]{64}$/.test(password) || Buffer.byteLength(password) >= 8 && Buffer.byteLength(password) <= 63)) {
        throw new Error("Use a 1-32 byte ASCII SSID without quotes, backslashes, dollar/backtick or edge spaces, and a WPA2 passphrase (8-63 bytes) or 64-digit hex PSK");
    }
    for (const file of ["/usr/bin/wifi_setup.sh", "/usr/bin/wpa_cli", "/data/.valetudo/start.sh", "/data/.valetudo/stop.sh"]) {
        if (!fs.existsSync(file)) {
            throw new Error("Required native Wi-Fi/recovery tools missing");
        }
    }
    const busy = ["queued", "stopping", "connecting", "rolling_back"].includes(transactionState());
    if (busy) {
        throw new Error("A Wi-Fi change is already pending; inspect recovery status before retrying");
    }
    if (fs.existsSync(ROOT) && (!fs.lstatSync(ROOT).isDirectory() || fs.lstatSync(ROOT).isSymbolicLink())) {
        throw new Error("Invalid Wi-Fi transaction directory");
    }
    fs.mkdirSync(ROOT, {mode: 0o700, recursive: true});
    fs.chmodSync(ROOT, 0o700);
    try {
        const fd = fs.openSync(ROOT + "/request.lock", "wx", 0o600);
        fs.closeSync(fd);
    } catch (_) {
        throw new Error("Wi-Fi recovery lock exists; inspect the pending transaction before retrying");
    }
    try {
        // Retain only a derived PSK. The reversible MJAC marker contains that
        // PSK, not the owner's original router passphrase.
        const psk = /^[a-fA-F0-9]{64}$/.test(password) ? password.toLowerCase() :
            crypto.pbkdf2Sync(password, ssid, 4096, 32, "sha1").toString("hex");
        const wifi = `ssid="${ssid}"\npsk=${psk}\nkey_mgmt=WPA-PSK\n#pwd_b64=${Buffer.from(psk).toString("base64")}\n#d103_pwd_b64_representation=raw_psk_hex\n`;
        const wpa = `ctrl_interface=/var/run/wpa_supplicant\nupdate_config=1\nnetwork={\n ssid=${Buffer.from(ssid).toString("hex")}\n psk=${psk}\n key_mgmt=WPA-PSK\n proto=RSN\n scan_ssid=1\n}\n`;
        for (const [name, value] of Object.entries({"new-wifi": wifi, "new-wpa": wpa, "target-ssid": ssid, "worker.sh": WORKER, state: "queued\n"})) {
            fs.writeFileSync(ROOT + "/" + name, value, {mode: 0o600});
            fs.chmodSync(ROOT + "/" + name, 0o600);
        }
        const child = spawn("/bin/sh", [ROOT + "/worker.sh"], {detached: true, stdio: "ignore"});
        await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", () => reject(new Error("Could not start Wi-Fi recovery worker")));
        });
        child.unref();
    } catch (_) {
        for (const name of ["new-wifi", "new-wpa", "target-ssid", "request.lock"]) {
            try {
                fs.unlinkSync(ROOT + "/" + name);
            } catch (_) { /* absent */ }
        }
        fs.writeFileSync(ROOT + "/state", "failed\n", {mode: 0o600});
        throw new Error("Could not prepare Wi-Fi change; no network settings applied");
    }
}

// Detached from Node so app shutdown and a lost HTTP/SSH session do not cancel
// recovery. Network scripts receive no credentials in argv or logs. Never call
// iot_sdk restart/reset; stock wifi_setup is the same network-only path already
// used on this device. The owner initiates switching from the UI, not startup.
const WORKER = `#!/bin/sh
set -eu
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
root=/data/.valetudo/wifi-transaction
cd "$root"
phase() { printf '%s\\n' "$1" >state.new; mv state.new state; }
finished=0
changed=0
had_wifi=0; had_wpa=0
atomic_copy() { dst=$2; t=$(mktemp "$dst.valetudo.XXXXXX"); cat "$1" >"$t"; chmod 600 "$t"; mv "$t" "$dst"; }
cleanup() {
 rc=$?
 trap - EXIT
 if [ -f old-autostart ]; then mv old-autostart /data/.valetudo/autostart.enabled || :; fi
 if [ "$finished" = 0 ]; then
  # Unexpected failure must not discard the only copies of the old settings.
  if [ "$changed" = 1 ]; then
   if [ "$had_wifi" = 1 ]; then atomic_copy old-wifi /data/config/miio/wifi.conf || :; else rm -f /data/config/miio/wifi.conf; fi
   if [ "$had_wpa" = 1 ]; then atomic_copy old-wpa /data/config/wifi/wpa_supplicant.conf || :; else rm -f /data/config/wifi/wpa_supplicant.conf; fi
   sync
   timeout 45 /usr/bin/wifi_setup.sh sta >/dev/null 2>&1 9>&- || :
  fi
  phase failed
  timeout 90 /bin/sh /data/.valetudo/start.sh >/dev/null 2>&1 9>&- || :
 else
  rm -f old-wifi old-wpa
 fi
 rm -f new-wifi new-wpa target-ssid request.lock
 exit "$rc"
}
trap cleanup EXIT
trap '' HUP
exec 9>worker.lock
flock -n 9 || exit 1
sleep 3
phase stopping
# DHCP can source the owner's network hook. Temporarily hold its enable marker
# so that a second Valetudo is not launched halfway through the transaction.
if [ -f /data/.valetudo/autostart.enabled ]; then
 mv /data/.valetudo/autostart.enabled old-autostart
fi
# Stop before changing wifi.conf: the old SDK supervisor can restore its
# protected startup copy while exiting. Require its terminal state first.
if ! timeout 90 /bin/sh /data/.valetudo/stop.sh >/dev/null 2>&1; then phase failed; exit 1; fi
if [ -e /tmp/d103-valetudo-manual.lock ]; then phase failed; exit 1; fi
for f in /data/config/miio/wifi.conf /data/config/wifi/wpa_supplicant.conf; do
 [ ! -L "$f" ] || { phase failed; exit 1; }
done
if [ -f /data/config/miio/wifi.conf ]; then cp -p /data/config/miio/wifi.conf old-wifi; had_wifi=1; fi
if [ -f /data/config/wifi/wpa_supplicant.conf ]; then cp -p /data/config/wifi/wpa_supplicant.conf old-wpa; had_wpa=1; fi
before=$(/usr/bin/wpa_cli -i wlan0 status 2>/dev/null | sed -n 's/^wpa_state=//p' || :)
changed=1
atomic_copy new-wifi /data/config/miio/wifi.conf
atomic_copy new-wpa /data/config/wifi/wpa_supplicant.conf
sync
target=$(cat target-ssid)
phase connecting
switch_sta() {
 # A stale config_net.flag alone is not a live AP watcher.
 if ps | grep '[d]o_start_ap.sh' >/dev/null && [ -f /tmp/config_net.flag ]; then
  printf STA >/tmp/config_net.flag
 else
  timeout 45 /usr/bin/wifi_setup.sh sta >/dev/null 2>&1 9>&- &
 fi
}
connected() {
 info=$(/usr/bin/wpa_cli -i wlan0 status 2>/dev/null || :)
 state=$(printf '%s\\n' "$info" | sed -n 's/^wpa_state=//p')
 ip=$(printf '%s\\n' "$info" | sed -n 's/^ip_address=//p')
 [ "$state" = COMPLETED ] && [ -n "$ip" ] && [ "$ip" != 0.0.0.0 ] && [ "$ip" != 192.168.5.1 ]
}
switch_sta
ok=0
for n in $(seq 1 45); do
 sleep 2
 if connected && [ "$(printf '%s\\n' "$info" | sed -n 's/^ssid=//p')" = "$target" ]; then ok=1; break; fi
done
if [ "$ok" = 1 ]; then
 [ ! -f /tmp/config_net.flag ] || printf OK >/tmp/config_net.flag
 phase connected
else
 phase rolling_back
 if [ "$had_wifi" = 1 ]; then atomic_copy old-wifi /data/config/miio/wifi.conf; else rm -f /data/config/miio/wifi.conf; fi
 if [ "$had_wpa" = 1 ]; then atomic_copy old-wpa /data/config/wifi/wpa_supplicant.conf; else rm -f /data/config/wifi/wpa_supplicant.conf; fi
 sync
 ok=0
 if [ "$before" = COMPLETED ] && [ "$had_wifi" = 1 ]; then
  switch_sta
  for n in $(seq 1 30); do sleep 2; if connected; then ok=1; break; fi; done
 fi
 if [ "$ok" = 1 ]; then
  [ ! -f /tmp/config_net.flag ] || printf OK >/tmp/config_net.flag
  phase restored
 else
  timeout 45 /usr/bin/wifi_setup.sh ap >/dev/null 2>&1 9>&- || :
  phase ap_recovery
 fi
fi
# Rebuild the local SDK bridge using the actual new address. No system reboot.
if [ -f old-autostart ]; then mv old-autostart /data/.valetudo/autostart.enabled; fi
timeout 90 /bin/sh /data/.valetudo/start.sh >/dev/null 2>&1 9>&- || :
finished=1
`;

module.exports = {run: run, status: status, configure: configure, transactionState: transactionState, WORKER: WORKER};
