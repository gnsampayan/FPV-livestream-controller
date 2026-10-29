#!/bin/bash
# FPV network watchdog.
#
# Runs periodically (via systemd timer) and pings a reachability target over
# the current default route. If the ping fails N times in a row it bounces
# the LTE connection with `nmcli con down/up`, which is usually enough to
# recover from stuck PDP sessions or tower handoffs that wedge the dongle.
#
# Configuration via environment (set in the systemd unit):
#   PING_TARGET    - host to ping (default: Cloudflare 1.1.1.1)
#   PING_COUNT     - pings per probe (default: 2)
#   PING_TIMEOUT   - seconds per ping (default: 3)
#   FAIL_THRESHOLD - consecutive failures before bouncing (default: 3)
#   LTE_CONN       - NM connection id to bounce (default: lte-usb)

set -u

PING_TARGET="${PING_TARGET:-1.1.1.1}"
PING_COUNT="${PING_COUNT:-2}"
PING_TIMEOUT="${PING_TIMEOUT:-3}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
LTE_CONN="${LTE_CONN:-lte-usb}"

STATE_DIR="/run/fpv"
STATE_FILE="${STATE_DIR}/net-watchdog.fails"

mkdir -p "${STATE_DIR}"
touch "${STATE_FILE}"

fails="$(cat "${STATE_FILE}" 2>/dev/null || echo 0)"
case "${fails}" in
    ''|*[!0-9]*) fails=0 ;;
esac

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] net-watchdog: $*"
}

if ping -c "${PING_COUNT}" -W "${PING_TIMEOUT}" -q "${PING_TARGET}" >/dev/null 2>&1; then
    if [ "${fails}" -gt 0 ]; then
        log "connectivity restored after ${fails} failure(s)"
    fi
    echo 0 > "${STATE_FILE}"
    exit 0
fi

fails=$((fails + 1))
echo "${fails}" > "${STATE_FILE}"
log "ping ${PING_TARGET} failed (${fails}/${FAIL_THRESHOLD})"

if [ "${fails}" -ge "${FAIL_THRESHOLD}" ]; then
    log "bouncing NM connection '${LTE_CONN}'"
    nmcli con down "${LTE_CONN}" >/dev/null 2>&1 || true
    sleep 2
    nmcli con up   "${LTE_CONN}" >/dev/null 2>&1 || log "nmcli con up ${LTE_CONN} failed"
    echo 0 > "${STATE_FILE}"
fi

exit 0
