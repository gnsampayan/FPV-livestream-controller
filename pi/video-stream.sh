#!/bin/bash
# FPV Video Streaming Script for Raspberry Pi 3 with OV5647 Camera.
#
# Starts a GStreamer pipeline that encodes the camera feed as H.264 and
# forwards RTP packets to the Janus WebRTC gateway on the home server.
#
# Defaults are tuned for the Pi 3 v1.2 (software x264) on LTE uplinks:
#   - 854x480 @ 25fps, 700 kbps CBR  (was 960x540 @ 1 Mbps; the lower profile
#     leaves CPU headroom for the audio TX/RX pipelines that now run alongside
#     this service on the same Pi)
#   - MTU 1200 on RTP packets to stay under typical cellular MTU
#   - Keyframe every 25 frames (~1s) for fast loss recovery on cellular
#
# Override any knob via environment (see the systemd unit).

set -e

JANUS_HOST="${JANUS_HOST:-100.x.x.x}"         # Tailscale IP of your server
JANUS_PORT="${JANUS_PORT:-5004}"

WIDTH="${VIDEO_WIDTH:-854}"
HEIGHT="${VIDEO_HEIGHT:-480}"
FRAMERATE="${VIDEO_FRAMERATE:-25}"
BITRATE="${VIDEO_BITRATE:-700000}"            # 700 kbps CBR
KEYFRAME_INTERVAL="${KEYFRAME_INTERVAL:-25}"  # I-frame every ~1s
MTU="${RTP_MTU:-1200}"                        # cellular-safe
UDP_BUFFER="${UDP_BUFFER:-65536}"

CAMERA_STACK="${CAMERA_STACK:-auto}"          # auto | libcamera | v4l2 | software
# Which stack to pick for your board:
#   libcamera - hardware H.264 encode via v4l2h264enc. Known broken on Pi 3
#               with current bcm2835-codec driver: pipeline reaches PLAYING
#               but emits zero RTP packets (silent stall). Prefer on Pi 4/5.
#   software  - libcamera source + software x264enc. Works on Pi 3 today but
#               pins one CPU core. Current recommended default for Pi 3
#               until the hardware encoder regression is fixed.
#   v4l2      - legacy /dev/video0 shim. Avoid on modern Pi OS; fails with
#               "Buffer pool activation failed" on Pi 3 due to small CMA pool.
#   auto      - picks libcamera if available, else falls through.

# Silence GStreamer's debug channel unless the operator explicitly asked for it.
export GST_DEBUG="${GST_DEBUG:-0}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting FPV video stream"
log "Target:     ${JANUS_HOST}:${JANUS_PORT} (RTP/UDP, mtu=${MTU})"
log "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
log "Bitrate:    ${BITRATE} bps CBR, GOP=${KEYFRAME_INTERVAL}"
log "Stack:      ${CAMERA_STACK}"

if ! command -v gst-launch-1.0 >/dev/null 2>&1; then
    log "ERROR: GStreamer not found. Install with:"
    log "  sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad}"
    exit 1
fi

# Auto-pick the best camera source for this OS if not overridden.
if [ "${CAMERA_STACK}" = "auto" ]; then
    if command -v libcamera-hello >/dev/null 2>&1 \
       || gst-inspect-1.0 libcamerasrc >/dev/null 2>&1; then
        CAMERA_STACK="libcamera"
    elif [ -e /dev/video0 ]; then
        CAMERA_STACK="v4l2"
    else
        log "Loading bcm2835-v4l2 camera module..."
        sudo modprobe bcm2835-v4l2 || true
        sleep 1
        if [ -e /dev/video0 ]; then
            CAMERA_STACK="v4l2"
        else
            log "ERROR: No camera source found (no libcamerasrc and no /dev/video0)."
            exit 1
        fi
    fi
    log "Auto-selected camera stack: ${CAMERA_STACK}"
fi

