#!/bin/sh
# Bounded actual-device trial. No factory restart/reset script is invoked.
set -eu
umask 077
STAGE=$1
case "$STAGE" in /tmp/d103-upstream-trial.??????|/tmp/d103-valetudo-manual.??????) ;; *) exit 2;; esac
[ "$#" = 1 ]
. "$STAGE/ids.sh"
continuous=0
[ ! -f "$STAGE/continuous.enabled" ] || continuous=1
LOCK=/tmp/d103-valetudo-manual.lock
lock_owned=0
changed=0
vt=
timer=
capture=
restart_mark=0
msg_guard=0
fds_overlay=0
iot_reconnect=0
relay_sent=0
iot_notify() {
 case "$1" in close_server|open_server) ;; *) return 2;; esac
 timeout 5 avacmd iot "{\"type\":\"iot\",\"notify\":\"$1\"}" >>"$STAGE/iot-transport.log" 2>&1
}
same() { [ -e "/proc/$1/stat" ] && [ "$(awk '{print $22}' "/proc/$1/stat")" = "$2" ]; }
stock_running() {
 for candidate_pid in $(pidof "$1" 2>/dev/null || :); do
  if [ "$(readlink "/proc/$candidate_pid/exe" 2>/dev/null || :)" = "$2" ] &&
   [ "$(awk '{print $3}' "/proc/$candidate_pid/stat" 2>/dev/null || :)" != Z ]; then return 0; fi
 done
 return 1
}
owns_bind() {
 awk -v target="$1" -v full="$STAGE/$2" -v relative="${STAGE#/tmp}/$2" '
  $5==target {root=$4}
  END {exit !(root==full || root==relative)}' /proc/self/mountinfo
}
helper_pids() {
 for d in /proc/[0-9]*; do
  [ -r "$d/comm" ] || continue
  c=$(cat "$d/comm" 2>/dev/null || :)
  case "$c" in sh|ash|miio_client_hel)
   if [ "$(tr '\000' '\n' < "$d/cmdline" 2>/dev/null | sed -n '2p')" = /usr/bin/miio_client_helper_nomqtt.sh ]; then printf '%s ' "${d##*/}"; fi;;
  esac
 done
}
stop_candidate() {
 if [ -r "$STAGE/agent.pid" ] && [ -r "$STAGE/agent.ticks" ]; then
  ap=$(cat "$STAGE/agent.pid"); at=$(cat "$STAGE/agent.ticks")
  if same "$ap" "$at"; then kill -TERM "$ap" 2>/dev/null || :; fi
 fi
 if [ -r "$STAGE/namespace.pid" ]; then
  ns=$(cat "$STAGE/namespace.pid")
  case "$ns" in ''|*[!0-9]*) return 1;; esac
  [ "$ns" -gt 1 ]
  if [ -e "/proc/$ns/stat" ] && [ "$(awk '{print $5}' "/proc/$ns/stat")" = "$ns" ]; then
   kill -TERM -- "-$ns" 2>/dev/null || :
  fi
 fi
 if [ -r "$STAGE/helper.pid" ]; then
  hp=$(cat "$STAGE/helper.pid")
  if [ -r "/proc/$hp/cmdline" ] && tr '\000' '\n' < "/proc/$hp/cmdline" | grep -qx "$STAGE/helper-trial.sh"; then
   kill -STOP "$hp" 2>/dev/null || :
   for p in $(pidof miio_recv_line 2>/dev/null || :); do
    if [ "$(awk '{print $4}' "/proc/$p/stat")" = "$hp" ]; then kill -TERM "$p" 2>/dev/null || :; fi
   done
   kill -KILL "$hp" 2>/dev/null || :
  fi
 fi
 # The daemon may have detached itself. Identify only this exact staged ELF.
 for p in $(pidof miio_client 2>/dev/null || :); do
  if [ "$(readlink "/proc/$p/exe" 2>/dev/null || :)" = "$STAGE/miio_client" ]; then
   kill -TERM "$p" 2>/dev/null || :
   sleep 1
   if [ "$(readlink "/proc/$p/exe" 2>/dev/null || :)" = "$STAGE/miio_client" ]; then kill -KILL "$p" 2>/dev/null || :; fi
  fi
 done
 if [ -r "$STAGE/agent.pid" ] && [ -r "$STAGE/agent.ticks" ]; then
  ap=$(cat "$STAGE/agent.pid"); at=$(cat "$STAGE/agent.ticks")
  if same "$ap" "$at"; then kill -KILL "$ap" 2>/dev/null || :; fi
  for n in $(seq 1 30); do
   [ -n "$(readlink "/proc/$ap/exe" 2>/dev/null || :)" ] || break
   same "$ap" "$at" || break
   usleep 100000
  done
 fi
}
cleanup() {
 code=$?
 trap - EXIT HUP INT TERM
 [ -z "$timer" ] || kill "$timer" 2>/dev/null || :
 if [ -n "$capture" ] && [ "$(readlink "/proc/$capture/exe" 2>/dev/null || :)" = "$STAGE/cloud-passive" ]; then kill -TERM "$capture" 2>/dev/null || :; fi
 if [ "$changed" = 1 ]; then
  printf 'RESTORING\n' > "$STAGE/phase"
  if [ "$iot_reconnect" = 1 ]; then iot_notify close_server || code=1; fi
  if [ "$relay_sent" = 1 ]; then
   timeout 5 avacmd msg_cvt '{"method":"local.status","params":"cloud_retry"}' >>"$STAGE/iot-transport.log" 2>&1 || code=1
  fi
  stop_candidate || :
  if [ "$fds_overlay" = 1 ]; then
   for n in 1 2 3 4 5; do
    owns_bind /ava/script/fds_hook.sh fds-hook-trial.sh || break
    if umount /ava/script/fds_hook.sh; then fds_overlay=0; break; fi
    usleep 100000
   done
   if [ "$fds_overlay" = 1 ] && owns_bind /ava/script/fds_hook.sh fds-hook-trial.sh; then
    if umount -l /ava/script/fds_hook.sh; then fds_overlay=0; fi
   fi
   [ "$fds_overlay" = 0 ] || code=1
  fi
  if [ "$msg_guard" = 1 ]; then
   for n in 1 2 3 4 5; do
    owns_bind /ava/script/msg_cvt.sh msg-cvt-trial.sh || break
    if umount /ava/script/msg_cvt.sh; then msg_guard=0; break; fi
    usleep 100000
   done
   # The native disconnected hook can still have this script open. Detach
   # only our verified file bind; existing readers keep their old descriptor.
   if [ "$msg_guard" = 1 ] && owns_bind /ava/script/msg_cvt.sh msg-cvt-trial.sh; then
    if umount -l /ava/script/msg_cvt.sh; then msg_guard=0; fi
   fi
   [ "$msg_guard" = 0 ] || code=1
  fi
  if [ -n "$vt" ] && [ "$(readlink "/proc/$vt/exe" 2>/dev/null || :)" = /data/.valetudo/valetudo ]; then
   kill -TERM "$vt" 2>/dev/null || :
   for n in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$vt" 2>/dev/null || break; sleep 1; done
   if kill -0 "$vt" 2>/dev/null; then kill -KILL "$vt" 2>/dev/null || :; fi
  fi
  # Restore an original credential/config file only if the stock SDK's exit
  # unexpectedly removed or changed it. The candidate sees a different mount.
  if [ "$continuous" = 0 ]; then
   for f in device.conf device.token wifi.conf; do
   expected=$(awk -v p="/data/config/miio/$f" '$2==p {print $1}' "$STAGE/protected.sha256")
   actual=$(sha256sum "/data/config/miio/$f" 2>/dev/null | cut -d ' ' -f 1 || :)
   if [ "$actual" != "$expected" ]; then
    cp -p "$STAGE/original/$f" "/data/config/miio/$f" || code=1
    printf '%s\n' "$f" >> "$STAGE/recovered-files"
   fi
   done
  fi
  # Resume the exact original helper. Its working configuration was never changed.
  if same "$OLD_HELPER" "$HELPER_TICKS"; then
   kill -CONT "$OLD_HELPER" 2>/dev/null || :
  else
   if [ -z "$(helper_pids)" ]; then /usr/bin/miio_client_helper_nomqtt.sh 8>&- >/dev/null 2>&1 & fi
  fi
  if ! stock_running miio_client /usr/bin/miio_client; then
   /usr/bin/miio_client -D -d/etc/miio/ -oMSC -l0 8>&- >"$STAGE/restore-sdk.private.log" 2>&1 || :
  fi
  # The daemon can exist before its agent TCP endpoint is listening. Starting
  # miio_agent in that gap fails with "Connect to server ... 54322".
  sdk_ready=0
  for n in $(seq 1 15); do
   /usr/bin/miio_send_line '{"method":"_internal.helper_ready"}' >/dev/null 2>&1 || :
   if stock_running miio_client /usr/bin/miio_client &&
    netstat -lnt 2>/dev/null | awk '$4 ~ /:54322$/ {found=1} END {exit !found}'; then sdk_ready=1; break; fi
   sleep 1
  done
  [ "$sdk_ready" = 1 ] || code=1
  if ! stock_running miio_agent /bin/miio_agent; then
   /bin/miio_agent -D -l0 8>&- >"$STAGE/restore-agent.private.log" 2>&1 || code=1
  fi
  if [ "$iot_reconnect" = 1 ]; then iot_notify open_server || code=1; fi
  if [ "$continuous" = 0 ]; then
   /bin/sh /data/.valetudo/start.sh >"$STAGE/restore-valetudo.log" 2>&1 || code=1
  fi
 fi
 if [ "$restart_mark" = 1 ]; then rm -f /tmp/restart_miio.mark; fi
 sha256sum -c "$STAGE/protected.sha256" >"$STAGE/protected.check" 2>&1 || code=1
 if [ "$lock_owned" = 1 ]; then
  rm -f "$LOCK/pid" "$LOCK/start_ticks" "$LOCK/run" "$LOCK/ip"
  rmdir "$LOCK" 2>/dev/null || code=1
 fi
 printf '%s\n' "$code" > "$STAGE/exit-code"
 printf 'RESTORED\n' > "$STAGE/phase"
 exit "$code"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
same "$OLD_SDK" "$SDK_TICKS"
same "$OLD_HELPER" "$HELPER_TICKS"
same "$OLD_AGENT" "$AGENT_TICKS"
[ "$(readlink "/proc/$OLD_SDK/exe")" = /usr/bin/miio_client ]
sha256sum -c "$STAGE/protected.sha256" >/dev/null
if [ "$continuous" = 0 ]; then
 supervisor=$$
 (sleep 210; kill -TERM "$supervisor" 2>/dev/null || :) &
 timer=$!
fi
printf 'STARTING\n' > "$STAGE/phase"
if [ "$continuous" = 0 ]; then
 changed=1
 /bin/sh /data/.valetudo/stop.sh >"$STAGE/stop-valetudo.log" 2>&1
 for n in $(seq 1 12); do [ -e "$LOCK" ] || break; sleep 1; done
 [ ! -e "$LOCK" ]
else
 mkdir "$LOCK"
 lock_owned=1
 changed=1
fi
console_log="$STAGE/valetudo.stdout.private.log"
[ "$continuous" = 0 ] || console_log=/dev/null
TMPDIR="$STAGE" VALETUDO_CONFIG_PATH="$STAGE/valetudo-config.json" VALETUDO_LOG_PATH="$STAGE/valetudo.private.log" \
 /data/.valetudo/valetudo 8>&- >"$console_log" 2>&1 &
vt=$!
printf '%s\n' "$vt" > "$STAGE/valetudo.pid"
if [ "$continuous" = 1 ]; then
 printf '%s\n' "$STAGE" > "$LOCK/run"
 printf '%s\n' "$vt" > "$LOCK/pid"
 awk '{print $22}' "/proc/$vt/stat" > "$LOCK/start_ticks"
 ip -4 addr show dev wlan0 | awk '$1=="inet" {split($2,a,"/"); print a[1]; exit}' > "$LOCK/ip"
fi
listening=0
for n in $(seq 1 55); do
 kill -0 "$vt" 2>/dev/null || exit 1
 if netstat -lnut 2>/dev/null | awk '
  $4=="127.0.0.1:8053" {cloud=1}
  $4=="127.0.0.1:8079" {fds=1}
  $4 ~ /:18080$/ {http=1}
  END {exit !(cloud && fds && http)}'; then listening=1; break; fi
 sleep 1
done
[ "$listening" = 1 ]
# This is the stock SDK maintenance flag checked by miio_monitor.sh. It
# prevents a second helper/client being started during the temporary handover.
[ ! -e /tmp/restart_miio.mark ]
touch /tmp/restart_miio.mark
restart_mark=1
# Use the existing Dreame builder's user-change reset guard during the SDK
# trial. The original read-only script is restored by unmounting this RAM copy.
mount -o bind "$STAGE/msg-cvt-trial.sh" /ava/script/msg_cvt.sh
msg_guard=1
if [ -f "$STAGE/plain-local-fds.enabled" ]; then
 mount -o bind "$STAGE/fds-hook-trial.sh" /ava/script/fds_hook.sh
 fds_overlay=1
fi
if [ -f "$STAGE/reconnect-iot.enabled" ]; then
 iot_reconnect=1
 iot_notify close_server
 usleep 200000
fi
# Keep the stock SDK running throughout the slow Valetudo bootstrap. Switch
# only once its real local cloud listener is ready to accept packets.
same "$OLD_SDK" "$SDK_TICKS"
same "$OLD_HELPER" "$HELPER_TICKS"
same "$OLD_AGENT" "$AGENT_TICKS"
kill -STOP "$OLD_HELPER"
for p in $(pidof miio_recv_line 2>/dev/null || :); do
 if [ "$(awk '{print $4}' "/proc/$p/stat")" = "$OLD_HELPER" ]; then kill -TERM "$p" 2>/dev/null || :; fi
done
kill -TERM "$OLD_SDK"
for n in $(seq 1 10); do same "$OLD_SDK" "$SDK_TICKS" || break; usleep 100000; done
if same "$OLD_SDK" "$SDK_TICKS"; then kill -KILL "$OLD_SDK"; fi
kill -TERM "$OLD_AGENT"
for n in $(seq 1 10); do same "$OLD_AGENT" "$AGENT_TICKS" || break; usleep 100000; done
if same "$OLD_AGENT" "$AGENT_TICKS"; then kill -KILL "$OLD_AGENT"; fi
[ -z "$(pidof miio_client 2>/dev/null || :)" ]
if [ "$continuous" = 0 ]; then
 "$STAGE/cloud-passive" 127.0.0.1 120 >"$STAGE/cloud.packets.private.bin" 2>"$STAGE/capture.log" &
 capture=$!
fi
setsid unshare -m --propagation private /bin/sh "$STAGE/namespace.sh" "$STAGE" 8>&- >"$STAGE/namespace.private.log" 2>&1 &
printf '%s\n' "$!" > "$STAGE/namespace-launch.pid"
sleep 2
[ -s "$STAGE/namespace.pid" ]
if [ "$iot_reconnect" = 1 ]; then iot_notify open_server; fi
if [ -f "$STAGE/relay-local-connect.enabled" ]; then
 authenticated=0
 for n in $(seq 1 50); do
  count=$(curl -fsS --max-time 2 http://127.0.0.1:18080/api/v2/robot/properties 2>/dev/null |
   jshon -e cloudAuthenticatedMessages 2>/dev/null || :)
  case "$count" in ''|*[!0-9]*) ;; *) if [ "$count" -gt 0 ]; then authenticated=1; break; fi;; esac
  sleep 1
 done
 [ "$authenticated" = 1 ]
 [ "$(cat /data/config/miio/device.uid)" = 1337 ]
 [ "$(jshon -e Uid -u < /data/config/ava/clean_log.json)" = 1337 ]
 state=$(timeout 5 avacmd msg_cvt '{"type":"msgCvt","cmd":"get_iot_state"}' | jshon -e iot_state -u)
 if [ "$state" = disconnected ]; then
  timeout 5 avacmd msg_cvt '{"method":"local.status","params":"cloud_connected"}' >>"$STAGE/iot-transport.log" 2>&1
  relay_sent=1
  echo AUTHENTICATED_LOCAL_CONNECTION_RELAYED > "$STAGE/iot-relayed"
 fi
 state=$(timeout 5 avacmd msg_cvt '{"type":"msgCvt","cmd":"get_iot_state"}' | jshon -e iot_state -u)
 [ "$state" = connected ]
fi
printf 'RUNNING\n' > "$STAGE/phase"
if [ "$continuous" = 1 ]; then
 cp "$STAGE/agent.ticks" "$STAGE/watch-agent.ticks"
 sdk=$(cat "$STAGE/sdk.pid"); sdk_ticks=$(awk '{print $22}' "/proc/$sdk/stat")
 helper=$(cat "$STAGE/helper.pid"); helper_ticks=$(awk '{print $22}' "/proc/$helper/stat")
 agent=$(cat "$STAGE/agent.pid"); agent_ticks=$(cat "$STAGE/watch-agent.ticks")
 while kill -0 "$vt" 2>/dev/null; do
  [ ! -e "$STAGE/STOP" ] || break
  [ ! -e "$STAGE/helper-rejected" ] || exit 1
  same "$sdk" "$sdk_ticks" || exit 1
  same "$helper" "$helper_ticks" || exit 1
  same "$agent" "$agent_ticks" || exit 1
  sleep 2
 done
 exit 0
fi
for n in $(seq 1 120); do
 [ ! -e "$STAGE/STOP" ] || break
 [ ! -e "$STAGE/helper-rejected" ] || break
 kill -0 "$vt" 2>/dev/null || break
 sleep 1
done
