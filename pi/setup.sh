#!/bin/bash
# FPV Raspberry Pi Setup Script (Raspberry Pi 3 B v1.2 target).
# Run on a fresh Raspberry Pi OS (Bullseye or Bookworm) to install every
# dependency the Pi side of the FPV stack needs and apply the low-latency
# system tuning.
#
# Optional environment variables:
#   FPV_CAMERA_OVERLAY   Device-tree overlay for the camera (default: ov5647,
#                        the Camera Module v1). Set to an empty string to use
#                        camera_auto_detect instead (v2/v3/HQ cameras).
#   FPV_WIFI_COUNTRY     Two-letter Wi-Fi regulatory domain, e.g. US.
#   FPV_SKIP_UPGRADE=1   Skip `apt upgrade` (slow on a Pi 3 SD card).

set -e

echo "=========================================="
echo "FPV Raspberry Pi Setup Script"
echo "=========================================="

if [ "$EUID" -ne 0 ]; then
    echo "Please run as root: sudo ./setup.sh"
    exit 1
fi

ACTUAL_USER="${SUDO_USER:-pi}"
HOME_DIR="/home/${ACTUAL_USER}"
FPV_DIR="${HOME_DIR}/fpv"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CAMERA_OVERLAY="${FPV_CAMERA_OVERLAY-ov5647}"

echo ""
echo "Installing for user: ${ACTUAL_USER}"
echo "FPV directory:      ${FPV_DIR}"
echo "Source directory:   ${SCRIPT_DIR}"
echo ""

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1) System update
# ---------------------------------------------------------------------------
echo "[1/9] Updating system packages..."
apt update
if [ "${FPV_SKIP_UPGRADE:-0}" != "1" ]; then
    apt upgrade -y
fi

# ---------------------------------------------------------------------------
# 2) Video / audio streaming stack
# ---------------------------------------------------------------------------
echo "[2/9] Installing camera apps, GStreamer and ALSA..."
apt install -y \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    gstreamer1.0-alsa \
    alsa-utils \
    v4l-utils

# rpicam-vid drives the VideoCore IV hardware H.264 encoder. The package is
# rpicam-apps on Bookworm and libcamera-apps on Bullseye.
apt install -y rpicam-apps 2>/dev/null \
    || apt install -y libcamera-apps 2>/dev/null \
    || echo "   WARNING: no rpicam-apps/libcamera-apps package found; video will fall back to another stack."

# Legacy OMX plugin: only exists on Bullseye, harmless to skip elsewhere.
apt install -y gstreamer1.0-omx-rpi gstreamer1.0-omx-rpi-config 2>/dev/null || true

# The audio TX/RX services need access to ALSA devices (mic + speaker).
usermod -aG audio "${ACTUAL_USER}"

# ---------------------------------------------------------------------------
# 3) Python + serial for the control daemon
# ---------------------------------------------------------------------------
echo "[3/9] Installing Python dependencies..."
apt install -y python3 python3-serial

# The daemon opens the Arduino as /dev/fpv-arduino (owned by group dialout).
usermod -aG dialout "${ACTUAL_USER}"

# ---------------------------------------------------------------------------
# 4) Kernel tunables and logging
# ---------------------------------------------------------------------------
echo "[4/9] Applying kernel tunables and RAM-only logging..."
if [ -f "${SCRIPT_DIR}/system/99-fpv-sysctl.conf" ]; then
    install -m 0644 "${SCRIPT_DIR}/system/99-fpv-sysctl.conf" /etc/sysctl.d/99-fpv.conf
    sysctl --system >/dev/null 2>&1 || true
fi

if [ -f "${SCRIPT_DIR}/system/journald-fpv.conf" ]; then
    mkdir -p /etc/systemd/journald.conf.d
    install -m 0644 "${SCRIPT_DIR}/system/journald-fpv.conf" /etc/systemd/journald.conf.d/fpv.conf
    systemctl restart systemd-journald 2>/dev/null || true
fi

# CAKE queue discipline (used by the NetworkManager dispatcher to shape the
# uplink). Load it now and on every boot; the dispatcher falls back to
# fq_codel if it is unavailable.
if modprobe sch_cake 2>/dev/null; then
    echo "sch_cake" > /etc/modules-load.d/fpv-cake.conf