# Common encoder/payloader tail used by every pipeline.
ENC_CONTROLS="controls,video_bitrate_mode=1,video_bitrate=${BITRATE},h264_i_frame_period=${KEYFRAME_INTERVAL}"

run_libcamera() {
    log "Using libcamera stack"
    exec gst-launch-1.0 -v \
        libcamerasrc \
            ! "video/x-raw,width=${WIDTH},height=${HEIGHT},framerate=${FRAMERATE}/1" \
        ! queue max-size-buffers=1 leaky=downstream \
        ! videoconvert \
        ! queue max-size-buffers=1 leaky=downstream \
        ! v4l2h264enc extra-controls="${ENC_CONTROLS}" \
        ! "video/x-h264,level=(string)4,profile=baseline" \
        ! h264parse config-interval=1 \
        ! rtph264pay pt=96 config-interval=1 mtu=${MTU} \
        ! udpsink host="${JANUS_HOST}" port="${JANUS_PORT}" \
                  sync=false async=false buffer-size=${UDP_BUFFER}
}

run_v4l2() {
    log "Using legacy V4L2 camera stack (/dev/video0)"
    exec gst-launch-1.0 -v \
        v4l2src device=/dev/video0 \
            ! "video/x-raw,width=${WIDTH},height=${HEIGHT},framerate=${FRAMERATE}/1" \
        ! queue max-size-buffers=1 leaky=downstream \
        ! videoconvert \
        ! queue max-size-buffers=1 leaky=downstream \
        ! v4l2h264enc extra-controls="${ENC_CONTROLS}" \
        ! "video/x-h264,level=(string)4,profile=baseline" \
        ! h264parse config-interval=1 \
        ! rtph264pay pt=96 config-interval=1 mtu=${MTU} \
        ! udpsink host="${JANUS_HOST}" port="${JANUS_PORT}" \
                  sync=false async=false buffer-size=${UDP_BUFFER}
}

run_software() {
    # We source frames from libcamerasrc (NOT v4l2src) even in the "software
    # fallback" path, because on current Raspberry Pi OS (Bullseye/Bookworm)
    # the legacy V4L2 shim (/dev/video0 via bcm2835-v4l2) has an undersized
    # CMA/contig memory pool. At 960x540 YUY2 @ 25fps v4l2src dies with
    # `Failed to allocate required memory. Buffer pool activation failed`
    # the moment the pipeline tries to go PLAYING. libcamerasrc uses
    # dma-buf and sidesteps the issue entirely.
    #
    # The "software" part of this function refers to the ENCODER (x264enc),
    # which is what matters for Pi 3 boards where v4l2h264enc silently
    # stalls on the bcm2835-codec driver's current control set.
    log "Using libcamera source + software x264 encoder (fallback, high CPU)"
    exec gst-launch-1.0 -v \
        libcamerasrc \
            ! "video/x-raw,width=${WIDTH},height=${HEIGHT},framerate=${FRAMERATE}/1" \
        ! queue max-size-buffers=1 leaky=downstream \
        ! videoconvert \
        ! x264enc tune=zerolatency speed-preset=ultrafast \
                  bitrate=$((BITRATE / 1000)) \
                  key-int-max=${KEYFRAME_INTERVAL} \
                  threads=4 \
        ! "video/x-h264,profile=baseline" \
        ! h264parse config-interval=1 \
        ! rtph264pay pt=96 config-interval=1 mtu=${MTU} \
        ! udpsink host="${JANUS_HOST}" port="${JANUS_PORT}" \
                  sync=false async=false buffer-size=${UDP_BUFFER}
}

case "${CAMERA_STACK}" in
    libcamera) run_libcamera ;;
    v4l2)     run_v4l2 ;;
    software) run_software ;;
    *)
        log "ERROR: Unknown CAMERA_STACK=${CAMERA_STACK} (use auto|libcamera|v4l2|software)"
        exit 1
        ;;
esac
