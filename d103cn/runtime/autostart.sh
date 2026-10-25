#!/bin/sh
# Boot/network hook: one bounded start, no robot actions, no restart loop.
set -eu
umask 077
BASE=/data/.valetudo
[ "$(id -u)" = 0 ] && [ -f "$BASE/autostart.enabled" ] || exit 0

# device.conf can be sourced while the factory DHCP lock is held.
# Never retain that lock in this wrapper or its Valetudo child.
for autostart_fd_path in /proc/$$/fd/*; do
    autostart_fd=${autostart_fd_path##*/}
    case "$autostart_fd" in ''|*[!0-9]*|0|1|2) continue ;; esac
    autostart_target=$(readlink "$autostart_fd_path" 2>/dev/null || :)
    case "$autostart_target" in
        /var/run/udhcpc.lock|/tmp/root/var/run/udhcpc.lock)
            eval "exec ${autostart_fd}>&-" ;;
    esac
done
unset autostart_fd_path autostart_fd autostart_target
exec 9>/tmp/d103-valetudo-autostart.lock
flock -n 9 || exit 0
exec >>/tmp/d103-valetudo-autostart.log 2>&1
trap '' HUP
printf 'Valetudo autostart waiting for local network and SDK prerequisites\n'

for autostart_attempt in $(seq 1 90); do
    [ -f "$BASE/autostart.enabled" ] || exit 0
    if "$BASE/status.sh" >/dev/null 2>&1; then
        "$BASE/status.sh"
        exit 0
    fi
    autostart_ip=$(ip -4 -o addr show dev wlan0 scope global 2>/dev/null |
        awk '{split($4,a,"/"); print a[1]; exit}')
    if [ -n "$autostart_ip" ] && [ -r /data/config/miio/device.token ] &&
            [ -f /data/config/miio/wifi.conf ]; then
        # The existing launcher retains its hash, temperature, RAM and port guards.
        # Do not leak this wrapper's singleton lock to the long-lived process.
        /bin/sh "$BASE/start.sh" 9>&-
        exit $?
    fi
    sleep 2
done
printf 'Valetudo not started: prerequisites absent after 180 seconds; no reset attempted\n'
exit 1
