#!/bin/bash
# FPV Video Streaming Script for Raspberry Pi 3 B v1.2 (OV5647 camera).
#
# Pipeline:
#
#   camera -> ISP -> VideoCore IV hardware H.264 encoder -> stdout
#          -> GStreamer (h264parse -> RTP payloader -> UDP) -> Janus
#
# The Pi 3's VideoCore IV encodes H.264 in dedicated silicon, so the four
# Cortex-A53 cores stay free for audio, control and the network stack. The
# GStreamer tail only repacketizes already-encoded frames, which costs a few
# percent of one core.
#
# Capture stacks (CAMERA_STACK):
#   rpicam   - rpicam-vid (Bookworm) or libcamera-vid (Bullseye). Preferred.
#   raspivid - legacy firmware camera stack (needs start_x=1 in config.txt).
#   software - GStreamer + x264enc on the CPU. Last resort; high CPU.
#   auto     - first of the above that is installed.
#
# Latency notes:
#   - Higher framerate lowers capture-to-encode delay by itself: a frame
#     interval is 16.7 ms at 60 fps versus 33 ms at 30 fps.
#   - --flush makes the encoder write each frame to the pipe immediately
#     instead of waiting for a full buffer.
#   - --inline repeats SPS/PPS on every keyframe so new viewers can decode
#     as soon as the next keyframe arrives (KEYFRAME_INTERVAL frames).
#   - RTP MTU 1200 stays under typical cellular MTU (no fragmentation).
#
# Every knob can be overridden from the environment (see fpv.env.example).

set -eu
set -o pipefail

JANUS_HOST="${JANUS_HOST:-100.x.x.x}"           # Tailscale IP of your server
JANUS_PORT="${JANUS_PORT:-5004}"

# ---------------------------------------------------------------------------
# Presets (width, height, framerate, bitrate, keyframe interval in frames)
# ---------------------------------------------------------------------------
VIDEO_PRESET="${VIDEO_PRESET:-latency}"

case "${VIDEO_PRESET}" in
    latency)  PRESET_WIDTH=640;  PRESET_HEIGHT=480;  PRESET_FPS=60; PRESET_BITRATE=1200000; PRESET_GOP=30 ;;
    balanced) PRESET_WIDTH=1280; PRESET_HEIGHT=720;  PRESET_FPS=30; PRESET_BITRATE=2000000; PRESET_GOP=30 ;;
    quality)  PRESET_WIDTH=1920; PRESET_HEIGHT=1080; PRESET_FPS=30; PRESET_BITRATE=3500000; PRESET_GOP=30 ;;
    *)
        echo "ERROR: Unknown VIDEO_PRESET='${VIDEO_PRESET}' (use latency|balanced|quality)" >&2
        exit 1
        ;;
esac

WIDTH="${VIDEO_WIDTH:-${PRESET_WIDTH}}"
HEIGHT="${VIDEO_HEIGHT:-${PRESET_HEIGHT}}"
FRAMERATE="${VIDEO_FRAMERATE:-${PRESET_FPS}}"
BITRATE="${VIDEO_BITRATE:-${PRESET_BITRATE}}"
KEYFRAME_INTERVAL="${KEYFRAME_INTERVAL:-${PRESET_GOP}}"
H264_LEVEL="${VIDEO_H264_LEVEL:-4}"

EXPOSURE="${VIDEO_EXPOSURE:-sport}"
AWB="${VIDEO_AWB:-auto}"
SHUTTER_US="${VIDEO_SHUTTER_US:-}"
SENSOR_MODE="${VIDEO_SENSOR_MODE:-}"
EXTRA_ARGS="${VIDEO_EXTRA_ARGS:-}"

MTU="${RTP_MTU:-1200}"                           # cellular-safe
UDP_BUFFER="${UDP_BUFFER:-65536}"
VIDEO_DSCP="${VIDEO_DSCP:-26}"                   # AF31

CAMERA_STACK="${CAMERA_STACK:-auto}"

# Silence GStreamer's debug channel unless the operator explicitly asked for it.
export GST_DEBUG="${GST_DEBUG:-0}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

have() {
    command -v "$1" >/dev/null 2>&1
}

if ! have gst-launch-1.0; then
    log "ERROR: GStreamer not found. Install with:"
    log "  sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad}"
    exit 1
fi

# ---------------------------------------------------------------------------
# Stack selection
# ---------------------------------------------------------------------------
RPICAM_BIN=""
if have rpicam-vid; then
    RPICAM_BIN="rpicam-vid"
elif have libcamera-vid; then
    RPICAM_BIN="libcamera-vid"
fi

if [ "${CAMERA_STACK}" = "auto" ]; then
    if [ -n "${RPICAM_BIN}" ]; then
        CAMERA_STACK="rpicam"
    elif have raspivid; then
        CAMERA_STACK="raspivid"
    else
        CAMERA_STACK="software"
    fi
    log "Auto-selected camera stack: ${CAMERA_STACK}"
fi

