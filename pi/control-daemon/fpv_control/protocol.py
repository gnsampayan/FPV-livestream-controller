"""Wire protocols used by the control daemon.

Two independent links are defined here:

1. Relay <-> Pi: authenticated UDP datagrams (little-endian).
2. Pi -> Arduino: fixed 10-byte serial frames (unchanged from earlier
   firmware, so the Arduino sketch needs no changes).

UDP datagram layout
-------------------
Every datagram is ``header | payload | mac``::

    header   4 bytes   magic (0xFC), type (u8), seq (u16)
    payload  N bytes   depends on type (see below)
    mac      8 bytes   HMAC-SHA256(key, header | payload) truncated to 8 bytes

PING (relay -> Pi), payload 4 bytes ``<I``::

    relay_ts_ms  u32   relay clock in ms (wraps); echoed back for RTT

    Sent a few times per second even when nobody is driving. It lets the
    relay measure round-trip time continuously and keeps the relay -> Pi
    NAT path warm. It never affects the servo outputs or the deadman timer.

CONTROL (relay -> Pi), payload 12 bytes ``<I hhhh``::

    relay_ts_ms  u32   relay clock in ms (wraps); echoed back for RTT
    throttle     i16   -1000..+1000 (brake already folded in by the relay)
    steer        i16   -1000..+1000
    cam_yaw      i16   -1000..+1000
    cam_pitch    i16   -1000..+1000

TELEMETRY (Pi -> relay), payload 17 bytes ``<I H h I b B B H``::

    echo_ts_ms       u32  relay_ts_ms of the newest accepted PING or CONTROL packet
    hold_ms          u16  ms between receiving that packet and sending this one
    cpu_temp_deci_c  i16  CPU temperature in 0.1 degC
    throttled_flags  u32  Pi firmware get_throttled bitfield
    wifi_rssi_dbm    i8   0 when unknown
    arduino_flags    u8   bit0 = failsafe active, bit1 = link has been heard
    arduino_frames   u8   Arduino frames-since-boot counter (mod 256)
    arduino_age_ms   u16  ms since the last Arduino status reply (0xFFFF = never)

TELEMETRY is sent several times per second regardless of traffic, so it also
serves as the keepalive that opens the return path through carrier NAT and
tells the relay where to send CONTROL packets.

The relay computes RTT as ``now - echo_ts_ms - hold_ms``; no clock
synchronisation between the machines is needed.

Replay protection is sequence-based (see :class:`SequenceFilter`). The MAC
prevents forgery; the underlay VPN (Tailscale/WireGuard) provides
confidentiality.
"""

from __future__ import annotations

import hmac
import hashlib
import struct
from dataclasses import dataclass
from enum import IntEnum
from typing import Optional

DATAGRAM_MAGIC = 0xFC
MAC_LENGTH = 8

HEADER_STRUCT = struct.Struct("<BBH")
PING_PAYLOAD_STRUCT = struct.Struct("<I")
CONTROL_PAYLOAD_STRUCT = struct.Struct("<Ihhhh")
TELEMETRY_PAYLOAD_STRUCT = struct.Struct("<IHhIbBBH")

CHANNEL_LIMIT = 1000
ARDUINO_AGE_NEVER = 0xFFFF

ARDUINO_FLAG_FAILSAFE = 0x01
ARDUINO_FLAG_LINK_HEARD = 0x02

SEQ_MODULUS = 0x10000
SEQ_HALF = 0x8000


class PacketType(IntEnum):
    PING = 1
    CONTROL = 2
    TELEMETRY = 3


class ProtocolError(ValueError):
    """Raised when a datagram is malformed or fails authentication."""


@dataclass(frozen=True)
class PingPacket:
    seq: int
    relay_ts_ms: int


@dataclass(frozen=True)
class ControlPacket:
    seq: int
    relay_ts_ms: int
    throttle: int
    steer: int
    cam_yaw: int
    cam_pitch: int


@dataclass(frozen=True)
class TelemetryPacket:
    seq: int
    echo_ts_ms: int
    hold_ms: int
    cpu_temp_deci_c: int
    throttled_flags: int
    wifi_rssi_dbm: int
    arduino_flags: int
    arduino_frames: int
    arduino_age_ms: int


