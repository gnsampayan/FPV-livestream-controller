"""Cheap, non-blocking reads of Pi health values.

Everything here reads from sysfs/procfs; there are no subprocess calls, so it
is safe to call from the daemon's latency-critical event loop.
"""

from __future__ import annotations

from typing import Optional

CPU_TEMP_PATH = "/sys/class/thermal/thermal_zone0/temp"
# Exposed by the Raspberry Pi firmware driver on current kernels; same
# bitfield as `vcgencmd get_throttled`.
THROTTLED_PATHS = (
    "/sys/devices/platform/soc/soc:firmware/get_throttled",
    "/sys/devices/platform/soc/soc:firmware/raspberrypi-hwmon/get_throttled",
)
WIRELESS_PATH = "/proc/net/wireless"


def _read_text(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="ascii") as handle:
            return handle.read().strip()
    except (OSError, UnicodeDecodeError):
        return None


def read_cpu_temp_deci_c() -> int:
    """CPU temperature in tenths of a degree Celsius, 0 if unavailable."""
    raw = _read_text(CPU_TEMP_PATH)
    if raw is None:
        return 0
    try:
        return int(raw) // 100
    except ValueError:
        return 0


def read_throttled_flags() -> int:
    """Firmware throttle bitfield, 0 if unavailable."""
    for path in THROTTLED_PATHS:
        raw = _read_text(path)
        if raw is None:
            continue
        try:
            return int(raw, 0)
        except ValueError:
            continue
    return 0


def parse_wireless_rssi(proc_net_wireless: str) -> int:
    """Extract the signal level (dBm) of the first interface in /proc/net/wireless.

    Returns 0 when no wireless interface is present or the value is unusable.
    """
    lines = proc_net_wireless.splitlines()
    # First two lines are column headers.
    for line in lines[2:]:
        fields = line.replace(":", " ").split()
        # name, status, link, level, noise, ...
        if len(fields) < 4:
            continue
        level_field = fields[3].rstrip(".")
        try:
            level = int(float(level_field))
        except ValueError:
            continue
        # Some drivers report a positive 0-100 quality value instead of dBm.
        if level > 0:
            return 0
        return max(-128, level)
    return 0


def read_wifi_rssi_dbm() -> int:
    raw = _read_text(WIRELESS_PATH)
    if raw is None:
        return 0
    return parse_wireless_rssi(raw)
