#!/bin/bash
# FPV Audio RX (Server -> Pi) Script.
#
# Listens on a UDP port for Opus RTP packets forwarded by the Janus
# AudioBridge plugin, decodes them, and plays the result through ALSA on
# the Pi. Pairs with the audiobridge-bootstrap sidecar in docker-compose,
# which configures Janus to send the mixed room audio here.
#
# Tuned for minimum delay on a Pi 3 B v1.2:
#   - 40 ms jitter buffer by default (was 80 ms). Raise JITTER_LATENCY_MS if
#     speech crackles on a bad link; lower it on a clean Wi-Fi path.
#   - do-lost=true lets the decoder conceal gaps (packet loss concealment)
#     instead of stalling, and use-inband-fec recovers a lost frame from the
#     next packet's redundant data.
#   - Small ALSA playback buffer (10 ms periods, 40 ms total) and a sink that
#     never waits on the pipeline clock (sync=false).
#
# The Janus AudioBridge mixes in fixed 20 ms frames, so ~20 ms of that leg is
# a floor that cannot be configured away from the Pi.
#
# Override any knob via environment (see the systemd unit / fpv.env).

set -eu

AUDIO_RX_PORT="${AUDIO_RX_PORT:-5008}"
OPUS_PT="${OPUS_PT:-111}"
JITTER_LATENCY_MS="${JITTER_LATENCY_MS:-40}"

# Prefer an ALSA card *id* (plughw:CARD=<id>,DEV=0) over a card number.
# See scripts/fpv-audio-detect.sh.
SPK_DEVICE="${SPK_DEVICE:-plughw:1,0}"
UDP_BUFFER="${UDP_BUFFER:-65536}"

ALSA_LATENCY_US="${ALSA_LATENCY_US:-10000}"
ALSA_BUFFER_US="${ALSA_BUFFER_US:-40000}"

export GST_DEBUG="${GST_DEBUG:-0}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting FPV audio RX (Janus -> Pi speaker)"
log "Listen:  UDP 0.0.0.0:${AUDIO_RX_PORT} (Opus pt=${OPUS_PT})"
log "Sink:    ALSA ${SPK_DEVICE}, jitter=${JITTER_LATENCY_MS}ms, period=${ALSA_LATENCY_US}us"

if ! command -v gst-launch-1.0 >/dev/null 2>&1; then
    log "ERROR: GStreamer not found. Install with:"
    log "  sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad}"
    exit 1
fi

# rtpjitterbuffer reorders out-of-order packets and absorbs short jitter
# bursts, which is essential over cellular. drop-on-latency discards packets
# that arrive too late instead of growing the delay.
exec gst-launch-1.0 -q \
    udpsrc port="${AUDIO_RX_PORT}" buffer-size="${UDP_BUFFER}" \
        caps="application/x-rtp,media=audio,encoding-name=OPUS,payload=${OPUS_PT},clock-rate=48000" \
    ! rtpjitterbuffer latency="${JITTER_LATENCY_MS}" drop-on-latency=true do-lost=true \
    ! rtpopusdepay \
    ! opusdec use-inband-fec=true \
    ! audioconvert \
    ! audioresample \
    ! alsasink device="${SPK_DEVICE}" \
               buffer-time="${ALSA_BUFFER_US}" \
               latency-time="${ALSA_LATENCY_US}" \
               sync=false async=false