log "Starting FPV video stream"
log "Target:     ${JANUS_HOST}:${JANUS_PORT} (RTP/UDP, mtu=${MTU}, dscp=${VIDEO_DSCP})"
log "Preset:     ${VIDEO_PRESET}"
log "Video:      ${WIDTH}x${HEIGHT}@${FRAMERATE}fps, ${BITRATE} bps, GOP=${KEYFRAME_INTERVAL}"
log "Stack:      ${CAMERA_STACK}"

# ---------------------------------------------------------------------------
# Shared RTP tail: raw Annex-B H.264 on stdin -> RTP/UDP to Janus.
# ---------------------------------------------------------------------------
run_rtp_tail() {
    gst-launch-1.0 -q \
        fdsrc fd=0 do-timestamp=true \
        ! h264parse \
        ! rtph264pay pt=96 config-interval=1 aggregate-mode=zero-latency mtu="${MTU}" \
        ! udpsink host="${JANUS_HOST}" port="${JANUS_PORT}" \
                  sync=false async=false buffer-size="${UDP_BUFFER}" \
                  qos-dscp="${VIDEO_DSCP}"
}

# ---------------------------------------------------------------------------
# Capture stacks
# ---------------------------------------------------------------------------
run_rpicam() {
    if [ -z "${RPICAM_BIN}" ]; then
        log "ERROR: rpicam-vid / libcamera-vid not found. Install with: sudo apt install rpicam-apps"
        exit 1
    fi

    log "Using ${RPICAM_BIN} (hardware H.264 encoder)"

    local -a args=(
        --timeout 0
        --nopreview
        --codec h264
        --profile baseline
        --level "${H264_LEVEL}"
        --inline
        --flush
        --width "${WIDTH}"
        --height "${HEIGHT}"
        --framerate "${FRAMERATE}"
        --bitrate "${BITRATE}"
        --intra "${KEYFRAME_INTERVAL}"
        --denoise off
        --exposure "${EXPOSURE}"
        --awb "${AWB}"
    )

    if [ -n "${SHUTTER_US}" ]; then
        args+=(--shutter "${SHUTTER_US}")
    fi
    if [ -n "${SENSOR_MODE}" ]; then
        args+=(--mode "${SENSOR_MODE}")
    fi
    if [ -n "${EXTRA_ARGS}" ]; then
        # Intentional word splitting: operator-supplied raw arguments.
        # shellcheck disable=SC2206
        args+=(${EXTRA_ARGS})
    fi
    args+=(--output -)

    "${RPICAM_BIN}" "${args[@]}" | run_rtp_tail
}

run_raspivid() {
    if ! have raspivid; then
        log "ERROR: raspivid not found (legacy camera stack is not installed)."
        exit 1
    fi

    log "Using raspivid (legacy firmware camera stack, hardware H.264 encoder)"

    raspivid \
        --timeout 0 \
        --nopreview \
        --width "${WIDTH}" \
        --height "${HEIGHT}" \
        --framerate "${FRAMERATE}" \
        --bitrate "${BITRATE}" \
        --intra "${KEYFRAME_INTERVAL}" \
        --profile baseline \
        --level "${H264_LEVEL}" \
        --inline \
        --flush \
        --exposure sports \
        --awb "${AWB}" \
        --output - \
        | run_rtp_tail
}

run_software() {
    log "Using GStreamer + x264enc (software encoder, high CPU)"

    local -a camera_src
    if gst-inspect-1.0 libcamerasrc >/dev/null 2>&1; then
        camera_src=(libcamerasrc)
    elif [ -e /dev/video0 ]; then
        camera_src=(v4l2src device=/dev/video0)
    else
        log "ERROR: No camera source found (no libcamerasrc and no /dev/video0)."
        exit 1
    fi

    gst-launch-1.0 -q \
        "${camera_src[@]}" \
            ! "video/x-raw,width=${WIDTH},height=${HEIGHT},framerate=${FRAMERATE}/1" \
        ! queue max-size-buffers=1 leaky=downstream \
        ! videoconvert \
        ! x264enc tune=zerolatency speed-preset=ultrafast \
                  bitrate=$((BITRATE / 1000)) \
                  key-int-max="${KEYFRAME_INTERVAL}" \
                  threads=2 sliced-threads=true \
        ! "video/x-h264,profile=baseline" \
        ! h264parse config-interval=1 \
        ! rtph264pay pt=96 config-interval=1 aggregate-mode=zero-latency mtu="${MTU}" \
        ! udpsink host="${JANUS_HOST}" port="${JANUS_PORT}" \
                  sync=false async=false buffer-size="${UDP_BUFFER}" \
                  qos-dscp="${VIDEO_DSCP}"
}

case "${CAMERA_STACK}" in
    rpicam)   run_rpicam ;;
    raspivid) run_raspivid ;;
    software) run_software ;;
    *)
        log "ERROR: Unknown CAMERA_STACK=${CAMERA_STACK} (use auto|rpicam|raspivid|software)"
        exit 1
        ;;
esac