else
    echo "   NOTE: sch_cake kernel module not available; uplink shaping will use fq_codel."
fi

# Swap on an SD card means multi-millisecond stalls.
dphys-swapfile swapoff 2>/dev/null || true
systemctl disable --now dphys-swapfile 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5) LTE + networking (NetworkManager-first)
# ---------------------------------------------------------------------------
echo "[5/9] Installing LTE / NetworkManager packages..."
# ModemManager is intentionally NOT installed: the EIOTCLUB dongle is a
# HiLink/RNDIS device (it dials by itself and shows up as a USB Ethernet
# interface), and ModemManager only wastes CPU probing it.
apt install -y \
    usb-modeswitch usb-modeswitch-data \
    network-manager \
    iptables iproute2 iputils-ping iw

# Make NetworkManager the active network backend. On Raspberry Pi OS this
# usually just means disabling dhcpcd; NM comes pre-enabled on Bookworm.
systemctl enable NetworkManager 2>/dev/null || true
systemctl disable dhcpcd 2>/dev/null || true
systemctl stop dhcpcd 2>/dev/null || true

# Services the FPV build never uses: stop them from competing for the one
# core that also handles interrupts. (avahi is left alone so raspberrypi.local
# keeps resolving for SSH.)
for unwanted in ModemManager triggerhappy apt-daily.timer apt-daily-upgrade.timer; do
    systemctl disable --now "${unwanted}" 2>/dev/null || true
done

if [ -n "${FPV_WIFI_COUNTRY:-}" ]; then
    if command -v raspi-config >/dev/null 2>&1; then
        raspi-config nonint do_wifi_country "${FPV_WIFI_COUNTRY}" || true
        echo "   Wi-Fi regulatory domain set to ${FPV_WIFI_COUNTRY}."
    else
        iw reg set "${FPV_WIFI_COUNTRY}" 2>/dev/null || true
    fi
else
    echo "   NOTE: set FPV_WIFI_COUNTRY=<CC> (or run raspi-config) so Wi-Fi uses the"
    echo "         right regulatory domain; the wrong one can cap power and channels."
fi

# ---------------------------------------------------------------------------
# 6) Camera + boot configuration
# ---------------------------------------------------------------------------
echo "[6/9] Configuring camera and boot options..."
# Handle both boot config paths (Bookworm moved it to /boot/firmware).
CONFIG_TXT="/boot/firmware/config.txt"
[ -f "${CONFIG_TXT}" ] || CONFIG_TXT="/boot/config.txt"

# Append a line to config.txt unless an identical active line already exists.
ensure_config_line() {
    local line="$1"
    if ! grep -qxF "${line}" "${CONFIG_TXT}"; then
        echo "${line}" >> "${CONFIG_TXT}"
        CONFIG_CHANGED=1
    fi
}

# Rewrite "key=old" to "key=new" if present; otherwise append "key=new".
set_config_value() {
    local key="$1" value="$2"
    if grep -Eq "^${key}=" "${CONFIG_TXT}"; then
        if ! grep -qxF "${key}=${value}" "${CONFIG_TXT}"; then
            sed -i -E "s/^${key}=.*/${key}=${value}/" "${CONFIG_TXT}"
            CONFIG_CHANGED=1
        fi
    else
        echo "${key}=${value}" >> "${CONFIG_TXT}"
        CONFIG_CHANGED=1
    fi
}

CONFIG_CHANGED=0

