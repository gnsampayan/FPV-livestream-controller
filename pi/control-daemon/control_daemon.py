#!/usr/bin/env python3
"""FPV Control Daemon for Raspberry Pi.

Connects to the home server's control relay over WebSocket, receives control
commands from the driver, and forwards them as binary frames to an Arduino
Nano over USB-CDC serial. The Arduino generates the actual servo/ESC PWM.

Responsibilities:
- WebSocket client with auth + auto-reconnect.
- 50 Hz serial output loop with a 250 ms deadman timeout.
- Telemetry uplink: CPU temperature + Arduino link health.
- Graceful resync if the Arduino is unplugged/reset.
"""

import json
import logging
import os
import signal
import struct
import sys
import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional

try:
    import serial  # type: ignore - installed on Pi via requirements.txt
except ImportError:
    print("pyserial not found. Install with: pip3 install pyserial")
    sys.exit(1)

try:
    import websocket  # type: ignore - installed on Pi via requirements.txt
except ImportError:
    print("websocket-client not found. Install with: pip3 install websocket-client")
    sys.exit(1)


CONFIG = {
    "server_url": os.environ.get("CONTROL_SERVER", "ws://100.x.x.x:3001"),
    "auth_token": os.environ.get("AUTH_TOKEN", "changeme"),
    "reconnect_interval": 5,

    "serial_port": os.environ.get("SERIAL_PORT", "/dev/fpv-arduino"),
    "serial_baud": int(os.environ.get("SERIAL_BAUD", "500000")),
    "serial_reopen_interval": 1.0,

    "deadman_timeout": 0.25,
    "control_rate": 50,

    "telemetry_interval": 1.0,
}

FRAME_MAGIC = 0xA5
STATUS_MAGIC = 0x5A
STATUS_FLAG_FAILSAFE = 0x01
FRAME_STRUCT = struct.Struct("<Bhhhh")


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


