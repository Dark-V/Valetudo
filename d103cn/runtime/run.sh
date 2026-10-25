#!/bin/sh
# Foreground supervisor. No timer, restart loop, init hook or factory writes.
set -eu
umask 077
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
[ "$BASE" = /data/.valetudo ] || { echo 'STOP: expected /data/.valetudo'; exit 1; }
[ "$#" -eq 0 ] || { echo 'STOP: no arguments accepted'; exit 1; }
[ "$(id -u)" = 0 ] && [ "$(uname -m)" = armv7l ]
grep -qx 'model=xiaomi.vacuum.d103cn' /data/config/miio/device.conf
cd "$BASE"
sha256sum -c SHA256SUMS >/dev/null || { echo 'STOP: package integrity failure'; exit 1; }
[ -f /data/config/miio/wifi.conf ] || { echo 'STOP: missing stock Wi-Fi config; do not reset SDK blindly'; exit 1; }
[ -r /data/config/miio/device.token ]
for f in /sys/class/thermal/thermal_zone*/temp; do
 [ -r "$f" ] || continue
 t=$(cat "$f")
 case "$t" in ''|*[!0-9]*) echo 'STOP: invalid temperature'; exit 1;; esac
 [ "$t" -lt 85000 ] || { echo 'STOP: temperature >=85 C'; exit 1; }
done
available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
[ "${available:-0}" -ge 196608 ] || { echo 'STOP: insufficient available RAM'; exit 1; }
ip=$(ip -4 addr show dev wlan0 2>/dev/null | awk '$1=="inet" {split($2,a,"/"); print a[1]; exit}')
printf '%s\n' "$ip" | awk -F. 'NF!=4 {exit 1} {for(i=1;i<=4;i++) if($i!~/^[0-9]+$/ || $i>255) exit 1; if($1==0 || $1==127 || $1>=224) exit 1}'
if netstat -lnut 2>/dev/null | awk '$4 ~ /:(18080|8053|8079)$/ {found=1} END {exit !found}'; then
 echo 'STOP: a required port is already occupied; nothing killed'; exit 1
fi
exec /bin/sh "$BASE/dreame-sdk/prepare-runtime.sh"