if [ -f "${CONFIG_TXT}" ]; then
    if ! grep -q "^# FPV (managed by setup.sh)" "${CONFIG_TXT}"; then
        printf '\n# FPV (managed by setup.sh)\n' >> "${CONFIG_TXT}"
    fi

    if command -v rpicam-vid >/dev/null 2>&1 || command -v libcamera-vid >/dev/null 2>&1; then
        # libcamera stack. The legacy firmware camera switch (start_x=1)
        # conflicts with it: the camera is claimed by the firmware instead of
        # libcamera, which breaks rpicam-vid and its hardware encoder path.
        if grep -Eq "^start_x=1" "${CONFIG_TXT}"; then
            sed -i -E 's/^start_x=1/#start_x=1 (disabled by FPV setup: conflicts with libcamera)/' "${CONFIG_TXT}"
            CONFIG_CHANGED=1
            echo "   Disabled legacy start_x=1 (conflicts with libcamera)."
        fi

        if [ -n "${CAMERA_OVERLAY}" ]; then
            # The v1 camera (OV5647) is not reliably auto-detected.
            set_config_value camera_auto_detect 0
            ensure_config_line "dtoverlay=${CAMERA_OVERLAY}"
        else
            set_config_value camera_auto_detect 1
        fi
    else
        # Legacy firmware camera stack (raspivid).
        ensure_config_line "start_x=1"
    fi

    # The hardware H.264 encoder lives in the VPU firmware and needs GPU memory.
    set_config_value gpu_mem 128

    # Bluetooth shares the 2.4 GHz radio with Wi-Fi on the Pi 3. Nothing here
    # uses it, and disabling it removes coexistence interference.
    ensure_config_line "dtoverlay=disable-bt"

    if [ "${CONFIG_CHANGED}" -eq 1 ]; then
        echo "   Boot configuration updated in ${CONFIG_TXT}. Reboot required."
    fi
else
    echo "   WARNING: no config.txt found; camera and Bluetooth settings not applied."
fi

systemctl disable --now hciuart bluetooth 2>/dev/null || true

# Try to load the legacy V4L2 shim in case the legacy stack is in use.
modprobe bcm2835-v4l2 2>/dev/null || true

# ---------------------------------------------------------------------------
# 7) Install FPV files into ~pi/fpv and set permissions
# ---------------------------------------------------------------------------
echo "[7/9] Setting up FPV directory at ${FPV_DIR}..."
mkdir -p "${FPV_DIR}/control-daemon" "${FPV_DIR}/scripts"
# Skip the copy when the script is already running from inside FPV_DIR
# (cp -r would error trying to copy each subdir into itself, and set -e
# would abort the rest of the setup).
if [ "${SCRIPT_DIR}" != "${FPV_DIR}" ]; then
    cp -r "${SCRIPT_DIR}/"* "${FPV_DIR}/"
fi
# Install the deployment env file from the template if one doesn't already
# exist. This file holds secrets (AUTH_TOKEN, server IPs) that the systemd
# services load via EnvironmentFile=.  Mode 0600 so only the owning user
# (and root) can read it.
if [ ! -f "${FPV_DIR}/fpv.env" ]; then
    if [ -f "${SCRIPT_DIR}/fpv.env.example" ]; then
        install -m 0600 -o "${ACTUAL_USER}" -g "${ACTUAL_USER}" \
            "${SCRIPT_DIR}/fpv.env.example" "${FPV_DIR}/fpv.env"
        echo "   Created ${FPV_DIR}/fpv.env from template — edit it with your secrets."
    fi
else
    if ! grep -q "^CONTROL_RELAY_PORT=" "${FPV_DIR}/fpv.env"; then
        echo "   NOTE: ${FPV_DIR}/fpv.env predates the UDP control link. Add"
        echo "         CONTROL_RELAY_HOST / CONTROL_RELAY_PORT (see fpv.env.example);"
        echo "         until then the daemon falls back to JANUS_HOST and port 3002."
    fi
fi

chown -R "${ACTUAL_USER}:${ACTUAL_USER}" "${FPV_DIR}"
chmod +x "${FPV_DIR}/video-stream.sh"
chmod +x "${FPV_DIR}/control-daemon/control_daemon.py"
# Audio TX/RX scripts (added alongside video for two-way comms).
[ -f "${FPV_DIR}/audio-stream-tx.sh" ] && chmod +x "${FPV_DIR}/audio-stream-tx.sh"
[ -f "${FPV_DIR}/audio-receive.sh" ]   && chmod +x "${FPV_DIR}/audio-receive.sh"
for helper in fpv-diag.sh fpv-audio-detect.sh fpv-vpn-bench.sh; do
    [ -f "${FPV_DIR}/scripts/${helper}" ] && chmod +x "${FPV_DIR}/scripts/${helper}"
done

# Convenience command: `fpv-diag` prints a latency/health snapshot.
if [ -f "${FPV_DIR}/scripts/fpv-diag.sh" ]; then
    ln -sf "${FPV_DIR}/scripts/fpv-diag.sh" /usr/local/bin/fpv-diag
fi

