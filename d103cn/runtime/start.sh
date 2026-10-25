#!/bin/sh
set -eu
[ "$#" -eq 0 ] || { echo 'STOP: no arguments accepted'; exit 1; }
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
[ "$BASE" = /data/.valetudo ]
if "$BASE/status.sh" >/dev/null 2>&1; then
 "$BASE/status.sh"
 exit 0
fi
[ ! -d /tmp/d103-valetudo-manual.lock ] || { echo 'STOP: stale/starting lock; inspect, do not delete blindly'; exit 1; }
umask 077
nohup /bin/sh "$BASE/run.sh" >/tmp/d103-valetudo-manual-launch.log 2>&1 </dev/null &
supervisor=$!
for n in 1 2 3 4 5 6 7 8 9 10; do
 if "$BASE/status.sh"; then exit 0; fi
 kill -0 "$supervisor" 2>/dev/null || { echo 'START FAILED: inspect /tmp/d103-valetudo-manual-launch.log'; exit 1; }
 sleep 1
done
echo 'START pending; inspect status and /tmp/d103-valetudo-manual-launch.log'