class ConnectionState(Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"


@dataclass
class ControlState:
    steer: float = 0.0       # -1..+1
    throttle: float = 0.0    #  0..+1  (brake overrides to 0)
    brake: float = 0.0       #  0..+1
    cam_yaw: float = 0.0     # -1..+1
    cam_pitch: float = 0.0   # -1..+1
    timestamp: float = 0.0


@dataclass
class ArduinoStatus:
    frames_since_boot: int = 0
    failsafe_active: bool = True
    last_seen: float = 0.0


def _clamp(value: float, low: float, high: float) -> float:
    if value < low:
        return low
    if value > high:
        return high
    return value


def _to_channel_int(value: float) -> int:
    """Map a -1..+1 float to the Arduino's -1000..+1000 int16 range."""
    return int(round(_clamp(value, -1.0, 1.0) * 1000.0))


def build_control_frame(steer: float,
                        throttle: float,
                        cam_yaw: float,
                        cam_pitch: float) -> bytes:
    """Pack a 10-byte control frame: magic + 4x int16 + XOR checksum."""
    payload = FRAME_STRUCT.pack(
        FRAME_MAGIC,
        _to_channel_int(throttle),
        _to_channel_int(steer),
        _to_channel_int(cam_yaw),
        _to_channel_int(cam_pitch),
    )
    xor_sum = 0
    for b in payload:
        xor_sum ^= b
    return payload + bytes([xor_sum & 0xFF])


class ControlDaemon:
    def __init__(self) -> None:
        self.ws: Optional[websocket.WebSocketApp] = None
        self.ser: Optional[serial.Serial] = None
        self.ser_lock = threading.Lock()

        self.connection_state = ConnectionState.DISCONNECTED
        self.running = True

        self.control = ControlState()
        self.control_lock = threading.Lock()
        self.last_command_time = 0.0

        self.arduino = ArduinoStatus()
        self.arduino_lock = threading.Lock()

        self.serial_thread: Optional[threading.Thread] = None
        self.telemetry_thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        logger.info("Starting FPV Control Daemon")
        logger.info(
            "Serial: %s @ %d baud", CONFIG["serial_port"], CONFIG["serial_baud"]
        )

        self._open_serial(initial=True)

        self.serial_thread = threading.Thread(target=self._serial_loop, daemon=True)
        self.serial_thread.start()

        self.telemetry_thread = threading.Thread(target=self._telemetry_loop, daemon=True)
        self.telemetry_thread.start()

        self._connect()

    def stop(self) -> None:
        logger.info("Stopping FPV Control Daemon")
        self.running = False

        self._set_safe_state()

        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass

        with self.ser_lock:
            if self.ser is not None:
                try:
                    self.ser.close()
                except Exception:
                    pass
                self.ser = None

    # ------------------------------------------------------------------
    # Serial
    # ------------------------------------------------------------------

    def _open_serial(self, initial: bool = False) -> bool:
        """(Re)open the Arduino serial port. Thread-safe."""
        with self.ser_lock:
            if self.ser is not None:
                try:
                    self.ser.close()
                except Exception:
                    pass
                self.ser = None
            try:
                self.ser = serial.Serial(
                    port=CONFIG["serial_port"],
                    baudrate=CONFIG["serial_baud"],
                    timeout=0,
                    write_timeout=0.02,
                )
                logger.info("Opened serial port %s", CONFIG["serial_port"])
                return True
            except (serial.SerialException, OSError) as e:
                if initial:
                    logger.error(
                        "Could not open %s (%s). Will retry; is the Arduino plugged in?",
                        CONFIG["serial_port"], e,
                    )
                else:
                    logger.warning("Serial reopen failed: %s", e)
                self.ser = None
                return False

    def _set_safe_state(self) -> None:
        """Center all channels, stop throttle. Best-effort write to Arduino."""
        with self.control_lock:
            self.control.steer = 0.0
            self.control.throttle = 0.0
            self.control.brake = 0.0
            self.control.cam_yaw = 0.0
            self.control.cam_pitch = 0.0

        frame = build_control_frame(0.0, 0.0, 0.0, 0.0)
        with self.ser_lock:
            if self.ser is not None:
                try:
                    self.ser.write(frame)
                except (serial.SerialException, OSError):
                    pass

    def _serial_loop(self) -> None:
        """50 Hz loop: pack current control state into a frame and send it.

        If no command has arrived within the deadman window, or if the WebSocket
        is not authenticated, send a neutral frame. The Arduino also runs its
        own failsafe; this is the first line of defense.
        """
        interval = 1.0 / CONFIG["control_rate"]
        next_tick = time.monotonic()

        while self.running:
            try:
                now_wall = time.time()

                with self.control_lock:
                    stale = (now_wall - self.last_command_time) > CONFIG["deadman_timeout"]
                    authed = self.connection_state == ConnectionState.CONNECTED

                    if stale or not authed:
                        steer = 0.0
                        throttle = 0.0
                        cam_yaw = self.control.cam_yaw
                        cam_pitch = self.control.cam_pitch
                    else:
                        steer = self.control.steer
                        throttle = 0.0 if self.control.brake > 0.0 else self.control.throttle
                        cam_yaw = self.control.cam_yaw
                        cam_pitch = self.control.cam_pitch

                frame = build_control_frame(steer, throttle, cam_yaw, cam_pitch)

                wrote = False
                with self.ser_lock:
                    if self.ser is not None:
                        try:
                            self.ser.write(frame)
                            wrote = True
                        except (serial.SerialException, OSError) as e:
                            logger.warning("Serial write failed: %s", e)
                            try:
                                self.ser.close()
                            except Exception:
                                pass
                            self.ser = None

                if not wrote:
                    time.sleep(CONFIG["serial_reopen_interval"])
                    self._open_serial()
                    next_tick = time.monotonic()
                    continue

            except Exception as e:
                logger.error("Serial loop error: %s", e)

            next_tick += interval
            sleep_for = next_tick - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
            else:
                # We fell behind; resync the schedule instead of spinning.
                next_tick = time.monotonic()

    def _drain_arduino_status(self) -> None:
        """Consume any status replies the Arduino has queued.

        Frame format: [0x5A, frames_mod_256, flags]. We read whatever is
        available without blocking, scan for the magic, and update shared
        state. Non-magic bytes are discarded (log noise, boot banners, etc).
        """
        with self.ser_lock:
            if self.ser is None:
                return
            try:
                data = self.ser.read(64)
            except (serial.SerialException, OSError):
                return

        if not data:
            return

        i = 0
        while i + 2 < len(data):
            if data[i] == STATUS_MAGIC:
                frames = data[i + 1]
                flags = data[i + 2]
                with self.arduino_lock:
                    self.arduino.frames_since_boot = frames
                    self.arduino.failsafe_active = bool(flags & STATUS_FLAG_FAILSAFE)
                    self.arduino.last_seen = time.time()
                i += 3
            else:
                i += 1

    # ------------------------------------------------------------------
    # WebSocket
    # ------------------------------------------------------------------

    def _connect(self) -> None:
        while self.running:
            try:
                self.connection_state = ConnectionState.CONNECTING
                logger.info("Connecting to %s", CONFIG["server_url"])

                self.ws = websocket.WebSocketApp(
                    CONFIG["server_url"],
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self.ws.run_forever()

            except Exception as e:
                logger.error("WebSocket connection error: %s", e)

            if self.running:
                self.connection_state = ConnectionState.DISCONNECTED
                self._set_safe_state()
                logger.info(
                    "Reconnecting in %d seconds...", CONFIG["reconnect_interval"]
                )
                time.sleep(CONFIG["reconnect_interval"])

    def _on_open(self, ws: "websocket.WebSocketApp") -> None:
        logger.info("WebSocket connected, authenticating...")
        auth_msg = {
            "type": "auth",
            "token": CONFIG["auth_token"],
            "clientType": "pi",
        }
        ws.send(json.dumps(auth_msg))

    def _on_message(self, ws: "websocket.WebSocketApp", message: str) -> None:
        try:
            msg = json.loads(message)
        except json.JSONDecodeError as e:
            logger.error("Failed to parse message: %s", e)
            return

        msg_type = msg.get("type")
        if msg_type == "auth_success":
            self.connection_state = ConnectionState.CONNECTED
            logger.info("Authentication successful")
        elif msg_type == "control":
            self._handle_control(msg)
        elif msg_type == "status":
            logger.debug("Status: %s", msg)
        elif msg_type == "error":
            logger.error("Server error: %s", msg.get("message"))

    def _on_error(self, ws: "websocket.WebSocketApp", error: BaseException) -> None:
        logger.error("WebSocket error: %s", error)

    def _on_close(self, ws: "websocket.WebSocketApp",
                  close_status_code: Optional[int],
                  close_msg: Optional[str]) -> None:
        logger.info("WebSocket closed: %s %s", close_status_code, close_msg)
        self.connection_state = ConnectionState.DISCONNECTED
        self._set_safe_state()

    def _handle_control(self, msg: dict) -> None:
        with self.control_lock:
            self.control.steer = _clamp(float(msg.get("steer", 0.0)), -1.0, 1.0)
            self.control.throttle = _clamp(float(msg.get("throttle", 0.0)), 0.0, 1.0)
            self.control.brake = _clamp(float(msg.get("brake", 0.0)), 0.0, 1.0)
            self.control.cam_yaw = _clamp(float(msg.get("camYaw", 0.0)), -1.0, 1.0)
            self.control.cam_pitch = _clamp(float(msg.get("camPitch", 0.0)), -1.0, 1.0)
            self.control.timestamp = float(msg.get("timestamp", time.time() * 1000))
            self.last_command_time = time.time()

    # ------------------------------------------------------------------
    # Telemetry
    # ------------------------------------------------------------------

    def _telemetry_loop(self) -> None:
        while self.running:
            try:
                self._drain_arduino_status()

                if self.ws is not None and self.connection_state == ConnectionState.CONNECTED:
                    with self.arduino_lock:
                        arduino_payload = {
                            "framesSinceBoot": self.arduino.frames_since_boot,
                            "failsafeActive": self.arduino.failsafe_active,
                            "linkAgeMs": int(max(0.0, (time.time() - self.arduino.last_seen) * 1000.0))
                                         if self.arduino.last_seen > 0 else None,
                        }

                    telemetry = {
                        "type": "telemetry",
                        "timestamp": int(time.time() * 1000),
                        "cpuTemp": self._get_cpu_temp(),
                        "arduino": arduino_payload,
                    }
                    try:
                        self.ws.send(json.dumps(telemetry))
                    except Exception as e:
                        logger.debug("Telemetry send failed: %s", e)

                time.sleep(CONFIG["telemetry_interval"])

            except Exception as e:
                logger.error("Telemetry error: %s", e)
                time.sleep(1)

    @staticmethod
    def _get_cpu_temp() -> float:
        try:
            with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
                return round(float(f.read().strip()) / 1000.0, 1)
        except Exception:
            return 0.0


def main() -> None:
    daemon = ControlDaemon()

    def signal_handler(signum: int, _frame: object) -> None:
        logger.info("Received signal %d", signum)
        daemon.stop()
        sys.exit(0)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    try:
        daemon.start()
    except KeyboardInterrupt:
        daemon.stop()


if __name__ == "__main__":
    main()
