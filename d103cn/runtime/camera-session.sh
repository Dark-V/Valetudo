#!/bin/sh
# Only the factory service opens the sensor. stdin is a five-second lease.
set -eu
umask 077
root=/data/.valetudo
lock=/tmp/d103-live-camera.lock
case "${1:-}" in bright|factory) mode=$1;; *) exit 2;; esac
[ "$(hostname)" = r2405_release ]
grep -qx 'model=xiaomi.vacuum.d103cn' /data/config/miio/device.conf
grep -q '^sc035gs' /sys/class/video4linux/v4l-subdev0/name
for f in /sys/class/thermal/thermal_zone*/temp; do [ "$(cat "$f")" -lt 70000 ]; done
[ "$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)" -gt 98304 ]
mkdir "$lock" || { echo CAMERA_BUSY >&2; exit 1; }
stage=
child=
original=
changed=0
command() { timeout 4 avacmd camera_laser "$1"; }
controls() { "$root/camera-controls" | awk '/name=Exposure /{e=$3}/name=Gain /{g=$3}END{print e,g}'; }
wait_factory() {
 for n in $(seq 1 20); do
  [ "$(controls)" != 'value=950 value=48' ] || return 0
  sleep 0.2
 done
 return 1
}
cleanup() {
 code=$?
 trap - EXIT HUP INT TERM
 [ -z "$child" ] || { kill -TERM "$child" 2>/dev/null || :; wait "$child" 2>/dev/null || :; }
 if [ "$changed" = 1 ]; then
  command '{"type":"camera_laser","cmd":"save_image","num":0}' >&2 || :
  restore_opened=0
  if [ "$(controls)" != 'value=950 value=48' ]; then
   # avacmd acknowledges enqueueing, not sensor application. A closed stream
   # does not apply queued exposure at all: restore while streaming, then close.
   restore_state=$(command '{"type":"camera_laser","cmd":"get_camera_state"}' || :)
   case "$restore_state" in *'"state":"closed"'*)
    restore_opened=1
    command '{"type":"camera_laser","cmd":"open_camera"}' >&2 || :
   ;; esac
   command '{"type":"camera_laser","cmd":"set_exposure_gain","expose":950,"gain":48}' >&2 || :
   if ! wait_factory; then
    echo CAMERA_RESTORE_FAILED >&2
    code=1
   fi
  fi
  if { [ "$original" = closed ] && [ ! -f "$stage/keep-open" ]; } || [ "$restore_opened" = 1 ]; then
   command '{"type":"camera_laser","cmd":"close_camera"}' >&2 || :
  fi
  echo "RESTORE_CONTROLS $(controls)" >&2
  if [ "$(controls)" != 'value=950 value=48' ]; then
   echo CAMERA_RESTORE_FAILED >&2
   code=1
  fi
 fi
 if [ -n "$stage" ]; then
  case "$stage" in /tmp/d103-live-camera.*)
   find "$stage" -maxdepth 1 -type f -name 'image_*.bmp' -delete
   rm -f "$stage/keep-open"
   rmdir "$stage" || :
  ;; esac
 fi
 rmdir "$lock" || :
 echo CAMERA_SESSION_CLOSED >&2
 exit "$code"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
[ "$(controls)" = 'value=950 value=48' ] || { echo UNKNOWN_SENSOR_PROFILE >&2; exit 1; }
state=$(command '{"type":"camera_laser","cmd":"get_camera_state"}')
case "$state" in *'"state":"closed"'*) original=closed;; *'"state":"open"'*) original=open;; *) exit 1;; esac
stage=$(mktemp -d /tmp/d103-live-camera.XXXXXX)
exec 3<&0
"$root/camera-frames" "$stage" <&3 &
child=$!
# Watcher starts before save_image; wait briefly without consuming its stdin.
sleep 1
kill -0 "$child"
changed=1
if [ "$original" = closed ]; then
 command '{"type":"camera_laser","cmd":"open_camera"}' >&2
 sleep 1
fi
if [ "$mode" = bright ]; then
 command '{"type":"camera_laser","cmd":"set_exposure_gain","expose":5000,"gain":192}' >&2
 for n in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(controls)" != 'value=5000 value=192' ] || break
  sleep 0.2
 done
 [ "$(controls)" = 'value=5000 value=192' ] || exit 1
fi
command "{\"type\":\"camera_laser\",\"cmd\":\"save_image\",\"path\":\"$stage/\",\"num\":100000}" >&2
echo "CAMERA_READY mode=$mode" >&2
wait "$child"
child=
