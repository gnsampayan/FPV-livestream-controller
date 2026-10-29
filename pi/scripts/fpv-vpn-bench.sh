#!/bin/bash
# Compare VPN underlays (Tailscale vs kernel WireGuard) on the Pi 3 B v1.2.
#
# Tailscale on Linux normally runs WireGuard in userspace (wireguard-go inside
# tailscaled), which spends Cortex-A53 cycles on every packet. Kernel
# WireGuard does the same crypto in-kernel and is usually cheaper. Run this
# once per VPN, with the stream's real traffic profile, and compare:
#
#   1. On the server:       iperf3 -s
#   2. On the Pi:           fpv-vpn-bench.sh <server-vpn-ip> [mbit] [seconds]
#
# It sends UDP at the video bitrate (default 3 Mbit/s, 1200-byte datagrams like
# the RTP stream) and reports packet loss, jitter, and the CPU the Pi spent
# while doing it (whole-system per-core load and the VPN daemon itself).
#
# Requires: iperf3 (sudo apt install iperf3). Read-only apart from the traffic.

set -u

SERVER="${1:-}"
MBIT="${2:-3}"
SECONDS_TO_RUN="${3:-30}"

if [ -z "${SERVER}" ]; then
    echo "Usage: $0 <server-ip> [mbit=3] [seconds=30]" >&2
    exit 1
fi

if ! command -v iperf3 >/dev/null 2>&1; then
    echo "ERROR: iperf3 not found (sudo apt install iperf3)" >&2
    exit 1
fi

# Sum of busy jiffies and total jiffies across all cores.
read_cpu_totals() {
    awk '/^cpu / {
        idle = $5 + $6
        total = 0
        for (i = 2; i <= NF; i++) total += $i
        print idle, total
    }' /proc/stat
}

# utime + stime (clock ticks) of every process called $1, summed.
process_ticks() {
    local name="$1" pid sum=0 ticks
    for pid in $(pgrep -x "${name}" 2>/dev/null); do
        ticks="$(awk '{ print $14 + $15 }' "/proc/${pid}/stat" 2>/dev/null || echo 0)"
        sum=$((sum + ticks))
    done
    echo "${sum}"
}

CLK_TCK="$(getconf CLK_TCK)"
VPN_DAEMONS=(tailscaled wireguard-go)

echo "Sending ${MBIT} Mbit/s UDP to ${SERVER} for ${SECONDS_TO_RUN}s..."

read -r idle_before total_before <<< "$(read_cpu_totals)"
declare -A ticks_before
for daemon in "${VPN_DAEMONS[@]}"; do
    ticks_before[${daemon}]="$(process_ticks "${daemon}")"
done

iperf3 --client "${SERVER}" --udp --bitrate "${MBIT}M" --length 1200 \
       --time "${SECONDS_TO_RUN}" | tail -n 8

read -r idle_after total_after <<< "$(read_cpu_totals)"

total_delta=$((total_after - total_before))
idle_delta=$((idle_after - idle_before))
if [ "${total_delta}" -gt 0 ]; then
    busy_pct="$(awk -v t="${total_delta}" -v i="${idle_delta}" 'BEGIN { printf "%.1f", 100 * (1 - i / t) }')"
    echo ""
    echo "Whole-system CPU during test: ${busy_pct}% of all 4 cores"
fi

for daemon in "${VPN_DAEMONS[@]}"; do
    after="$(process_ticks "${daemon}")"
    delta=$((after - ticks_before[${daemon}]))
    if [ "${after}" -gt 0 ]; then
        cpu_pct="$(awk -v d="${delta}" -v c="${CLK_TCK}" -v s="${SECONDS_TO_RUN}" \
            'BEGIN { printf "%.1f", 100 * d / c / s }')"
        echo "${daemon}: ${cpu_pct}% of one core"
    fi
done

echo ""
echo "Tip: lower loss and jitter, with less CPU in the VPN daemon, wins."
