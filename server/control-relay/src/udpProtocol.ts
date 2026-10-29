/**
 * UDP wire protocol between the relay and the Pi control daemon.
 *
 * Must stay byte-for-byte compatible with pi/control-daemon/fpv_control/protocol.py,
 * which is the canonical description of the format. In short, every datagram is
 *
 *   header (4)  | payload (N) | mac (8)
 *   magic 0xFC, type u8, seq u16 (little-endian)
 *   mac = HMAC-SHA256(key, header | payload) truncated to 8 bytes
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const DATAGRAM_MAGIC = 0xfc;
export const MAC_LENGTH = 8;
export const HEADER_LENGTH = 4;
export const CHANNEL_LIMIT = 1000;
export const ARDUINO_AGE_NEVER = 0xffff;

export const ARDUINO_FLAG_FAILSAFE = 0x01;
export const ARDUINO_FLAG_LINK_HEARD = 0x02;

export enum PacketType {
  Ping = 1,
  Control = 2,
  Telemetry = 3,
}

const PING_PAYLOAD_LENGTH = 4;
const CONTROL_PAYLOAD_LENGTH = 12;
const TELEMETRY_PAYLOAD_LENGTH = 17;
const SEQ_MODULUS = 0x10000;
const UINT32_MODULUS = 0x100000000;

export interface ControlChannels {
  /** -1000..+1000 */
  throttle: number;
  /** -1000..+1000 */
  steer: number;
  /** -1000..+1000 */
  camYaw: number;
  /** -1000..+1000 */
  camPitch: number;
}

export interface TelemetryPacket {
  seq: number;
  echoTsMs: number;
  holdMs: number;
  /** CPU temperature in degrees Celsius (0.1 resolution). */
  cpuTempC: number;
  throttledFlags: number;
  /** 0 when unknown. */
  wifiRssiDbm: number;
  arduinoFailsafe: boolean;
  arduinoLinkHeard: boolean;
  arduinoFrames: number;
  /** null when the Arduino has never replied. */
  arduinoAgeMs: number | null;
}

function computeMac(key: Buffer, body: Buffer): Buffer {
  return createHmac('sha256', key).update(body).digest().subarray(0, MAC_LENGTH);
}

function clampChannel(value: number): number {
  return Math.max(-CHANNEL_LIMIT, Math.min(CHANNEL_LIMIT, Math.round(value)));
}

function seal(key: Buffer, type: PacketType, seq: number, payload: Buffer): Buffer {
  const body = Buffer.alloc(HEADER_LENGTH + payload.length);
  body.writeUInt8(DATAGRAM_MAGIC, 0);
  body.writeUInt8(type, 1);
  body.writeUInt16LE(seq % SEQ_MODULUS, 2);
  payload.copy(body, HEADER_LENGTH);
  return Buffer.concat([body, computeMac(key, body)]);
}

export function buildPingDatagram(key: Buffer, seq: number, relayTsMs: number): Buffer {
  const payload = Buffer.alloc(PING_PAYLOAD_LENGTH);
  payload.writeUInt32LE(relayTsMs % UINT32_MODULUS, 0);
  return seal(key, PacketType.Ping, seq, payload);
}

export function buildControlDatagram(
  key: Buffer,
  seq: number,
  relayTsMs: number,
  channels: ControlChannels,
): Buffer {
  const payload = Buffer.alloc(CONTROL_PAYLOAD_LENGTH);
  payload.writeUInt32LE(relayTsMs % UINT32_MODULUS, 0);
  payload.writeInt16LE(clampChannel(channels.throttle), 4);
  payload.writeInt16LE(clampChannel(channels.steer), 6);
  payload.writeInt16LE(clampChannel(channels.camYaw), 8);
  payload.writeInt16LE(clampChannel(channels.camPitch), 10);
  return seal(key, PacketType.Control, seq, payload);
}

/**
 * Verify and decode a TELEMETRY datagram.
 * Returns null for anything malformed, forged, or of another type.
 */
export function parseTelemetryDatagram(key: Buffer, datagram: Buffer): TelemetryPacket | null {
  const expectedLength = HEADER_LENGTH + TELEMETRY_PAYLOAD_LENGTH + MAC_LENGTH;
  if (datagram.length !== expectedLength) {
    return null;
  }

  const body = datagram.subarray(0, datagram.length - MAC_LENGTH);
  const mac = datagram.subarray(datagram.length - MAC_LENGTH);
  if (!timingSafeEqual(mac, computeMac(key, body))) {
    return null;
  }

  if (body.readUInt8(0) !== DATAGRAM_MAGIC || body.readUInt8(1) !== PacketType.Telemetry) {
    return null;
  }

  const seq = body.readUInt16LE(2);
  const payload = body.subarray(HEADER_LENGTH);
  const arduinoFlags = payload.readUInt8(13);
  const rawAge = payload.readUInt16LE(15);

  return {
    seq,
    echoTsMs: payload.readUInt32LE(0),
    holdMs: payload.readUInt16LE(4),
    cpuTempC: payload.readInt16LE(6) / 10,
    throttledFlags: payload.readUInt32LE(8),
    wifiRssiDbm: payload.readInt8(12),
    arduinoFailsafe: (arduinoFlags & ARDUINO_FLAG_FAILSAFE) !== 0,
    arduinoLinkHeard: (arduinoFlags & ARDUINO_FLAG_LINK_HEARD) !== 0,
    arduinoFrames: payload.readUInt8(14),
    arduinoAgeMs: rawAge === ARDUINO_AGE_NEVER ? null : rawAge,
  };
}

/**
 * Round-trip time in ms from a telemetry echo, or null if it is not credible.
 *
 * rtt = now - echoTs - hold, computed modulo 2^32 so timer wraparound is safe.
 * The relay stamps PING/CONTROL with its own monotonic clock, so no clock
 * sync with the Pi is required.
 */
export function computeRttMs(nowMs: number, echoTsMs: number, holdMs: number): number | null {
  if (echoTsMs === 0) {
    return null;
  }
  const raw = (((nowMs - echoTsMs - holdMs) % UINT32_MODULUS) + UINT32_MODULUS) % UINT32_MODULUS;
  const maxCredibleRttMs = 10_000;
  return raw <= maxCredibleRttMs ? raw : null;
}
