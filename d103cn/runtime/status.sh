#!/bin/sh
set -eu
LOCK=/tmp/d103-valetudo-manual.lock
[ -r "$LOCK/pid" ] && [ -r "$LOCK/start_ticks" ] || { echo 'NOT RUNNING'; exit 1; }
pid=$(cat "$LOCK/pid")
ticks=$(cat "$LOCK/start_ticks")
case "$pid:$ticks" in *[!0-9:]*|:*|*:) echo 'INVALID LOCK'; exit 1;; esac
[ "$(readlink "/proc/$pid/exe" 2>/dev/null || :)" = /data/.valetudo/valetudo ] &&
 [ "$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || :)" = "$ticks" ] || { echo 'NOT RUNNING (stale record)'; exit 1; }
ip=$(cat "$LOCK/ip")
echo "RUNNING pid=$pid; http://$ip:18080/"
