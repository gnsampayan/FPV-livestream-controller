"""Runtime configuration for the control daemon, loaded from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

PLACEHOLDER_HOSTS = frozenset({"", "YOUR_SERVER_IP", "100.x.x.x"})
PLACEHOLDER_TOKENS = frozenset({"", "changeme"})


class ConfigError(ValueError):
    """Raised when the environment does not describe a usable configuration."""


@dataclass(frozen=True)
class Config:
    relay_host: str
    relay_port: int
    auth_key: bytes

    serial_port: str
    serial_baud: int
    serial_reopen_interval_s: float

    # Neutral steer/throttle if no valid command arrives within this window.
    deadman_timeout_s: float
    # Rate at which the latest frame is re-sent to the Arduino so its own
    # failsafe stays fed and a dropped serial byte self-heals.
    serial_refresh_hz: int
    # Telemetry doubles as the UDP keepalive towards the relay.
    telemetry_interval_s: float
    # DSCP EF (46): shaped uplinks send control packets first.
    dscp: int


def _read_int(env: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}, got {value}")
    return value


def load_config(env: Mapping[str, str] | None = None) -> Config:
    """Build a :class:`Config` from ``env`` (defaults to ``os.environ``)."""
    source: Mapping[str, str] = os.environ if env is None else env

    # The relay runs on the same server as Janus, so fall back to JANUS_HOST
    # for installs whose fpv.env predates CONTROL_RELAY_HOST.
    relay_host = source.get("CONTROL_RELAY_HOST") or source.get("JANUS_HOST") or ""
    if relay_host in PLACEHOLDER_HOSTS:
        raise ConfigError("CONTROL_RELAY_HOST is not set (edit ~/fpv/fpv.env)")

    auth_token = source.get("AUTH_TOKEN", "")
    if auth_token in PLACEHOLDER_TOKENS:
        raise ConfigError("AUTH_TOKEN is not set (edit ~/fpv/fpv.env)")

    return Config(
        relay_host=relay_host,
        relay_port=_read_int(source, "CONTROL_RELAY_PORT", 3002, 1, 65535),
        auth_key=auth_token.encode("utf-8"),
        serial_port=source.get("SERIAL_PORT", "/dev/fpv-arduino"),
        serial_baud=_read_int(source, "SERIAL_BAUD", 500000, 9600, 2000000),
        serial_reopen_interval_s=1.0,
        deadman_timeout_s=_read_int(source, "DEADMAN_TIMEOUT_MS", 250, 50, 2000) / 1000.0,
        serial_refresh_hz=_read_int(source, "SERIAL_REFRESH_HZ", 50, 10, 200),
        telemetry_interval_s=_read_int(source, "TELEMETRY_INTERVAL_MS", 250, 50, 5000) / 1000.0,
        dscp=_read_int(source, "CONTROL_DSCP", 46, 0, 63),
    )
