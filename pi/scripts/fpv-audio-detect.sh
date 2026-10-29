#!/bin/bash
# Detect USB audio cards and persist stable ALSA device names.
#
# ALSA card numbers (plughw:1,0) depend on USB enumeration order and can
# change between boots. Card *ids* (plughw:CARD=Device,DEV=0) do not, so this
# script writes ids into fpv.env.
#
# Usage:
#   fpv-audio-detect.sh                 list cards and show the suggestion
#   fpv-audio-detect.sh --write [file]  also write MIC_DEVICE / SPK_DEVICE
#                                       into the env file (default:
#                                       ~/fpv/fpv.env)
#
# Heuristic: the first USB capture card is the mic, the first USB playback
# card is the speaker (often the same physical device). The onboard
# bcm2835 headphone jack is ignored. Always verify the result with
# `arecord -l` / `aplay -l`.

set -eu

WRITE=0
ENV_FILE="${HOME}/fpv/fpv.env"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --write)
            WRITE=1
            if [ "$#" -gt 1 ] && [ "${2#--}" = "$2" ]; then
                ENV_FILE="$2"
                shift
            fi
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
    shift
done

if ! command -v arecord >/dev/null 2>&1 || ! command -v aplay >/dev/null 2>&1; then
    echo "ERROR: alsa-utils is not installed (sudo apt install alsa-utils)" >&2
    exit 1
fi

# `arecord -l` / `aplay -l` lines look like:
#   card 1: Device [USB Audio Device], device 0: USB Audio [USB Audio]
# Field 3 is the card id.
first_usb_card_id() {
    local lister="$1"
    "${lister}" -l 2>/dev/null \
        | awk '/^card [0-9]+:/ && !/bcm2835|vc4|HDMI/ { gsub(":", "", $3); print $3; exit }'
}

echo "Capture devices:"
arecord -l 2>/dev/null | sed 's/^/  /' || true
echo "Playback devices:"
aplay -l 2>/dev/null | sed 's/^/  /' || true

MIC_ID="$(first_usb_card_id arecord || true)"
SPK_ID="$(first_usb_card_id aplay || true)"

if [ -z "${MIC_ID}" ] && [ -z "${SPK_ID}" ]; then
    echo "No USB audio cards found. Plug in the mic/speaker and re-run." >&2
    exit 1
fi

echo ""
if [ -n "${MIC_ID}" ]; then
    echo "MIC_DEVICE=plughw:CARD=${MIC_ID},DEV=0"
fi
if [ -n "${SPK_ID}" ]; then
    echo "SPK_DEVICE=plughw:CARD=${SPK_ID},DEV=0"
fi

if [ "${WRITE}" -ne 1 ]; then
    echo ""
    echo "Re-run with --write to save these into ${ENV_FILE}."
    exit 0
fi

if [ ! -f "${ENV_FILE}" ]; then
    echo "ERROR: ${ENV_FILE} does not exist (run setup.sh first)." >&2
    exit 1
fi

# Replace an existing (possibly commented) assignment, or append a new one.
set_env_var() {
    local key="$1"
    local value="$2"
    if grep -Eq "^#?${key}=" "${ENV_FILE}"; then
        sed -i -E "s|^#?${key}=.*|${key}=${value}|" "${ENV_FILE}"
    else
        printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
    fi
}

if [ -n "${MIC_ID}" ]; then
    set_env_var MIC_DEVICE "plughw:CARD=${MIC_ID},DEV=0"
fi
if [ -n "${SPK_ID}" ]; then
    set_env_var SPK_DEVICE "plughw:CARD=${SPK_ID},DEV=0"
fi

echo "Saved to ${ENV_FILE}. Restart audio services:"
echo "  sudo systemctl restart fpv-audio-tx fpv-audio-rx"
