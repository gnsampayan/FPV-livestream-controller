"""Tests for the UDP/serial wire protocols and the command deadman logic."""

from __future__ import annotations

import pytest

from fpv_control.config import ConfigError, load_config
from fpv_control.daemon import Channels, CommandState, ControlDaemon
from fpv_control.protocol import (
    ARDUINO_AGE_NEVER,
    ARDUINO_FRAME_MAGIC,
    ARDUINO_STATUS_MAGIC,
    ArduinoStatusParser,
    ControlPacket,
    PacketType,
    PingPacket,
    ProtocolError,
    SequenceFilter,
    TelemetryPacket,
    build_arduino_frame,
    build_control_datagram,
    build_ping_datagram,
    build_telemetry_datagram,
    parse_control_datagram,
    parse_ping_datagram,
    parse_telemetry_datagram,
    peek_packet_type,
    seq_is_newer,
)

KEY = b"test-key"


def make_control(seq: int = 1, **overrides: int) -> ControlPacket:
    fields = {
        "seq": seq,
        "relay_ts_ms": 123456,
        "throttle": 500,
        "steer": -250,
        "cam_yaw": 1000,
        "cam_pitch": -1000,
    }
    fields.update(overrides)
    return ControlPacket(**fields)


class TestControlDatagram:
    def test_round_trip(self) -> None:
        packet = make_control()
        parsed = parse_control_datagram(KEY, build_control_datagram(KEY, packet))
        assert parsed == packet

    def test_length_is_24_bytes(self) -> None:
        assert len(build_control_datagram(KEY, make_control())) == 24

    def test_channels_are_clamped(self) -> None:
        raw = build_control_datagram(KEY, make_control(throttle=5000, steer=-5000))
        parsed = parse_control_datagram(KEY, raw)
        assert parsed.throttle == 1000
        assert parsed.steer == -1000

    def test_wrong_key_is_rejected(self) -> None:
        raw = build_control_datagram(KEY, make_control())
        with pytest.raises(ProtocolError):
            parse_control_datagram(b"other-key", raw)

    def test_tampered_payload_is_rejected(self) -> None:
        raw = bytearray(build_control_datagram(KEY, make_control()))
        raw[6] ^= 0x01
        with pytest.raises(ProtocolError):
            parse_control_datagram(KEY, bytes(raw))

    def test_truncated_datagram_is_rejected(self) -> None:
        raw = build_control_datagram(KEY, make_control())
        with pytest.raises(ProtocolError):
            parse_control_datagram(KEY, raw[:-1])

    def test_telemetry_is_not_accepted_as_control(self) -> None:
        telemetry = TelemetryPacket(0, 0, 0, 0, 0, 0, 0, 0, ARDUINO_AGE_NEVER)
        raw = build_telemetry_datagram(KEY, telemetry)
        with pytest.raises(ProtocolError):
            parse_control_datagram(KEY, raw)


class TestPingDatagram:
    def test_round_trip(self) -> None:
        packet = PingPacket(seq=5, relay_ts_ms=99)
        parsed = parse_ping_datagram(KEY, build_ping_datagram(KEY, packet))
        assert parsed == packet

    def test_length_is_16_bytes(self) -> None:
        assert len(build_ping_datagram(KEY, PingPacket(0, 0))) == 16

    def test_peek_packet_type(self) -> None:
        assert peek_packet_type(build_ping_datagram(KEY, PingPacket(0, 0))) is PacketType.PING
        assert peek_packet_type(build_control_datagram(KEY, make_control())) is PacketType.CONTROL
        assert peek_packet_type(b"") is None
        assert peek_packet_type(b"\x00\x02\x00\x00") is None


class TestDaemonDatagramHandling:
    @staticmethod
    def make_daemon() -> ControlDaemon:
        config = load_config(
            {"CONTROL_RELAY_HOST": "10.0.0.2", "AUTH_TOKEN": KEY.decode("ascii")}
        )
        return ControlDaemon(config)

    def test_control_datagram_applies_and_ping_does_not(self) -> None:
        daemon = self.make_daemon()
        ping = build_ping_datagram(KEY, PingPacket(seq=1, relay_ts_ms=10))
        control = build_control_datagram(KEY, make_control(seq=2))
        assert daemon.handle_datagram(ping, now=0.0) is False
        assert daemon.handle_datagram(control, now=0.01) is True

    def test_replayed_control_datagram_is_ignored(self) -> None:
        daemon = self.make_daemon()
        control = build_control_datagram(KEY, make_control(seq=2))
        assert daemon.handle_datagram(control, now=0.0) is True
        assert daemon.handle_datagram(control, now=0.01) is False

    def test_forged_datagram_is_ignored(self) -> None:
        daemon = self.make_daemon()
        forged = build_control_datagram(b"attacker", make_control(seq=2))
        assert daemon.handle_datagram(forged, now=0.0) is False

    def test_garbage_is_ignored(self) -> None:
        daemon = self.make_daemon()
        assert daemon.handle_datagram(b"\x01\x02\x03", now=0.0) is False