# Arduino udev rule -> stable /dev/fpv-arduino symlink
if [ -f "${SCRIPT_DIR}/udev/99-fpv-arduino.rules" ]; then
    install -m 0644 "${SCRIPT_DIR}/udev/99-fpv-arduino.rules" \
        /etc/udev/rules.d/99-fpv-arduino.rules
    udevadm control --reload
    udevadm trigger
fi

# NetworkManager connection profiles
if [ -d "${SCRIPT_DIR}/network" ]; then
    mkdir -p /etc/NetworkManager/system-connections
    for conn in "${SCRIPT_DIR}/network/"*.nmconnection; do
        [ -e "${conn}" ] || continue
        base="$(basename "${conn}")"
        # Don't clobber a profile the operator already edited with real
        # credentials; the template is only a starting point.
        if [ -e "/etc/NetworkManager/system-connections/${base}" ]; then
            echo "   Keeping existing /etc/NetworkManager/system-connections/${base}"
            continue
        fi
        install -m 0600 -o root -g root "${conn}" "/etc/NetworkManager/system-connections/${base}"
    done
    nmcli connection reload 2>/dev/null || true
fi

# Network shaping: uplink caps + NetworkManager dispatcher (CAKE + DSCP tins).
if [ -f "${SCRIPT_DIR}/network/fpv-network.env.example" ] && [ ! -f /etc/default/fpv-network ]; then
    install -m 0644 "${SCRIPT_DIR}/network/fpv-network.env.example" /etc/default/fpv-network
    echo "   Created /etc/default/fpv-network — set the uplink caps to ~85-90% of your real uplink."
fi
if [ -f "${SCRIPT_DIR}/network/dispatcher/90-fpv-qos" ]; then
    mkdir -p /etc/NetworkManager/dispatcher.d
    sed 's/\r$//' "${SCRIPT_DIR}/network/dispatcher/90-fpv-qos" \
        > /etc/NetworkManager/dispatcher.d/90-fpv-qos
    chown root:root /etc/NetworkManager/dispatcher.d/90-fpv-qos
    chmod 0755 /etc/NetworkManager/dispatcher.d/90-fpv-qos
fi

# Root helper scripts (link manager, boot-time tuning, optional governor).
install_root_script() {
    local src="$1"
    local dst="$2"
    [ -f "${src}" ] || return 0
    sed 's/\r$//' "${src}" > "${dst}"
    chown root:root "${dst}"
    chmod 0755 "${dst}"
}
install_root_script "${SCRIPT_DIR}/scripts/link-manager.sh"          /usr/local/bin/fpv-link-manager.sh
install_root_script "${SCRIPT_DIR}/scripts/fpv-tune.sh"              /usr/local/bin/fpv-tune.sh
install_root_script "${SCRIPT_DIR}/scripts/fpv-bitrate-governor.sh"  /usr/local/bin/fpv-bitrate-governor.sh

# Pick stable ALSA card ids for the USB mic/speaker if they are plugged in.
if [ -x "${FPV_DIR}/scripts/fpv-audio-detect.sh" ] && [ -f "${FPV_DIR}/fpv.env" ]; then
    sudo -u "${ACTUAL_USER}" "${FPV_DIR}/scripts/fpv-audio-detect.sh" --write "${FPV_DIR}/fpv.env" \
        || echo "   Skipped ALSA auto-detect (no USB audio yet). Re-run scripts/fpv-audio-detect.sh --write later."
fi

# ---------------------------------------------------------------------------
# 8) systemd units
# ---------------------------------------------------------------------------
# The unit files in the repo are templated for the legacy "pi" user and
# /home/pi path. Rewrite them to ${ACTUAL_USER} on install so they work on
# modern Raspberry Pi OS (Imager no longer creates the default pi user).
#
# We also strip CRLF line endings defensively: files often get to the Pi via
# scp from a Windows working tree, and CRLF in a systemd unit silently
# defeats line-anchored sed patterns (and can confuse systemd's parser in
# some cases too).
echo "[8/9] Installing systemd services..."

install_unit_for_user() {
    local src="$1"
    local dst="$2"
    [ -f "${src}" ] || return 0
    sed \
        -e 's/\r$//' \
        -e "s|^User=pi$|User=${ACTUAL_USER}|" \
        -e "s|^Group=pi$|Group=${ACTUAL_USER}|" \
        -e "s|/home/pi/fpv|${FPV_DIR}|g" \
        "${src}" > "${dst}"
    chmod 0644 "${dst}"
}

