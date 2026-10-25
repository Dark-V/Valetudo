#!/bin/sh
set -eu
[ "$#" -eq 0 ] || { echo 'STOP: no arguments accepted'; exit 1; }
LOCK=/tmp/d103-valetudo-manual.lock
[ -r "$LOCK/pid" ] && [ -r "$LOCK/start_ticks" ] || { echo 'NOT RUNNING (or start pending); nothing killed'; exit 0; }
pid=$(cat "$LOCK/pid")
ticks=$(cat "$LOCK/start_ticks")
case "$pid:$ticks" in *[!0-9:]*|:*|*:) echo 'STOP: invalid recorded PID/start time'; exit 1;; esac
ours() {
 [ "$(readlink "/proc/$pid/exe" 2>/dev/null || :)" = /data/.valetudo/valetudo ] &&
 [ "$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || :)" = "$ticks" ]
}
ours || { echo 'STOP: recorded PID does not identify this manual process; nothing killed'; exit 1; }
kill -TERM "$pid"
for n in 1 2 3 4 5 6 7 8 9 10; do
 ours || { echo 'STOPPED'; exit 0; }
 sleep 1
done
if ours; then kill -KILL "$pid"; fi
echo 'STOP requested for exact recorded process only; supervisor cleans its lock'
