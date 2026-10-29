#!/bin/bash
# FPV runtime tuning for the Raspberry Pi 3 B v1.2. Runs once at boot as root
# (fpv-tune.service) before the FPV services start.
#
# What it does and why:
#   - CPU governor "performance": the cores sit at 1.2 GHz instead of
#     ramping up on demand, which removes frequency-transition latency.
#     No overclock or overvolt is applied, so warranty and stability are
#     unaffected.
#   - USB autosuspend off: audio, LTE dongle and Arduino must never be put
#     to sleep and woken again in the middle of a drive.
#   - Wi-Fi power save off: with power save on, the radio sleeps between
#     beacons and adds tens of ms of latency to every packet.
#   - HDMI off: a headless Pi gains a little power/thermal headroom.
#   - Swap off: a swapped-out page costs milliseconds on an SD card.
#
# Every step is best-effort: a failure is logged and the script continues, so
# a missing sysfs file on one OS version never blocks the stream from starting.

set -u

log() {
    echo "fpv-tune: $*"
}

have() {
    command -v "$1" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# CPU governor
# ---------------------------------------------------------------------------
set_governor() {
    local governor_file
    local changed=0
    for governor_file in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        [ -w "${governor_file}" ] || continue
        if echo performance > "${governor_file}" 2>/dev/null; then
            changed=1
        fi
    done
    if [ "${changed}" -eq 1 ]; then
        log "CPU governor set to performance"
    else
        log "CPU governor not changed (cpufreq not available)"
    fi
}

# ---------------------------------------------------------------------------
# USB autosuspend
# ---------------------------------------------------------------------------
disable_usb_autosuspend() {
    local control_file
    for control_file in /sys/bus/usb/devices/*/power/control; do
        [ -w "${control_file}" ] || continue
        echo on > "${control_file}" 2>/dev/null || true
    done
    log "USB autosuspend disabled"
}

# ---------------------------------------------------------------------------
# Wi-Fi power save
# ---------------------------------------------------------------------------
disable_wifi_power_save() {
    if ! have iw; then
        log "iw not installed; skipping Wi-Fi power save (NetworkManager profile also sets it)"
        return
    fi

    local iface
    for iface in $(iw dev 2>/dev/null | awk '$1 == "Interface" { print $2 }'); do
        if iw dev "${iface}" set power_save off 2>/dev/null; then
            log "Wi-Fi power save off on ${iface}"
        fi
    done
}

# ---------------------------------------------------------------------------
# HDMI / swap
# ---------------------------------------------------------------------------
disable_hdmi() {
    if have vcgencmd; then
        vcgencmd display_power 0 >/dev/null 2>&1 && log "HDMI display power off"
    fi
    if have tvservice; then
        tvservice -o >/dev/null 2>&1 || true
    fi
}

disable_swap() {
    if [ -n "$(swapon --noheadings 2>/dev/null)" ]; then
        swapoff -a 2>/dev/null && log "swap disabled"
    fi
}

set_governor
disable_usb_autosuspend
disable_wifi_power_save
disable_hdmi
disable_swap

log "done"
exit 0
