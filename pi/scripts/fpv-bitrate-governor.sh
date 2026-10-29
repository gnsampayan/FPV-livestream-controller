#!/bin/bash
# OPTIONAL thermal / power bitrate governor (disabled by default).
#
# When the Pi firmware reports throttling or undervoltage, the SoC slows down
# and every pipeline stage starts to miss deadlines. Lowering the encoder
# bitrate reduces bus, USB and network load and usually lets the board recover
# without dropping frames. When the flags clear and stay clear, the original
# bitrate is restored.
#
# It adjusts the *running* hardware H.264 encoder through its V4L2 control, so
# no restart (and no keyframe gap) is involved. Validate on your hardware first
# (v4l2-ctl --device=/dev/video11 --list-ctrls) before enabling the service:
#
#   sudo systemctl enable --now fpv-bitrate-governor
#
# Configuration via environment:
#   ENCODER_DEVICE   V4L2 encoder node (default /dev/video11, the bcm2835-codec
#                    H.264 encoder on Raspberry Pi OS)
#   REDUCE_PERCENT   bitrate while throttled, percent of normal (default 60)
#   POLL_SECONDS     how often to check (default 3)
#   CLEAR_SECONDS    flags must stay clear this long before restoring (default 30)

set -u

ENCODER_DEVICE="${ENCODER_DEVICE:-/dev/video11}"
REDUCE_PERCENT="${REDUCE_PERCENT:-60}"
POLL_SECONDS="${POLL_SECONDS:-3}"
CLEAR_SECONDS="${CLEAR_SECONDS:-30}"

# Bits of get_throttled that mean "right now": undervoltage, ARM frequency
# capped, currently throttled, soft temperature limit.
ACTIVE_MASK=$((0x1 | 0x2 | 0x4 | 0x8))

THROTTLED_SYSFS_PATHS=(
    /sys/devices/platform/soc/soc:firmware/get_throttled
    /sys/devices/platform/soc/soc:firmware/raspberrypi-hwmon/get_throttled
)

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] bitrate-governor: $*"
}

if ! command -v v4l2-ctl >/dev/null 2>&1; then
    log "ERROR: v4l2-ctl not found (sudo apt install v4l-utils)"
    exit 1
fi

read_throttled() {
    local path raw
    for path in "${THROTTLED_SYSFS_PATHS[@]}"; do
        if [ -r "${path}" ]; then
            raw="$(cat "${path}" 2>/dev/null)"
            echo $((raw))
            return
        fi
    done
    if command -v vcgencmd >/dev/null 2>&1; then
        raw="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
        if [ -n "${raw}" ]; then
            echo $((raw))
            return
        fi
    fi
    echo 0
}

# Prints the encoder's current bitrate in bps, or nothing if unavailable.
get_bitrate() {
    v4l2-ctl --device="${ENCODER_DEVICE}" --get-ctrl=video_bitrate 2>/dev/null \
        | awk -F': ' '/video_bitrate/ { print $2 }'
}

set_bitrate() {
    v4l2-ctl --device="${ENCODER_DEVICE}" --set-ctrl="video_bitrate=$1" >/dev/null 2>&1
}

reduced=0
normal_bitrate=0
clear_for=0

log "watching ${ENCODER_DEVICE}; reduce to ${REDUCE_PERCENT}% when throttled"

while true; do
    sleep "${POLL_SECONDS}"

    throttled="$(read_throttled)"

    if (( throttled & ACTIVE_MASK )); then
        clear_for=0
        if [ "${reduced}" -eq 0 ]; then
            current="$(get_bitrate)"
            if [ -z "${current}" ] || [ "${current}" -le 0 ] 2>/dev/null; then
                continue
            fi
            normal_bitrate="${current}"
            target=$((normal_bitrate * REDUCE_PERCENT / 100))
            if set_bitrate "${target}"; then
                reduced=1
                log "throttled (0x$(printf '%x' "${throttled}")): bitrate ${normal_bitrate} -> ${target}"
            else
                log "failed to lower bitrate on ${ENCODER_DEVICE}"
            fi
        fi
    elif [ "${reduced}" -eq 1 ]; then
        clear_for=$((clear_for + POLL_SECONDS))
        if [ "${clear_for}" -ge "${CLEAR_SECONDS}" ]; then
            if set_bitrate "${normal_bitrate}"; then
                log "recovered: bitrate restored to ${normal_bitrate}"
                reduced=0
            else
                log "failed to restore bitrate on ${ENCODER_DEVICE}"
            fi
        fi
    fi
done
