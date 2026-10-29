#!/bin/bash
# FPV Raspberry Pi Setup Script
# Run on a fresh Raspberry Pi OS (Bullseye or Bookworm) to install every
# dependency the Pi side of the FPV stack needs.

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

echo ""
echo "Installing for user: ${ACTUAL_USER}"
echo "FPV directory:      ${FPV_DIR}"
echo "Source directory:   ${SCRIPT_DIR}"
echo ""

# ---------------------------------------------------------------------------
# 1) System update
# ---------------------------------------------------------------------------
echo "[1/9] Updating system packages..."
apt update && apt upgrade -y

# ---------------------------------------------------------------------------
# 2) Video streaming stack
# ---------------------------------------------------------------------------
echo "[2/9] Installing GStreamer + ALSA..."
apt install -y \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    gstreamer1.0-alsa \
    libgstreamer1.0-dev \
    alsa-utils

# Only install the legacy OMX plugin on systems where it still exists
# (Bullseye). Bookworm uses libcamera + v4l2h264enc and has no omx package.
apt install -y gstreamer1.0-omx-rpi gstreamer1.0-omx-rpi-config 2>/dev/null || true

# The audio TX/RX services need access to ALSA devices (mic + speaker).
usermod -aG audio "${ACTUAL_USER}"

# ---------------------------------------------------------------------------
# 3) Python + serial + websocket deps for the control daemon
# ---------------------------------------------------------------------------
echo "[3/9] Installing Python dependencies..."
apt install -y python3-pip python3-serial

echo "[4/9] Installing Python packages..."
pip3 install --upgrade websocket-client pyserial --break-system-packages \
    || pip3 install --upgrade websocket-client pyserial

# The daemon opens the Arduino as /dev/fpv-arduino (owned by group dialout).
usermod -aG dialout "${ACTUAL_USER}"

# ---------------------------------------------------------------------------
# 5) LTE + networking (NetworkManager-first)
# ---------------------------------------------------------------------------
echo "[5/9] Installing LTE / NetworkManager packages..."
apt install -y \
    usb-modeswitch usb-modeswitch-data \
    network-manager modemmanager \
    iptables iproute2 iputils-ping

# Make NetworkManager the active network backend. On Raspberry Pi OS this
# usually just means disabling dhcpcd; NM comes pre-enabled on Bookworm.
systemctl enable NetworkManager 2>/dev/null || true
systemctl disable dhcpcd 2>/dev/null || true
systemctl stop dhcpcd 2>/dev/null || true

# ---------------------------------------------------------------------------
# 6) Camera
# ---------------------------------------------------------------------------
echo "[6/9] Configuring camera..."
# Handle both boot config paths (Bookworm moved it to /boot/firmware).
CONFIG_TXT="/boot/firmware/config.txt"
[ -f "${CONFIG_TXT}" ] || CONFIG_TXT="/boot/config.txt"

if [ -f "${CONFIG_TXT}" ] && ! grep -q "start_x=1" "${CONFIG_TXT}"; then
    {
        echo ""
        echo "# FPV camera"
        echo "start_x=1"
        echo "gpu_mem=128"
    } >> "${CONFIG_TXT}"
    echo "   Camera configuration added to ${CONFIG_TXT}. Reboot required."
fi

# Try to load the legacy V4L2 shim in case libcamera isn't being used.
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
fi

chown -R "${ACTUAL_USER}:${ACTUAL_USER}" "${FPV_DIR}"
chmod +x "${FPV_DIR}/video-stream.sh"
chmod +x "${FPV_DIR}/control-daemon/control_daemon.py"
# Audio TX/RX scripts (added alongside video for two-way comms).
[ -f "${FPV_DIR}/audio-stream-tx.sh" ] && chmod +x "${FPV_DIR}/audio-stream-tx.sh"
[ -f "${FPV_DIR}/audio-receive.sh" ]   && chmod +x "${FPV_DIR}/audio-receive.sh"
[ -f "${FPV_DIR}/scripts/net-watchdog.sh" ] && chmod +x "${FPV_DIR}/scripts/net-watchdog.sh"

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
        install -m 0600 -o root -g root "${conn}" "/etc/NetworkManager/system-connections/${base}"
    done
    nmcli connection reload 2>/dev/null || true
fi

# Net watchdog
if [ -f "${SCRIPT_DIR}/scripts/net-watchdog.sh" ]; then
    install -m 0755 "${SCRIPT_DIR}/scripts/net-watchdog.sh" \
        /usr/local/bin/fpv-net-watchdog.sh
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

# The watchdog units run as root and don't reference /home/pi, but still
# need CRLF stripped.
install_unit_plain "${SCRIPT_DIR}/systemd/fpv-net-watchdog.service" /etc/systemd/system/fpv-net-watchdog.service
install_unit_plain "${SCRIPT_DIR}/systemd/fpv-net-watchdog.timer"   /etc/systemd/system/fpv-net-watchdog.timer

systemctl daemon-reload
systemctl enable fpv-net-watchdog.timer 2>/dev/null || true

echo "[9/9] Done."

echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Edit ${FPV_DIR}/fpv.env"
echo "   Set JANUS_HOST, CONTROL_SERVER, and AUTH_TOKEN."
echo "   (AUTH_TOKEN must match CONTROL_AUTH_TOKEN in server/.env)"
echo "   Then reload:  sudo systemctl daemon-reload"
echo ""
echo "2. Edit /etc/NetworkManager/system-connections/wifi-fallback.nmconnection"
echo "   Set ssid + psk, then: sudo nmcli connection reload"
echo ""
echo "3. Install Tailscale (recommended, CGNAT-friendly):"
echo "   curl -fsSL https://tailscale.com/install.sh | sh"
echo "   sudo tailscale up"
echo ""
echo "4. Plug in the Arduino Nano (check: ls -l /dev/fpv-arduino)"
echo "   and the EIOTCLUB LTE dongle  (check: ip -br addr | grep -E 'usb0|eth1')"
echo ""
echo "5. Pick the right ALSA card numbers for your USB mic + speaker:"
echo "   arecord -l   # mic input  -> set MIC_DEVICE in fpv-audio-tx.service"
echo "   aplay -l     # speaker    -> set SPK_DEVICE in fpv-audio-rx.service"
echo "   (Most setups end up with plughw:1,0 once the USB audio gadget is the"
echo "    second card after the bcm2835 jack.)"
echo ""
echo "6. Enable and start services:"
echo "   sudo systemctl enable fpv-video fpv-control fpv-audio-tx fpv-audio-rx"
echo "   sudo systemctl start  fpv-video fpv-control fpv-audio-tx fpv-audio-rx"
echo ""
echo "7. Check status:"
echo "   systemctl status fpv-video fpv-control fpv-audio-tx fpv-audio-rx fpv-net-watchdog.timer"
echo "   journalctl -u fpv-audio-tx -f"
echo ""
echo "A reboot is recommended so the camera config and group membership"
echo "(video + audio) take effect."
echo ""
