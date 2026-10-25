#!/bin/sh
# Prepare the tested local Dreame SDK/FDS chain; no firmware or Wi-Fi edits.
set -eu
umask 077
BASE=/data/.valetudo
SDK="$BASE/dreame-sdk"
[ "$#" = 0 ]
exec 8>/tmp/d103-native-map-runtime.lock
flock -n 8 || exit 0
[ "$(cat /data/config/miio/device.uid)" = 1337 ]
[ "$(jshon -e Uid -u < /data/config/ava/clean_log.json)" = 1337 ]
cd "$SDK"
sha256sum -c stock.sha256 >/dev/null
for n in $(seq 1 30); do
 old_sdk=$(pidof miio_client 2>/dev/null || :)
 old_helper=$(pidof miio_client_helper_nomqtt.sh 2>/dev/null || :)
 old_agent=$(pidof miio_agent 2>/dev/null || :)
 [ -z "$old_sdk" ] || [ -z "$old_helper" ] || [ -z "$old_agent" ] || break
 sleep 1
done
case "$old_sdk:$old_helper:$old_agent" in *' '*|:*|*::*|*:) exit 2;; esac
[ "$(readlink "/proc/$old_sdk/exe")" = /usr/bin/miio_client ]
[ "$(readlink "/proc/$old_agent/exe")" = /bin/miio_agent ]
STAGE=$(mktemp -d /tmp/d103-valetudo-manual.XXXXXX)
cd "$STAGE"
for f in miio_client libjson-c.so.2 helper-trial.sh namespace.sh supervisor.sh msg-cvt-trial.sh fds-hook-trial.sh; do
 cp -p "$SDK/$f" "$f"
done
cp "$SDK/stock.sha256" protected.sha256
cp "$SDK/hosts-local" hosts-local
cp "$SDK/nsswitch.conf" nsswitch.conf
touch continuous.enabled reconnect-iot.enabled plain-local-fds.enabled relay-local-connect.enabled
mkdir config original
for f in device.conf device.token wifi.conf; do cp -p "/data/config/miio/$f" "original/$f"; done
for f in device.token wifi.conf device.uid device.country device.tz; do
 [ ! -f "/data/config/miio/$f" ] || cp -p "/data/config/miio/$f" "config/$f"
done
sed -n '/^vendor=/p; /^model=/p; /^mac=/p' /data/config/miio/device.conf > config/device.conf
did=$(tr -d '\r\n' < /mnt/private/ULI/factory/did.txt)
key=$(tr -d '\r\n' < /mnt/private/ULI/factory/key.txt)
case "$did" in ''|*[!0-9]*) exit 2;; esac
case "$key" in ''|*[!A-Za-z0-9]*) exit 2;; esac
[ "${#key}" = 16 ]
printf 'did=%s\nkey=%s\n' "$did" "$key" >> config/device.conf
unset did key
cp -a /etc etc
[ ! -L etc/hosts ] || rm etc/hosts
[ ! -L etc/nsswitch.conf ] || rm etc/nsswitch.conf
cp hosts-local etc/hosts
cp nsswitch.conf etc/nsswitch.conf
ip=$(ip -4 addr show dev wlan0 | awk '$1=="inet" {split($2,a,"/"); print a[1]; exit}')
printf '%s\n' "$ip" | awk -F. 'NF!=4 {exit 1} {for(i=1;i<=4;i++) if($i!~/^[0-9]+$/ || $i>255) exit 1; if($1==0 || $1==127 || $1>=224) exit 1}'
sed "s/__D103_SELF_IP__/$ip/" "$BASE/config.template.json" > valetudo-config.json
printf 'OLD_SDK=%s\nSDK_TICKS=%s\nOLD_HELPER=%s\nHELPER_TICKS=%s\nOLD_AGENT=%s\nAGENT_TICKS=%s\n' \
 "$old_sdk" "$(awk '{print $22}' "/proc/$old_sdk/stat")" \
 "$old_helper" "$(awk '{print $22}' "/proc/$old_helper/stat")" \
 "$old_agent" "$(awk '{print $22}' "/proc/$old_agent/stat")" > ids.sh
for f in helper-trial.sh namespace.sh supervisor.sh msg-cvt-trial.sh fds-hook-trial.sh; do sh -n "$f"; done
echo "Starting local Dreame SDK/FDS runtime in $STAGE"
exec /bin/sh "$STAGE/supervisor.sh" "$STAGE"