def clamp_int(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _compute_mac(key: bytes, body: bytes) -> bytes:
    return hmac.new(key, body, hashlib.sha256).digest()[:MAC_LENGTH]


def _seal(key: bytes, packet_type: PacketType, seq: int, payload: bytes) -> bytes:
    body = HEADER_STRUCT.pack(DATAGRAM_MAGIC, int(packet_type), seq % SEQ_MODULUS) + payload
    return body + _compute_mac(key, body)


def _open(key: bytes, datagram: bytes, expected_type: PacketType, payload_size: int) -> tuple[int, bytes]:
    """Verify and split a datagram. Returns (seq, payload)."""
    expected_length = HEADER_STRUCT.size + payload_size + MAC_LENGTH
    if len(datagram) != expected_length:
        raise ProtocolError(f"bad length {len(datagram)} (expected {expected_length})")

    body, mac = datagram[:-MAC_LENGTH], datagram[-MAC_LENGTH:]
    if not hmac.compare_digest(mac, _compute_mac(key, body)):
        raise ProtocolError("MAC mismatch")

    magic, raw_type, seq = HEADER_STRUCT.unpack_from(body)
    if magic != DATAGRAM_MAGIC:
        raise ProtocolError("bad magic")
    if raw_type != int(expected_type):
        raise ProtocolError(f"unexpected packet type {raw_type}")

    return seq, body[HEADER_STRUCT.size:]


def peek_packet_type(datagram: bytes) -> Optional[PacketType]:
    """Read the type byte without authenticating (use only to pick a parser)."""
    if len(datagram) < HEADER_STRUCT.size:
        return None
    magic, raw_type, _ = HEADER_STRUCT.unpack_from(datagram)
    if magic != DATAGRAM_MAGIC:
        return None
    try:
        return PacketType(raw_type)
    except ValueError:
        return None


def build_ping_datagram(key: bytes, packet: PingPacket) -> bytes:
    """Build a PING datagram (used by tests and tooling; the relay is the real sender)."""
    payload = PING_PAYLOAD_STRUCT.pack(packet.relay_ts_ms & 0xFFFFFFFF)
    return _seal(key, PacketType.PING, packet.seq, payload)


def parse_ping_datagram(key: bytes, datagram: bytes) -> PingPacket:
    seq, payload = _open(key, datagram, PacketType.PING, PING_PAYLOAD_STRUCT.size)
    (relay_ts_ms,) = PING_PAYLOAD_STRUCT.unpack(payload)
    return PingPacket(seq=seq, relay_ts_ms=relay_ts_ms)


def build_control_datagram(key: bytes, packet: ControlPacket) -> bytes:
    """Build a CONTROL datagram (used by tests and tooling; the relay is the real sender)."""
    payload = CONTROL_PAYLOAD_STRUCT.pack(
        packet.relay_ts_ms & 0xFFFFFFFF,
        clamp_int(packet.throttle, -CHANNEL_LIMIT, CHANNEL_LIMIT),
        clamp_int(packet.steer, -CHANNEL_LIMIT, CHANNEL_LIMIT),
        clamp_int(packet.cam_yaw, -CHANNEL_LIMIT, CHANNEL_LIMIT),
        clamp_int(packet.cam_pitch, -CHANNEL_LIMIT, CHANNEL_LIMIT),
    )
    return _seal(key, PacketType.CONTROL, packet.seq, payload)


def parse_control_datagram(key: bytes, datagram: bytes) -> ControlPacket:
    seq, payload = _open(key, datagram, PacketType.CONTROL, CONTROL_PAYLOAD_STRUCT.size)
    relay_ts_ms, throttle, steer, cam_yaw, cam_pitch = CONTROL_PAYLOAD_STRUCT.unpack(payload)
    return ControlPacket(
        seq=seq,
        relay_ts_ms=relay_ts_ms,
        throttle=clamp_int(throttle, -CHANNEL_LIMIT, CHANNEL_LIMIT),
        steer=clamp_int(steer, -CHANNEL_LIMIT, CHANNEL_LIMIT),
        cam_yaw=clamp_int(cam_yaw, -CHANNEL_LIMIT, CHANNEL_LIMIT),
        cam_pitch=clamp_int(cam_pitch, -CHANNEL_LIMIT, CHANNEL_LIMIT),
    )


def build_telemetry_datagram(key: bytes, packet: TelemetryPacket) -> bytes:
    payload = TELEMETRY_PAYLOAD_STRUCT.pack(
        packet.echo_ts_ms & 0xFFFFFFFF,
        clamp_int(packet.hold_ms, 0, 0xFFFF),
        clamp_int(packet.cpu_temp_deci_c, -32768, 32767),
        packet.throttled_flags & 0xFFFFFFFF,
        clamp_int(packet.wifi_rssi_dbm, -128, 127),
        packet.arduino_flags & 0xFF,
        packet.arduino_frames & 0xFF,
        clamp_int(packet.arduino_age_ms, 0, 0xFFFF),
    )
    return _seal(key, PacketType.TELEMETRY, packet.seq, payload)


def parse_telemetry_datagram(key: bytes, datagram: bytes) -> TelemetryPacket:
    seq, payload = _open(key, datagram, PacketType.TELEMETRY, TELEMETRY_PAYLOAD_STRUCT.size)
    (
        echo_ts_ms,
        hold_ms,
        cpu_temp_deci_c,
        throttled_flags,
        wifi_rssi_dbm,
        arduino_flags,
        arduino_frames,
        arduino_age_ms,
    ) = TELEMETRY_PAYLOAD_STRUCT.unpack(payload)
    return TelemetryPacket(
        seq=seq,
        echo_ts_ms=echo_ts_ms,
        hold_ms=hold_ms,
        cpu_temp_deci_c=cpu_temp_deci_c,
        throttled_flags=throttled_flags,
        wifi_rssi_dbm=wifi_rssi_dbm,
        arduino_flags=arduino_flags,
        arduino_frames=arduino_frames,
        arduino_age_ms=arduino_age_ms,
    )


def seq_is_newer(candidate: int, reference: int) -> bool:
    """True when ``candidate`` is ahead of ``reference`` in 16-bit wraparound order."""
    delta = (candidate - reference) % SEQ_MODULUS
    return 0 < delta < SEQ_HALF


class SequenceFilter:
    """Accepts only packets newer than the last accepted one.

    A relay restart resets its sequence counter, which would otherwise look
    like a flood of stale packets. If nothing has been accepted for
    ``resync_after_s`` seconds, the next authenticated packet is accepted
    unconditionally and becomes the new baseline.
    """

    def __init__(self, resync_after_s: float = 1.0) -> None:
        self._resync_after_s = resync_after_s
        self._last_seq: Optional[int] = None
        self._last_accept_time = 0.0

    def accept(self, seq: int, now: float) -> bool:
        last_seq = self._last_seq
        needs_resync = (
            last_seq is None
            or (now - self._last_accept_time) > self._resync_after_s
        )

        if last_seq is None or needs_resync or seq_is_newer(seq, last_seq):
            self._last_seq = seq
            self._last_accept_time = now
            return True
        return False


# ---------------------------------------------------------------------------
# Pi -> Arduino serial frames (format is fixed by the existing firmware)
# ---------------------------------------------------------------------------

ARDUINO_FRAME_MAGIC = 0xA5
ARDUINO_STATUS_MAGIC = 0x5A
ARDUINO_STATUS_SIZE = 3
ARDUINO_STATUS_FLAG_FAILSAFE = 0x01
ARDUINO_FRAME_STRUCT = struct.Struct("<Bhhhh")


def build_arduino_frame(throttle: int, steer: int, cam_yaw: int, cam_pitch: int) -> bytes:
    """Pack a 10-byte Arduino control frame: magic + 4x int16 + XOR checksum.

    Channel order matches rc-controller.ino: throttle, steering, cam yaw, cam pitch.
    """
    payload = ARDUINO_FRAME_STRUCT.pack(
        ARDUINO_FRAME_MAGIC,
        clamp_int(throttle, -CHANNEL_LIMIT, CHANNEL_LIMIT),
        clamp_int(steer, -CHANNEL_LIMIT, CHANNEL_LIMIT),
        clamp_int(cam_yaw, -CHANNEL_LIMIT, CHANNEL_LIMIT),
        clamp_int(cam_pitch, -CHANNEL_LIMIT, CHANNEL_LIMIT),
    )
    checksum = 0
    for byte in payload:
        checksum ^= byte
    return payload + bytes([checksum])


@dataclass(frozen=True)
class ArduinoStatus:
    frames_since_boot: int
    failsafe_active: bool


class ArduinoStatusParser:
    """Incremental parser for the Arduino's 3-byte status replies.

    Serial reads can split a reply across calls, so unconsumed bytes are
    carried over. Bytes that are not part of a status frame (boot banners,
    noise) are discarded one at a time while scanning for the magic byte.
    """

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, data: bytes) -> list[ArduinoStatus]:
        self._buffer.extend(data)
        results: list[ArduinoStatus] = []

        while len(self._buffer) >= ARDUINO_STATUS_SIZE:
            if self._buffer[0] != ARDUINO_STATUS_MAGIC:
                del self._buffer[0]
                continue
            frames = self._buffer[1]
            flags = self._buffer[2]
            del self._buffer[:ARDUINO_STATUS_SIZE]
            results.append(
                ArduinoStatus(
                    frames_since_boot=frames,
                    failsafe_active=bool(flags & ARDUINO_STATUS_FLAG_FAILSAFE),
                )
            )

        return results
