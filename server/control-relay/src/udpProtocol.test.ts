import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  MAC_LENGTH,
  PacketType,
  buildControlDatagram,
  buildPingDatagram,
  computeRttMs,
  parseTelemetryDatagram,
} from './udpProtocol';

const KEY = Buffer.from('test-key', 'utf8');

function mac(key: Buffer, body: Buffer): Buffer {
  return createHmac('sha256', key).update(body).digest().subarray(0, MAC_LENGTH);
}

interface TelemetryFixture {
  seq: number;
  echoTsMs: number;
  holdMs: number;
  cpuTempDeciC: number;
  throttledFlags: number;
  wifiRssiDbm: number;
  arduinoFlags: number;
  arduinoFrames: number;
  arduinoAgeMs: number;
}

/** Independent re-implementation of the Pi's telemetry encoder for tests. */
function buildTelemetry(key: Buffer, fixture: TelemetryFixture): Buffer {
  const body = Buffer.alloc(4 + 17);
  body.writeUInt8(0xfc, 0);
  body.writeUInt8(PacketType.Telemetry, 1);
  body.writeUInt16LE(fixture.seq, 2);
  body.writeUInt32LE(fixture.echoTsMs, 4);
  body.writeUInt16LE(fixture.holdMs, 8);
  body.writeInt16LE(fixture.cpuTempDeciC, 10);
  body.writeUInt32LE(fixture.throttledFlags, 12);
  body.writeInt8(fixture.wifiRssiDbm, 16);
  body.writeUInt8(fixture.arduinoFlags, 17);
  body.writeUInt8(fixture.arduinoFrames, 18);
  body.writeUInt16LE(fixture.arduinoAgeMs, 19);
  return Buffer.concat([body, mac(key, body)]);
}

const FIXTURE: TelemetryFixture = {
  seq: 7,
  echoTsMs: 4_000_000_000,
  holdMs: 12,
  cpuTempDeciC: 523,
  throttledFlags: 0x50005,
  wifiRssiDbm: -61,
  arduinoFlags: 0x03,
  arduinoFrames: 200,
  arduinoAgeMs: 18,
};

describe('control datagram', () => {
  it('is 24 bytes with a valid MAC and little-endian signed channels', () => {
    const datagram = buildControlDatagram(KEY, 9, 123_456, {
      throttle: 500,
      steer: -250,
      camYaw: 5000,
      camPitch: -5000,
    });

    assert.equal(datagram.length, 24);
    const body = datagram.subarray(0, datagram.length - MAC_LENGTH);
    assert.deepEqual(datagram.subarray(datagram.length - MAC_LENGTH), mac(KEY, body));

    assert.equal(datagram.readUInt8(0), 0xfc);
    assert.equal(datagram.readUInt8(1), PacketType.Control);
    assert.equal(datagram.readUInt16LE(2), 9);
    assert.equal(datagram.readUInt32LE(4), 123_456);
    assert.equal(datagram.readInt16LE(8), 500);
    assert.equal(datagram.readInt16LE(10), -250);
    // Out-of-range channels are clamped.
    assert.equal(datagram.readInt16LE(12), 1000);
    assert.equal(datagram.readInt16LE(14), -1000);
  });
});

describe('ping datagram', () => {
  it('is 16 bytes with a valid MAC', () => {
    const datagram = buildPingDatagram(KEY, 3, 42);
    assert.equal(datagram.length, 16);
    assert.equal(datagram.readUInt8(1), PacketType.Ping);
    assert.equal(datagram.readUInt32LE(4), 42);
    const body = datagram.subarray(0, datagram.length - MAC_LENGTH);
    assert.deepEqual(datagram.subarray(datagram.length - MAC_LENGTH), mac(KEY, body));
  });
});

describe('telemetry datagram', () => {
  it('decodes every field', () => {
    const parsed = parseTelemetryDatagram(KEY, buildTelemetry(KEY, FIXTURE));
    assert.ok(parsed);
    assert.equal(parsed.seq, 7);
    assert.equal(parsed.echoTsMs, 4_000_000_000);
    assert.equal(parsed.holdMs, 12);
    assert.equal(parsed.cpuTempC, 52.3);
    assert.equal(parsed.throttledFlags, 0x50005);
    assert.equal(parsed.wifiRssiDbm, -61);
    assert.equal(parsed.arduinoFailsafe, true);
    assert.equal(parsed.arduinoLinkHeard, true);
    assert.equal(parsed.arduinoFrames, 200);
    assert.equal(parsed.arduinoAgeMs, 18);
  });

  it('reports a never-heard Arduino as null age', () => {
    const parsed = parseTelemetryDatagram(
      KEY,
      buildTelemetry(KEY, { ...FIXTURE, arduinoFlags: 0x01, arduinoAgeMs: 0xffff }),
    );
    assert.ok(parsed);
    assert.equal(parsed.arduinoAgeMs, null);
    assert.equal(parsed.arduinoLinkHeard, false);
  });

  it('rejects a wrong key, tampering, truncation, and other packet types', () => {
    const good = buildTelemetry(KEY, FIXTURE);
    assert.equal(parseTelemetryDatagram(Buffer.from('other', 'utf8'), good), null);

    const tampered = Buffer.from(good);
    tampered[8] ^= 0x01;
    assert.equal(parseTelemetryDatagram(KEY, tampered), null);

    assert.equal(parseTelemetryDatagram(KEY, good.subarray(0, good.length - 1)), null);
    assert.equal(parseTelemetryDatagram(KEY, buildPingDatagram(KEY, 1, 1)), null);
  });
});

describe('computeRttMs', () => {
  it('subtracts the echo timestamp and the Pi hold time', () => {
    assert.equal(computeRttMs(1_050, 1_000, 10), 40);
  });

  it('survives uint32 wraparound', () => {
    assert.equal(computeRttMs(10, 0xffff_fff0, 0), 26);
  });

  it('returns null when nothing has been echoed or the value is not credible', () => {
    assert.equal(computeRttMs(1_000, 0, 0), null);
    assert.equal(computeRttMs(1_000, 5_000, 0), null);
  });
});
