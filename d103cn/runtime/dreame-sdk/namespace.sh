#!/bin/sh
# Run inside a private mount namespace, with the real stock robot IPC/network.
set -eu
umask 077
STAGE=$1
case "$STAGE" in /tmp/d103-upstream-trial.??????|/tmp/d103-valetudo-manual.??????) ;; *) exit 2;; esac
[ "$#" = 1 ]
mount -o bind "$STAGE/etc" /etc
mount -o bind "$STAGE/config" /data/config/miio
printf '%s\n' "$$" > "$STAGE/namespace.pid"
export LD_LIBRARY_PATH="$STAGE"
export D103_SDK_TRIAL_DIR="$STAGE"
helper_log="$STAGE/helper.stdout.private.log"
sdk_log="$STAGE/sdk.stdout.private.log"
agent_log="$STAGE/agent.stdout.private.log"
if [ -f "$STAGE/continuous.enabled" ]; then helper_log=/dev/null; sdk_log=/dev/null; agent_log=/dev/null; fi
/bin/sh "$STAGE/helper-trial.sh" >"$helper_log" 2>&1 &
printf '%s\n' "$!" > "$STAGE/helper.pid"
"$STAGE/miio_client" -d/etc/miio/ -l0 >"$sdk_log" 2>&1 &
sdk=$!
printf '%s\n' "$sdk" > "$STAGE/sdk.pid"
sleep 1
/bin/miio_agent -D -l0 >"$agent_log" 2>&1
agent=$(pidof miio_agent)
case "$agent" in ''|*' '*) exit 2;; esac
printf '%s\n' "$agent" > "$STAGE/agent.pid"
awk '{print $22}' "/proc/$agent/stat" > "$STAGE/agent.ticks"
wait "$sdk"
