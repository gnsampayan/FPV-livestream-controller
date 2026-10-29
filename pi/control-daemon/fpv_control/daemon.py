"""Event-driven control daemon.

A single thread multiplexes the relay UDP socket and the Arduino serial port
with ``select``:

* A valid CONTROL datagram is written to the Arduino immediately (no waiting
  for a polling tick), which removes up to one tick of latency.
* A fixed-rate refresh re-sends the newest frame so the Arduino's own
  failsafe stays fed and a corrupted serial frame self-heals on the next one.
* If no valid command arrives within the deadman window, steer and throttle
  go neutral. The Arduino has a second, independent failsafe behind this.
* TELEMETRY goes out several times per second. It carries Pi health, Arduino
  link health, and the echo data (from PING and CONTROL packets) the relay
  needs to measure round-trip time, and it doubles as the keepalive that
  keeps the carrier-NAT mapping open.
"""

from __future__ import annotations

import logging
import select
import socket
import time
from dataclasses import dataclass
from typing import Callable, Optional

try:
    import serial  # pyserial, installed on the Pi via requirements.txt
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit("pyserial not found. Install with: pip3 install pyserial") from exc

from .config import Config
from .protocol import (
    ARDUINO_AGE_NEVER,
    ARDUINO_FLAG_FAILSAFE,
    ARDUINO_FLAG_LINK_HEARD,
    ArduinoStatus,
    ArduinoStatusParser,
    ControlPacket,
    PacketType,
    ProtocolError,
    SequenceFilter,
    TelemetryPacket,
    build_arduino_frame,
    build_telemetry_datagram,
    parse_control_datagram,
    parse_ping_datagram,
    peek_packet_type,
)
from .system_stats import read_cpu_temp_deci_c, read_throttled_flags, read_wifi_rssi_dbm

logger = logging.getLogger(__name__)

# Largest datagram we ever expect; anything longer is dropped by parsing.
MAX_DATAGRAM_SIZE = 256
SERIAL_READ_CHUNK = 64
SOCKET_BUFFER_BYTES = 65536
REJECT_LOG_INTERVAL_S = 5.0
# System health values change slowly; refresh them at this interval only.
HEALTH_REFRESH_INTERVAL_S = 1.0

Clock = Callable[[], float]


@dataclass(frozen=True)
class Channels:
    """Channel values in the Arduino's -1000..+1000 range."""

    throttle: int = 0
    steer: int = 0
    cam_yaw: int = 0
    cam_pitch: int = 0


class CommandState:
    """Holds the newest accepted command and applies the deadman rule."""

    def __init__(self, deadman_timeout_s: float) -> None:
        self._deadman_timeout_s = deadman_timeout_s
        self._channels = Channels()
        self._last_rx_time: Optional[float] = None

    def apply(self, packet: ControlPacket, now: float) -> None:
        self._channels = Channels(
            throttle=packet.throttle,
            steer=packet.steer,
            cam_yaw=packet.cam_yaw,
            cam_pitch=packet.cam_pitch,
        )
        self._last_rx_time = now

    def is_stale(self, now: float) -> bool:
        return self._last_rx_time is None or (now - self._last_rx_time) > self._deadman_timeout_s

    def effective(self, now: float) -> Channels:
        """Channels to send right now.

        When stale, drive channels are neutralised. The camera servos keep
        their last commanded position (they are absolute positions, not
        motion).
        """
        if self.is_stale(now):
            return Channels(
                throttle=0,
                steer=0,
                cam_yaw=self._channels.cam_yaw,
                cam_pitch=self._channels.cam_pitch,
            )
        return self._channels

    def reset(self) -> None:
        self._channels = Channels()
        self._last_rx_time = None


