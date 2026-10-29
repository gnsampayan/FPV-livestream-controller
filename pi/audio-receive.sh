#!/bin/bash
# FPV Audio RX (Server -> Pi) Script.
#
# Listens on a UDP port for Opus RTP packets forwarded by the Janus
# AudioBridge plugin, decodes them, and plays the result through ALSA on
# the Pi. Pairs with the audiobridge-bootstrap sidecar in docker-compose,
# which configures Janus to send the mixed room audio here.
#
# Defaults are tuned for Pi 3 v1.2:
#   - 80 ms jitter buffer (cheap on this CPU; covers most cellular jitter)
#   - audio playback only, sync=false (latency over A/V sync; this is voice)
#
# Override any knob via environment (see the systemd unit).

set -e

AUDIO_RX_PORT="${AUDIO_RX_PORT:-5008}"
OPUS_PT="${OPUS_PT:-111}"
JITTER_LATENCY_MS="${JITTER_LATENCY_MS:-80}"

SPK_DEVICE="${SPK_DEVICE:-plughw:1,0}"   # USB speaker on card 1, device 0
UDP_BUFFER="${UDP_BUFFER:-65536}"

export GST_DEBUG="${GST_DEBUG:-0}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting FPV audio RX (Janus -> Pi speaker)"
log "Listen:  UDP 0.0.0.0:${AUDIO_RX_PORT} (Opus pt=${OPUS_PT})"
log "Sink:    ALSA ${SPK_DEVICE}, jitter=${JITTER_LATENCY_MS}ms"

if ! command -v gst-launch-1.0 >/dev/null 2>&1; then
    log "ERROR: GStreamer not found. Install with:"
    log "  sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad}"
    exit 1
fi

# rtpjitterbuffer reorders out-of-order packets and absorbs short jitter
# bursts, which is essential over cellular. 80ms is a good default for the
# Pi 3 - tighter values save latency but cause crackles when the network
# hiccups; looser values feel laggy when talking back and forth.
exec gst-launch-1.0 -v \
    udpsrc port="${AUDIO_RX_PORT}" buffer-size=${UDP_BUFFER} \
        caps="application/x-rtp,media=audio,encoding-name=OPUS,payload=${OPUS_PT},clock-rate=48000" \
    ! rtpjitterbuffer latency=${JITTER_LATENCY_MS} drop-on-latency=true \
    ! rtpopusdepay \
    ! opusdec \
    ! audioconvert \
    ! audioresample \
    ! alsasink device="${SPK_DEVICE}" sync=false async=false
