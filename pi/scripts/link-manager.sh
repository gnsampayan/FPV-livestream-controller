#!/bin/bash
# FPV link manager: fast LTE <-> Wi-Fi failover.
#
# Replaces the old 30-second ping watchdog. Every PROBE_INTERVAL seconds it
# pings through *each* interface separately (ping -I) and keeps the healthier
# default route on top:
#
#   - LTE is normally primary (route metric from the NM profile, e.g. 100).
#   - If LTE fails FAIL_THRESHOLD probes in a row and Wi-Fi is healthy, the
#     LTE default route is demoted to metric 900 so Wi-Fi (metric 600) wins.
#     Detection time is FAIL_THRESHOLD x PROBE_INTERVAL (6 s by default,
#     versus 90+ s before).
#   - After RECOVER_THRESHOLD good LTE probes the original metric is restored.
#   - If LTE keeps failing and there is no healthy Wi-Fi to fall back to,
#     the LTE connection is bounced with nmcli after BOUNCE_AFTER failures
#     (clears wedged PDP sessions and stuck tower handoffs).
#
# Established UDP flows (RTP, control) keep working across a switch because
# the VPN underlay (Tailscale/WireGuard) re-roams to the new source address.
#
# Configuration comes from /etc/default/fpv-network (see
# network/fpv-network.env.example). Runs as root (changes routes).

set -u

CONFIG_FILE="/etc/default/fpv-network"

PROBE_TARGET="1.1.1.1"
PROBE_INTERVAL=2
FAIL_THRESHOLD=3
RECOVER_THRESHOLD=5
BOUNCE_AFTER=30
LTE_CONN="lte-usb"
DEMOTED_METRIC=900
PROBE_TIMEOUT=1
BOUNCE_COOLDOWN_S=60

if [ -r "${CONFIG_FILE}" ]; then
    # shellcheck disable=SC1090
    . "${CONFIG_FILE}"
fi

# Allow overrides of the detected interfaces (rarely needed).
LTE_IFACE="${LTE_IFACE:-}"
WIFI_IFACE="${WIFI_IFACE:-}"

lte_fails=0
lte_oks=0
wifi_fails=0
lte_demoted=0
lte_original_metric=""
last_bounce=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] link-manager: $*"
}

# ---------------------------------------------------------------------------
# Interface discovery
# ---------------------------------------------------------------------------
detect_lte_iface() {
    if [ -n "${LTE_IFACE}" ]; then
        echo "${LTE_IFACE}"
        return
    fi
    # Ask NetworkManager which device the LTE profile is active on.
    local dev
    dev="$(nmcli -g GENERAL.IP-IFACE connection show "${LTE_CONN}" 2>/dev/null | head -n1)"
    if [ -n "${dev}" ]; then
        echo "${dev}"
        return
    fi
    # Fall back to the first USB-style ethernet interface.
    local candidate
    for candidate in /sys/class/net/usb0 /sys/class/net/eth1 /sys/class/net/enx*; do
        if [ -e "${candidate}" ]; then
            basename "${candidate}"
            return
        fi
    done
}