install_unit_plain() {
    local src="$1"
    local dst="$2"
    [ -f "${src}" ] || return 0
    sed 's/\r$//' "${src}" > "${dst}"
    chmod 0644 "${dst}"
}

install_unit_for_user "${SCRIPT_DIR}/systemd/fpv-video.service"        /etc/systemd/system/fpv-video.service
install_unit_for_user "${SCRIPT_DIR}/systemd/fpv-control.service"      /etc/systemd/system/fpv-control.service
install_unit_for_user "${SCRIPT_DIR}/systemd/fpv-audio-tx.service"     /etc/systemd/system/fpv-audio-tx.service
install_unit_for_user "${SCRIPT_DIR}/systemd/fpv-audio-rx.service"     /etc/systemd/system/fpv-audio-rx.service

# These run as root and don't reference /home/pi, but still need CRLF stripped.
install_unit_plain "${SCRIPT_DIR}/systemd/fpv-tune.service"             /etc/systemd/system/fpv-tune.service
install_unit_plain "${SCRIPT_DIR}/systemd/fpv-link-manager.service"     /etc/systemd/system/fpv-link-manager.service
install_unit_plain "${SCRIPT_DIR}/systemd/fpv-bitrate-governor.service" /etc/systemd/system/fpv-bitrate-governor.service

# Retire the old 30-second ping watchdog; fpv-link-manager replaces it.
systemctl disable --now fpv-net-watchdog.timer 2>/dev/null || true
systemctl disable --now fpv-net-watchdog.service 2>/dev/null || true
rm -f /etc/systemd/system/fpv-net-watchdog.service \
      /etc/systemd/system/fpv-net-watchdog.timer \
      /usr/local/bin/fpv-net-watchdog.sh

systemctl daemon-reload
systemctl enable fpv-tune.service 2>/dev/null || true
systemctl enable fpv-link-manager.service 2>/dev/null || true

echo "[9/9] Done."

echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Edit ${FPV_DIR}/fpv.env"
echo "   Set JANUS_HOST, CONTROL_RELAY_HOST/PORT, and AUTH_TOKEN."
echo "   (AUTH_TOKEN must match CONTROL_AUTH_TOKEN in server/.env)"
echo "   Pick VIDEO_PRESET=latency|balanced|quality."
echo "   Then reload:  sudo systemctl daemon-reload"
echo ""
echo "2. Edit /etc/NetworkManager/system-connections/wifi-fallback.nmconnection"
echo "   Set ssid + psk, then: sudo nmcli connection reload"
echo ""
echo "3. Edit /etc/default/fpv-network"
echo "   Set FPV_LTE_UPLINK_KBIT / FPV_WIFI_UPLINK_KBIT to ~85-90% of the real uplink."
echo ""
echo "4. Install Tailscale (recommended, CGNAT-friendly):"
echo "   curl -fsSL https://tailscale.com/install.sh | sh"
echo "   sudo tailscale up"
echo "   (To compare against kernel WireGuard: scripts/fpv-vpn-bench.sh)"
echo ""
echo "5. Plug in the Arduino Nano (check: ls -l /dev/fpv-arduino)"
echo "   and the EIOTCLUB LTE dongle  (check: ip -br addr | grep -E 'usb0|eth1')"
echo ""
echo "6. Check the USB mic + speaker were detected as stable ALSA card ids:"
echo "   grep -E 'MIC_DEVICE|SPK_DEVICE' ${FPV_DIR}/fpv.env"
echo "   (re-detect any time:  ${FPV_DIR}/scripts/fpv-audio-detect.sh --write)"
echo ""
echo "7. Reboot (camera overlay, Bluetooth-off and group membership need it), then:"
echo "   sudo systemctl enable fpv-video fpv-control fpv-audio-tx fpv-audio-rx"
echo "   sudo systemctl start  fpv-video fpv-control fpv-audio-tx fpv-audio-rx"
echo ""
echo "8. Check status:"
echo "   systemctl status fpv-video fpv-control fpv-audio-tx fpv-audio-rx fpv-link-manager"
echo "   journalctl -u fpv-video -f"
echo "   fpv-diag            # per-core load, temperature, scheduling, link health"
echo ""
