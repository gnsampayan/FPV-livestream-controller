#!/bin/bash
# FPV Audio TX (Pi -> Server) Script.
#
# Captures the USB mic on the Pi, encodes Opus, and forwards RTP packets to
# the Janus streaming plugin alongside the existing H.264 video on the same
# mountpoint (id=1, video on 5004, audio on 5006).
#
# Tuned for minimum mouth-to-ear delay on a Pi 3 B v1.2 over LTE:
#   - 48 kHz mono input, 24 kbps CBR Opus (voice mode)
#   - 10 ms Opus frames (default). Each frame saves 10 ms versus the common
#     20 ms, at the cost of ~2x packet rate (RTP/UDP/IP overhead). Set
#     OPUS_FRAME_SIZE=20 if the uplink is tight.
#   - Small ALSA capture buffer (latency-time = one Opus frame)
#   - In-band FEC + 10% loss target so short bursty loss is concealed without
#     any retransmit
#   - Encoder complexity 5: audibly identical to 10 for voice, ~half the CPU
#   - DSCP EF (46) on the RTP socket so a shaped uplink sends audio first
#
# Override any knob via environment (see the systemd unit / fpv.env).

set -eu

JANUS_HOST="${JANUS_HOST:-100.x.x.x}"            # Tailscale IP of your server
JANUS_AUDIO_PORT="${JANUS_AUDIO_PORT:-5006}"

# Prefer an ALSA card *id* (plughw:CARD=<id>,DEV=0) over a card number so the
# device keeps working when USB enumeration order changes. Run
# scripts/fpv-audio-detect.sh to find and persist the right value.
MIC_DEVICE="${MIC_DEVICE:-plughw:1,0}"
SAMPLE_RATE="${AUDIO_SAMPLE_RATE:-48000}"
CHANNELS="${AUDIO_CHANNELS:-1}"
OPUS_BITRATE="${OPUS_BITRATE:-24000}"            # 24 kbps - good for voice
OPUS_FRAME_SIZE="${OPUS_FRAME_SIZE:-10}"         # ms per packet
OPUS_COMPLEXITY="${OPUS_COMPLEXITY:-5}"
OPUS_PT="${OPUS_PT:-111}"                        # Janus expects pt=111 for Opus
RTP_MTU="${RTP_MTU:-1200}"
UDP_BUFFER="${UDP_BUFFER:-65536}"
AUDIO_DSCP="${AUDIO_DSCP:-46}"                   # EF

# ALSA capture timing in microseconds. latency-time is the period size: one
# Opus frame, so the encoder never waits for more samples than it needs.
ALSA_LATENCY_US="${ALSA_LATENCY_US:-$((OPUS_FRAME_SIZE * 1000))}"
ALSA_BUFFER_US="${ALSA_BUFFER_US:-$((ALSA_LATENCY_US * 3))}"

export GST_DEBUG="${GST_DEBUG:-0}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting FPV audio TX (Pi mic -> Janus)"
log "Target:  ${JANUS_HOST}:${JANUS_AUDIO_PORT} (RTP/UDP, pt=${OPUS_PT}, dscp=${AUDIO_DSCP})"
log "Source:  ALSA ${MIC_DEVICE}, ${SAMPLE_RATE} Hz, ${CHANNELS}ch, period=${ALSA_LATENCY_US}us"
log "Encoder: Opus ${OPUS_BITRATE} bps CBR, ${OPUS_FRAME_SIZE}ms frames, complexity ${OPUS_COMPLEXITY}, FEC on"

if ! command -v gst-launch-1.0 >/dev/null 2>&1; then
    log "ERROR: GStreamer not found. Install with:"
    log "  sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad}"
    exit 1
fi

# inband-fec=true + packet-loss-percentage=10 makes Opus ship redundant data
# inside the same packet so the receiver can mask short bursty loss without a
# retransmit.
exec gst-launch-1.0 -q \
    alsasrc device="${MIC_DEVICE}" \
            buffer-time="${ALSA_BUFFER_US}" \
            latency-time="${ALSA_LATENCY_US}" \
    ! "audio/x-raw,rate=${SAMPLE_RATE},channels=${CHANNELS}" \
    ! queue max-size-buffers=4 max-size-time=0 max-size-bytes=0 leaky=downstream \
    ! audioconvert \
    ! audioresample \
    ! opusenc bitrate="${OPUS_BITRATE}" \
              bitrate-type=cbr \
              frame-size="${OPUS_FRAME_SIZE}" \
              complexity="${OPUS_COMPLEXITY}" \
              inband-fec=true \
              packet-loss-percentage=10 \
              audio-type=voice \
    ! rtpopuspay pt="${OPUS_PT}" mtu="${RTP_MTU}" \
    ! udpsink host="${JANUS_HOST}" port="${JANUS_AUDIO_PORT}" \
              sync=false async=false buffer-size="${UDP_BUFFER}" \
              qos-dscp="${AUDIO_DSCP}"