class ControlDaemon:
    def __init__(self, config: Config, clock: Clock = time.monotonic) -> None:
        self._config = config
        self._clock = clock
        self._running = False

        self._command = CommandState(config.deadman_timeout_s)
        self._sequence_filter = SequenceFilter()
        self._status_parser = ArduinoStatusParser()

        self._udp: Optional[socket.socket] = None
        self._serial: Optional[serial.Serial] = None

        self._telemetry_seq = 0
        # Newest relay timestamp (from PING or CONTROL) and when it arrived,
        # echoed back in telemetry so the relay can measure RTT.
        self._echo_ts_ms = 0
        self._echo_rx_time: Optional[float] = None
        self._arduino_status: Optional[ArduinoStatus] = None
        self._arduino_last_seen: Optional[float] = None

        self._cpu_temp_deci_c = 0
        self._throttled_flags = 0
        self._wifi_rssi_dbm = 0
        self._health_next_refresh = 0.0

        self._last_reject_log = 0.0
        self._rejected_since_log = 0
        self._udp_retry_at = 0.0
        self._serial_retry_at = 0.0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def run(self) -> None:
        cfg = self._config
        logger.info("Starting FPV control daemon")
        logger.info("Relay:  %s:%d (UDP)", cfg.relay_host, cfg.relay_port)
        logger.info("Serial: %s @ %d baud", cfg.serial_port, cfg.serial_baud)

        self._running = True
        refresh_interval = 1.0 / cfg.serial_refresh_hz
        now = self._clock()
        next_refresh = now
        next_telemetry = now

        while self._running:
            now = self._clock()
            self._ensure_udp(now)
            self._ensure_serial(now)

            timeout = max(0.0, min(next_refresh, next_telemetry) - now)
            readable = self._wait_readable(timeout)

            for ready in readable:
                if ready is self._udp:
                    self._drain_udp()
                elif ready is self._serial:
                    self._drain_serial()

            now = self._clock()

            if now >= next_refresh:
                self._write_frame(now)
                next_refresh += refresh_interval
                if next_refresh < now:
                    # Fell behind (e.g. a long stall): resync instead of bursting.
                    next_refresh = now + refresh_interval

            if now >= next_telemetry:
                self._send_telemetry(now)
                next_telemetry += cfg.telemetry_interval_s
                if next_telemetry < now:
                    next_telemetry = now + cfg.telemetry_interval_s

        self._shutdown()

    def request_stop(self) -> None:
        """Ask the event loop to exit. Safe to call from a signal handler."""
        self._running = False

    def _shutdown(self) -> None:
        logger.info("Stopping FPV control daemon")
        self._command.reset()
        self._write_frame(self._clock())

        if self._serial is not None:
            self._close_serial()
        if self._udp is not None:
            self._udp.close()
            self._udp = None

    # ------------------------------------------------------------------
    # Event loop plumbing
    # ------------------------------------------------------------------

    def _wait_readable(self, timeout: float) -> list[object]:
        sources: list[object] = []
        if self._udp is not None:
            sources.append(self._udp)
        if self._serial is not None:
            sources.append(self._serial)

        if not sources:
            time.sleep(timeout)
            return []

        try:
            readable, _, _ = select.select(sources, [], [], timeout)
        except (OSError, ValueError):
            # A descriptor was closed underneath us; the ensure_* calls reopen it.
            return []
        return list(readable)

    # ------------------------------------------------------------------
    # UDP link to the relay
    # ------------------------------------------------------------------

    def _ensure_udp(self, now: float) -> None:
        if self._udp is not None or now < self._udp_retry_at:
            return

        cfg = self._config
        try:
            family, _, _, _, address = socket.getaddrinfo(
                cfg.relay_host, cfg.relay_port, socket.AF_INET, socket.SOCK_DGRAM
            )[0]
            sock = socket.socket(family, socket.SOCK_DGRAM)
            sock.setblocking(False)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, SOCKET_BUFFER_BYTES)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, SOCKET_BUFFER_BYTES)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_TOS, cfg.dscp << 2)
            # connect() on UDP only sets the default peer: the kernel then
            # drops datagrams from any other source for free.
            sock.connect(address)
        except OSError as exc:
            logger.warning("Cannot open UDP link to %s:%d: %s", cfg.relay_host, cfg.relay_port, exc)
            self._udp_retry_at = now + 2.0
            return

        self._udp = sock
        logger.info("UDP link ready, relay address %s:%d", address[0], address[1])

    def _drain_udp(self) -> None:
        sock = self._udp
        if sock is None:
            return

        newest_accepted = False
        while True:
            try:
                datagram = sock.recv(MAX_DATAGRAM_SIZE)
            except BlockingIOError:
                break
            except ConnectionRefusedError:
                # ICMP port-unreachable from a connected UDP socket: relay is down.
                break
            except OSError as exc:
                logger.warning("UDP receive failed (%s); reopening socket", exc)
                self._close_udp()
                break

            if self.handle_datagram(datagram, self._clock()):
                newest_accepted = True

        if newest_accepted:
            # Forward the freshest command right away.
            self._write_frame(self._clock())

    def handle_datagram(self, datagram: bytes, now: float) -> bool:
        """Process one datagram. Returns True if it carried a new control command."""
        key = self._config.auth_key
        packet_type = peek_packet_type(datagram)

        try:
            if packet_type is PacketType.CONTROL:
                control = parse_control_datagram(key, datagram)
                if not self._sequence_filter.accept(control.seq, now):
                    return False
                self._command.apply(control, now)
                self._record_echo(control.relay_ts_ms, now)
                return True

            if packet_type is PacketType.PING:
                ping = parse_ping_datagram(key, datagram)
                if self._sequence_filter.accept(ping.seq, now):
                    self._record_echo(ping.relay_ts_ms, now)
                return False
        except ProtocolError as exc:
            self._note_rejected(now, str(exc))
            return False

        self._note_rejected(now, "unexpected packet type")
        return False

    def _record_echo(self, relay_ts_ms: int, now: float) -> None:
        self._echo_ts_ms = relay_ts_ms
        self._echo_rx_time = now

    def _note_rejected(self, now: float, reason: str) -> None:
        self._rejected_since_log += 1
        if now - self._last_reject_log >= REJECT_LOG_INTERVAL_S:
            logger.warning(
                "Rejected %d datagram(s) in the last interval (last reason: %s)",
                self._rejected_since_log,
                reason,
            )
            self._last_reject_log = now
            self._rejected_since_log = 0

    def _close_udp(self) -> None:
        if self._udp is not None:
            try:
                self._udp.close()
            except OSError:
                pass
            self._udp = None

    # ------------------------------------------------------------------
    # Serial link to the Arduino
    # ------------------------------------------------------------------

    def _ensure_serial(self, now: float) -> None:
        if self._serial is not None or now < self._serial_retry_at:
            return

        cfg = self._config
        try:
            port = serial.Serial(
                port=cfg.serial_port,
                baudrate=cfg.serial_baud,
                timeout=0,
                write_timeout=0.02,
            )
        except (serial.SerialException, OSError) as exc:
            logger.warning("Could not open %s (%s); is the Arduino plugged in?", cfg.serial_port, exc)
            self._serial_retry_at = now + cfg.serial_reopen_interval_s
            return

        try:
            # Ask the USB-serial chip to flush after every byte instead of on a
            # timer. Supported by FTDI-class bridges; harmless to skip.
            port.set_low_latency_mode(True)
        except (OSError, ValueError, NotImplementedError, serial.SerialException):
            logger.debug("Low-latency serial mode not supported by this adapter")

        self._serial = port
        self._status_parser = ArduinoStatusParser()
        logger.info("Opened serial port %s", cfg.serial_port)

    def _close_serial(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            except (serial.SerialException, OSError):
                pass
            self._serial = None

    def _write_frame(self, now: float) -> None:
        port = self._serial
        if port is None:
            return

        channels = self._command.effective(now)
        frame = build_arduino_frame(
            throttle=channels.throttle,
            steer=channels.steer,
            cam_yaw=channels.cam_yaw,
            cam_pitch=channels.cam_pitch,
        )
        try:
            port.write(frame)
        except (serial.SerialException, OSError) as exc:
            logger.warning("Serial write failed: %s", exc)
            self._close_serial()
            self._serial_retry_at = now + self._config.serial_reopen_interval_s

    def _drain_serial(self) -> None:
        port = self._serial
        if port is None:
            return

        try:
            data = port.read(SERIAL_READ_CHUNK)
        except (serial.SerialException, OSError) as exc:
            logger.warning("Serial read failed: %s", exc)
            self._close_serial()
            self._serial_retry_at = self._clock() + self._config.serial_reopen_interval_s
            return

        if not data:
            return

        statuses = self._status_parser.feed(data)
        if statuses:
            self._arduino_status = statuses[-1]
            self._arduino_last_seen = self._clock()

    # ------------------------------------------------------------------
    # Telemetry / keepalive
    # ------------------------------------------------------------------

    def _refresh_health(self, now: float) -> None:
        if now < self._health_next_refresh:
            return
        self._cpu_temp_deci_c = read_cpu_temp_deci_c()
        self._throttled_flags = read_throttled_flags()
        self._wifi_rssi_dbm = read_wifi_rssi_dbm()
        self._health_next_refresh = now + HEALTH_REFRESH_INTERVAL_S

    def _build_telemetry(self, now: float) -> TelemetryPacket:
        self._refresh_health(now)

        echo_rx = self._echo_rx_time
        hold_ms = 0 if echo_rx is None else int((now - echo_rx) * 1000.0)

        flags = 0
        frames = 0
        age_ms = ARDUINO_AGE_NEVER
        status = self._arduino_status
        if status is not None and self._arduino_last_seen is not None:
            flags |= ARDUINO_FLAG_LINK_HEARD
            if status.failsafe_active:
                flags |= ARDUINO_FLAG_FAILSAFE
            frames = status.frames_since_boot
            age_ms = int((now - self._arduino_last_seen) * 1000.0)
        else:
            # Never heard from the Arduino: report failsafe so the UI is honest.
            flags |= ARDUINO_FLAG_FAILSAFE

        packet = TelemetryPacket(
            seq=self._telemetry_seq,
            echo_ts_ms=self._echo_ts_ms,
            hold_ms=hold_ms,
            cpu_temp_deci_c=self._cpu_temp_deci_c,
            throttled_flags=self._throttled_flags,
            wifi_rssi_dbm=self._wifi_rssi_dbm,
            arduino_flags=flags,
            arduino_frames=frames,
            arduino_age_ms=age_ms,
        )
        self._telemetry_seq = (self._telemetry_seq + 1) & 0xFFFF
        return packet

    def _send_telemetry(self, now: float) -> None:
        sock = self._udp
        if sock is None:
            return

        datagram = build_telemetry_datagram(self._config.auth_key, self._build_telemetry(now))
        try:
            sock.send(datagram)
        except (BlockingIOError, ConnectionRefusedError):
            # Send buffer full or relay down; the next interval retries.
            pass
        except OSError as exc:
            logger.warning("UDP send failed (%s); reopening socket", exc)
            self._close_udp()
