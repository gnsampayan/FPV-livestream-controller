#!/bin/bash
# FPV Audio TX (Pi -> Server) Script.
#
# Captures the USB mic on the Pi, encodes Opus, and forwards RTP packets to
# the Janus streaming plugin alongside the existing H.264 video on the same
# mountpoint (id=1, video on 5004, audio on 5006).
#
# Defaults are tuned for Pi 3 v1.2 on LTE uplinks:
#   - 48 kHz mono input -> 24 kbps Opus
#   - 20 ms frames with FEC + 10% loss target
#   - MTU 1200 to stay under typical cellular MTU
#
# Override any knob via environment (see the systemd unit).

set -e

JANUS_HOST="${JANUS_HOST:-100.x.x.x}"            # Tailscale IP of your server
JANUS_AUDIO_PORT="${JANUS_AUDIO_PORT:-5006}"

MIC_DEVICE="${MIC_DEVICE:-plughw:1,0}"           # USB mic on card 1, device 0
SAMPLE_RATE="${AUDIO_SAMPLE_RATE:-48000}"
CHANNELS="${AUDIO_CHANNELS:-1}"
OPUS_BITRATE="${OPUS_BITRATE:-24000}"            # 24 kbps - good for voice
OPUS_FRAME_SIZE="${OPUS_FRAME_SIZE:-20}"         # ms per packet
OPUS_PT="${OPUS_PT:-111}"                        # Janus expects pt=111 for Opus
RTP_MTU="${RTP_MTU:-1200}"
UDP_BUFFER="${UDP_BUFFER:-65536}"

export GST_DEBUG="${GST_DEBUG:-0}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting FPV audio TX (Pi mic -> Janus)"
log "Target:  ${JANUS_HOST}:${JANUS_AUDIO_PORT} (RTP/UDP, pt=${OPUS_PT})"
log "Source:  ALSA ${MIC_DEVICE}, ${SAMPLE_RATE} Hz, ${CHANNELS}ch"
log "Encoder: Opus ${OPUS_BITRATE} bps, ${OPUS_FRAME_SIZE}ms frames, FEC on"

if ! command -v gst-launch-1.0 >/dev/null 2>&1; then
    log "ERROR: GStreamer not found. Install with:"
    log "  sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad}"
    exit 1
fi

# inband-fec=true + packet-loss-percentage=10 makes Opus ship redundant data
# inside the same packet so the receiver can mask short bursty loss without a
# retransmit. Cheap to encode (Pi 3 spends < 5% of one core on this) and
# pays off noticeably on cellular.
exec gst-launch-1.0 -v \
    alsasrc device="${MIC_DEVICE}" \
        ! "audio/x-raw,rate=${SAMPLE_RATE},channels=${CHANNELS}" \
    ! queue max-size-buffers=10 leaky=downstream \
    ! audioconvert \
    ! audioresample \
    ! opusenc bitrate=${OPUS_BITRATE} \
              frame-size=${OPUS_FRAME_SIZE} \
              inband-fec=true \
              packet-loss-percentage=10 \
              audio-type=voice \
    ! rtpopuspay pt=${OPUS_PT} mtu=${RTP_MTU} \
    ! udpsink host="${JANUS_HOST}" port="${JANUS_AUDIO_PORT}" \
              sync=false async=false buffer-size=${UDP_BUFFER}
