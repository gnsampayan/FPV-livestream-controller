#!/bin/bash
# FPV Pi diagnostics snapshot.
#
# Prints everything that matters when chasing latency or dropped frames on a
# Raspberry Pi 3 B v1.2: per-core load, clocks, temperature and throttle
# flags, scheduler placement of the FPV processes, network path + qdisc, Wi-Fi
# link quality, and recent error lines from the FPV journal units.
#
# Usage:
#   fpv-diag.sh            one snapshot
#   fpv-diag.sh --watch    refresh every 2 seconds (Ctrl+C to stop)
#
# Read-only: safe to run while the stream is live.

set -u

FPV_UNITS=(fpv-video fpv-audio-tx fpv-audio-rx fpv-control fpv-link-manager)
SAMPLE_SECONDS=1

section() {
    printf '\n=== %s ===\n' "$1"
}

have() {
    command -v "$1" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Per-core CPU load (two /proc/stat samples)
# ---------------------------------------------------------------------------
read_cpu_stat() {
    # Emits "cpuN idle total" for every core.
    awk '/^cpu[0-9]+ / {
        idle = $5 + $6
        total = 0
        for (i = 2; i <= NF; i++) total += $i
        print $1, idle, total
    }' /proc/stat
}

print_core_load() {
    local before after
    before="$(read_cpu_stat)"
    sleep "${SAMPLE_SECONDS}"
    after="$(read_cpu_stat)"

    paste <(echo "${before}") <(echo "${after}") | awk '{
        idle_delta  = $5 - $2
        total_delta = $6 - $3
        busy = (total_delta > 0) ? 100 * (1 - idle_delta / total_delta) : 0
        printf "  %-5s %5.1f%%\n", $1, busy
    }'
}

# ---------------------------------------------------------------------------
# Temperature, clocks, throttling
# ---------------------------------------------------------------------------
decode_throttled() {
    local hex="$1"
    local value=$((hex))
    local flags=()
    ((value & 0x1))     && flags+=("UNDERVOLTAGE-NOW")
    ((value & 0x2))     && flags+=("FREQ-CAPPED-NOW")
    ((value & 0x4))     && flags+=("THROTTLED-NOW")
    ((value & 0x8))     && flags+=("SOFT-TEMP-LIMIT-NOW")
    ((value & 0x10000)) && flags+=("undervoltage-since-boot")
    ((value & 0x20000)) && flags+=("freq-capped-since-boot")
    ((value & 0x40000)) && flags+=("throttled-since-boot")
    ((value & 0x80000)) && flags+=("soft-temp-limit-since-boot")
    if [ "${#flags[@]}" -eq 0 ]; then
        echo "none"
    else
        echo "${flags[*]}"
    fi
}

print_thermal() {
    if have vcgencmd; then
        echo "  temp:      $(vcgencmd measure_temp 2>/dev/null)"
        local throttled
        throttled="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
        if [ -n "${throttled}" ]; then
            echo "  throttled: ${throttled} ($(decode_throttled "${throttled}"))"
        fi
        echo "  arm clock: $(vcgencmd measure_clock arm 2>/dev/null | cut -d= -f2) Hz"
        echo "  core volt: $(vcgencmd measure_volts core 2>/dev/null | cut -d= -f2)"
    elif [ -r /sys/class/thermal/thermal_zone0/temp ]; then
        echo "  temp:      $(( $(cat /sys/class/thermal/thermal_zone0/temp) / 1000 )) C"
    fi

    local governor_file=/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
    if [ -r "${governor_file}" ]; then
        echo "  governor:  $(cat "${governor_file}")"
    fi
}

# ---------------------------------------------------------------------------
# Scheduler placement of FPV processes
# ---------------------------------------------------------------------------
print_processes() {
    echo "  PID   CPU CLS RTPRIO NI  %CPU  %MEM COMMAND"
    ps -eo pid,psr,cls,rtprio,ni,pcpu,pmem,comm --sort=-pcpu \
        | awk 'NR > 1 && $8 ~ /^(rpicam|libcamera|gst-launch|python3|raspivid|x264|janus)/ { print "  " $0 }' \
        | head -n 12
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
print_network() {
    echo "  default routes:"
    ip -4 route show default 2>/dev/null | sed 's/^/    /'

    if have tc; then
        echo "  qdiscs:"
        tc qdisc show 2>/dev/null | grep -E 'dev (usb|eth|enx|wlan)' | sed 's/^/    /'
    fi

    if have iw; then
        local wlan
        wlan="$(iw dev 2>/dev/null | awk '$1 == "Interface" { print $2; exit }')"
        if [ -n "${wlan}" ]; then
            echo "  wifi (${wlan}):"
            iw dev "${wlan}" link 2>/dev/null | sed 's/^/    /'
            iw dev "${wlan}" get power_save 2>/dev/null | sed 's/^/    /'
            iw dev "${wlan}" station dump 2>/dev/null \
                | grep -E 'signal:|tx retries|tx failed|tx bitrate' | sed 's/^/    /'
        fi
    elif [ -r /proc/net/wireless ]; then
        sed 's/^/    /' /proc/net/wireless
    fi
}

# ---------------------------------------------------------------------------
# Service state and recent problems
# ---------------------------------------------------------------------------
print_services() {
    local unit state
    for unit in "${FPV_UNITS[@]}"; do
        state="$(systemctl is-active "${unit}" 2>/dev/null || true)"
        printf '  %-18s %s\n' "${unit}" "${state:-unknown}"
    done
}

print_recent_problems() {
    if ! have journalctl; then
        echo "  journalctl not available"
        return
    fi

    local args=()
    local unit
    for unit in "${FPV_UNITS[@]}"; do
        args+=("-u" "${unit}")
    done

    local lines
    lines="$(journalctl "${args[@]}" --since "-5 min" --no-pager -o short-monotonic 2>/dev/null \
        | grep -Ei 'drop|underrun|overrun|xrun|error|warn|stall|failsafe|buffer' \
        | tail -n 15)"

    if [ -z "${lines}" ]; then
        echo "  none in the last 5 minutes"
    else
        echo "${lines}" | sed 's/^/  /'
    fi
}

snapshot() {
    echo "FPV diagnostics - $(date '+%Y-%m-%d %H:%M:%S')  (kernel $(uname -r))"

    section "Per-core CPU load (${SAMPLE_SECONDS}s sample)"
    print_core_load

    section "Thermal / clocks"
    print_thermal

    section "FPV processes (psr = core, cls: TS=normal FF=fifo RR=round-robin)"
    print_processes

    section "Services"
    print_services

    section "Network"
    print_network

    section "Recent warnings (journal, last 5 min)"
    print_recent_problems
}

if [ "${1:-}" = "--watch" ]; then
    while true; do
        clear
        snapshot
        sleep 2
    done
else
    snapshot
fi