class TestTelemetryDatagram:
    def test_round_trip(self) -> None:
        packet = TelemetryPacket(
            seq=7,
            echo_ts_ms=4_000_000_000,
            hold_ms=12,
            cpu_temp_deci_c=523,
            throttled_flags=0x50005,
            wifi_rssi_dbm=-61,
            arduino_flags=0x03,
            arduino_frames=200,
            arduino_age_ms=18,
        )
        parsed = parse_telemetry_datagram(KEY, build_telemetry_datagram(KEY, packet))
        assert parsed == packet

    def test_length_is_29_bytes(self) -> None:
        packet = TelemetryPacket(0, 0, 0, 0, 0, 0, 0, 0, 0)
        assert len(build_telemetry_datagram(KEY, packet)) == 29


class TestSequenceHandling:
    @pytest.mark.parametrize(
        ("candidate", "reference", "expected"),
        [
            (2, 1, True),
            (1, 1, False),
            (1, 2, False),
            (0, 0xFFFF, True),       # wraparound forward
            (0xFFFF, 0, False),      # wraparound backward
            (0x8000, 0, False),      # exactly half the space ahead is treated as old
            (0x7FFF, 0, True),
        ],
    )
    def test_seq_is_newer(self, candidate: int, reference: int, expected: bool) -> None:
        assert seq_is_newer(candidate, reference) is expected

    def test_filter_drops_replays_and_reordering(self) -> None:
        seq_filter = SequenceFilter(resync_after_s=1.0)
        assert seq_filter.accept(10, now=0.0)
        assert not seq_filter.accept(10, now=0.01)
        assert not seq_filter.accept(9, now=0.02)
        assert seq_filter.accept(11, now=0.03)

    def test_filter_resyncs_after_silence(self) -> None:
        seq_filter = SequenceFilter(resync_after_s=1.0)
        assert seq_filter.accept(30000, now=0.0)
        # Relay restarted and counts from 1 again.
        assert not seq_filter.accept(1, now=0.5)
        assert seq_filter.accept(1, now=2.0)
        assert seq_filter.accept(2, now=2.01)


class TestArduinoFrames:
    def test_frame_layout_and_checksum(self) -> None:
        frame = build_arduino_frame(throttle=1000, steer=-1000, cam_yaw=0, cam_pitch=250)
        assert len(frame) == 10
        assert frame[0] == ARDUINO_FRAME_MAGIC

        checksum = 0
        for byte in frame[:-1]:
            checksum ^= byte
        assert frame[-1] == checksum

    def test_frame_values_are_little_endian_signed(self) -> None:
        frame = build_arduino_frame(throttle=-2, steer=1, cam_yaw=0, cam_pitch=0)
        assert frame[1:3] == b"\xfe\xff"
        assert frame[3:5] == b"\x01\x00"

    def test_status_parser_handles_split_frames_and_noise(self) -> None:
        parser = ArduinoStatusParser()
        assert parser.feed(b"boot\n") == []
        assert parser.feed(bytes([ARDUINO_STATUS_MAGIC, 42])) == []
        statuses = parser.feed(bytes([0x01, ARDUINO_STATUS_MAGIC, 43, 0x00]))
        assert [s.frames_since_boot for s in statuses] == [42, 43]
        assert [s.failsafe_active for s in statuses] == [True, False]


class TestCommandState:
    def test_stale_before_first_command(self) -> None:
        state = CommandState(deadman_timeout_s=0.25)
        assert state.is_stale(now=0.0)
        assert state.effective(now=0.0) == Channels()

    def test_fresh_command_passes_through(self) -> None:
        state = CommandState(deadman_timeout_s=0.25)
        state.apply(make_control(throttle=400, steer=-300, cam_yaw=100, cam_pitch=-100), now=1.0)
        assert state.effective(now=1.1) == Channels(400, -300, 100, -100)

    def test_deadman_neutralises_drive_but_holds_camera(self) -> None:
        state = CommandState(deadman_timeout_s=0.25)
        state.apply(make_control(throttle=400, steer=-300, cam_yaw=100, cam_pitch=-100), now=1.0)
        assert state.effective(now=1.5) == Channels(0, 0, 100, -100)

    def test_reset_centres_everything(self) -> None:
        state = CommandState(deadman_timeout_s=0.25)
        state.apply(make_control(), now=1.0)
        state.reset()
        assert state.effective(now=1.0) == Channels()


class TestConfig:
    def test_missing_host_is_an_error(self) -> None:
        with pytest.raises(ConfigError):
            load_config({"AUTH_TOKEN": "secret"})

    def test_placeholder_token_is_an_error(self) -> None:
        with pytest.raises(ConfigError):
            load_config({"CONTROL_RELAY_HOST": "10.0.0.2", "AUTH_TOKEN": "changeme"})

    def test_janus_host_is_used_as_fallback(self) -> None:
        config = load_config({"JANUS_HOST": "10.0.0.2", "AUTH_TOKEN": "secret"})
        assert config.relay_host == "10.0.0.2"
        assert config.relay_port == 3002
        assert config.auth_key == b"secret"

    def test_out_of_range_port_is_an_error(self) -> None:
        with pytest.raises(ConfigError):
            load_config(
                {
                    "CONTROL_RELAY_HOST": "10.0.0.2",
                    "CONTROL_RELAY_PORT": "70000",
                    "AUTH_TOKEN": "secret",
                }
            )