detect_wifi_iface() {
    if [ -n "${WIFI_IFACE}" ]; then
        echo "${WIFI_IFACE}"
        return
    fi
    local candidate
    for candidate in /sys/class/net/*/wireless; do
        if [ -e "${candidate}" ]; then
            basename "$(dirname "${candidate}")"
            return
        fi
    done
}

# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------
probe() {
    local iface="$1"
    [ -n "${iface}" ] || return 1
    ping -I "${iface}" -c 1 -W "${PROBE_TIMEOUT}" -q "${PROBE_TARGET}" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Route manipulation
# ---------------------------------------------------------------------------
# Prints "<gateway>|<metric>" for the lowest-metric default route on $1.
default_route_of() {
    local iface="$1"
    ip -4 route show default dev "${iface}" 2>/dev/null | awk '
        {
            gw = ""; metric = 0
            for (i = 1; i <= NF; i++) {
                if ($i == "via")    gw = $(i + 1)
                if ($i == "metric") metric = $(i + 1)
            }
            print gw "|" metric
        }' | sort -t'|' -k2,2n | head -n1
}

set_route_metric() {
    local iface="$1" gateway="$2" old_metric="$3" new_metric="$4"
    if [ -n "${gateway}" ]; then
        ip route add default via "${gateway}" dev "${iface}" metric "${new_metric}" 2>/dev/null || true
        ip route del default via "${gateway}" dev "${iface}" metric "${old_metric}" 2>/dev/null || true
    else
        ip route add default dev "${iface}" metric "${new_metric}" 2>/dev/null || true
        ip route del default dev "${iface}" metric "${old_metric}" 2>/dev/null || true
    fi
}

demote_lte() {
    local iface="$1" route gateway metric
    route="$(default_route_of "${iface}")"
    [ -n "${route}" ] || return 1
    gateway="${route%%|*}"
    metric="${route##*|}"
    [ "${metric}" -ge "${DEMOTED_METRIC}" ] && return 0

    lte_original_metric="${metric}"
    set_route_metric "${iface}" "${gateway}" "${metric}" "${DEMOTED_METRIC}"
    lte_demoted=1
    log "LTE (${iface}) unhealthy: default route metric ${metric} -> ${DEMOTED_METRIC}, Wi-Fi is now primary"
}

promote_lte() {
    local iface="$1" route gateway metric
    route="$(default_route_of "${iface}")"
    if [ -n "${route}" ] && [ -n "${lte_original_metric}" ]; then
        gateway="${route%%|*}"
        metric="${route##*|}"
        if [ "${metric}" -ge "${DEMOTED_METRIC}" ]; then
            set_route_metric "${iface}" "${gateway}" "${metric}" "${lte_original_metric}"
        fi
        log "LTE (${iface}) recovered: default route metric restored to ${lte_original_metric}"
    fi
    lte_demoted=0
}

restore_on_exit() {
    if [ "${lte_demoted}" -eq 1 ]; then
        local iface
        iface="$(detect_lte_iface)"
        [ -n "${iface}" ] && promote_lte "${iface}"
    fi
}
trap restore_on_exit EXIT
trap 'exit 0' TERM INT

bounce_lte() {
    local now
    now="$(date +%s)"
    if [ $((now - last_bounce)) -lt "${BOUNCE_COOLDOWN_S}" ]; then
        return
    fi
    last_bounce="${now}"
    log "LTE failing with no Wi-Fi fallback: bouncing NM connection '${LTE_CONN}'"
    nmcli con down "${LTE_CONN}" >/dev/null 2>&1 || true
    sleep 2
    nmcli con up "${LTE_CONN}" >/dev/null 2>&1 || log "nmcli con up ${LTE_CONN} failed"
    lte_fails=0
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
log "started (target ${PROBE_TARGET}, every ${PROBE_INTERVAL}s, demote after ${FAIL_THRESHOLD} failures)"

while true; do
    lte_iface="$(detect_lte_iface)"
    wifi_iface="$(detect_wifi_iface)"

    # Probe both links in parallel so a dead one cannot delay the other.
    probe "${wifi_iface}" &
    wifi_pid=$!
    lte_ok=0
    wifi_ok=0
    if probe "${lte_iface}"; then lte_ok=1; fi
    if wait "${wifi_pid}"; then wifi_ok=1; fi

    if [ "${lte_ok}" -eq 1 ]; then
        lte_fails=0
        lte_oks=$((lte_oks + 1))
    else
        lte_oks=0
        lte_fails=$((lte_fails + 1))
    fi

    if [ "${wifi_ok}" -eq 1 ]; then
        wifi_fails=0
    else
        wifi_fails=$((wifi_fails + 1))
    fi

    if [ "${lte_demoted}" -eq 0 ]; then
        if [ "${lte_fails}" -ge "${FAIL_THRESHOLD}" ] && [ "${wifi_ok}" -eq 1 ] && [ -n "${lte_iface}" ]; then
            demote_lte "${lte_iface}"
        elif [ "${lte_fails}" -ge "${BOUNCE_AFTER}" ] && [ "${wifi_ok}" -eq 0 ]; then
            bounce_lte
        fi
    else
        # NetworkManager may re-add the low-metric route (DHCP renew); keep it demoted.
        if [ "${lte_ok}" -eq 0 ] && [ -n "${lte_iface}" ]; then
            demote_lte "${lte_iface}"
        fi
        if [ "${lte_oks}" -ge "${RECOVER_THRESHOLD}" ] && [ -n "${lte_iface}" ]; then
            promote_lte "${lte_iface}"
        fi
    fi

    sleep "${PROBE_INTERVAL}"
done
