import http from 'http';
import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  ControlChannels,
  TelemetryPacket,
  buildControlDatagram,
  buildPingDatagram,
  computeRttMs,
  parseTelemetryDatagram,
} from './udpProtocol';

/*
 * Control relay.
 *
 *   browser --(WebSocket, JSON)--> relay --(UDP, binary + MAC)--> Pi daemon
 *   browser <--(WebSocket, JSON)-- relay <--(UDP, binary + MAC)-- Pi daemon
 *
 * The browser leg stays WebSocket because browsers cannot send raw UDP. The
 * Pi leg is UDP so a lost packet is simply superseded by the next one instead
 * of stalling every later command behind a TCP retransmit.
 *
 * The Pi announces itself by sending TELEMETRY datagrams a few times a second.
 * That opens the return path through carrier NAT and tells the relay where to
 * send control frames, so the Pi needs no inbound port forwarding.
 */

// Configuration
const WS_PORT = parseInt(process.env.PORT || '3001', 10);
const UDP_PORT = parseInt(process.env.UDP_PORT || '3002', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';
const AUTH_KEY = Buffer.from(AUTH_TOKEN, 'utf8');
const HEARTBEAT_INTERVAL_MS = 30_000;
const STATUS_BROADCAST_INTERVAL_MS = 5_000;
const PI_TIMEOUT_MS = parseInt(process.env.PI_TIMEOUT_MS || '3000', 10);
const PI_LINK_CHECK_INTERVAL_MS = 1_000;
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS || '250', 10);
const NOT_CONNECTED_NOTICE_INTERVAL_MS = 1_000;

// Types
interface ControlCommand {
  type: 'control';
  timestamp: number;
  steer: number;     // -1 (full left) to 1 (full right)
  throttle: number;  //  0 (stop) to 1 (full forward)
  brake?: number;    //  0 to 1 (optional)
  camYaw?: number;   // -1 (full left)  to 1 (full right)
  camPitch?: number; // -1 (full down)  to 1 (full up)
}

interface AuthMessage {
  type: 'auth';
  token: string;
  clientType: 'browser';
}

interface StatusMessage {
  type: 'status';
  piConnected: boolean;
  browserClients: number;
  latency?: number;
}

interface ArduinoLink {
  framesSinceBoot: number;
  failsafeActive: boolean;
  linkAgeMs: number | null;
}

interface TelemetryMessage {
  type: 'telemetry';
  timestamp: number;
  cpuTemp: number;
  rssi?: number;
  rttMs: number | null;
  throttledFlags: number;
  arduino: ArduinoLink;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

interface AuthSuccessMessage {
  type: 'auth_success';
}

type IncomingMessage = AuthMessage | ControlCommand;
type OutgoingMessage = StatusMessage | TelemetryMessage | ErrorMessage | AuthSuccessMessage;

interface Client {
  id: string;
  socket: WebSocket;
  authenticated: boolean;
  lastPing: number;
  lastNotConnectedNoticeAt: number;
}

interface PiLink {
  address: string;
  port: number;
  /** performance.now() of the last valid datagram from the Pi. */
  lastSeenAt: number;
  rttMs: number | null;
}

// State
const clients = new Map<string, Client>();
let piLink: PiLink | null = null;
let lastReportedPiAlive = false;
let outboundSeq = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Monotonic millisecond clock stamped into PING/CONTROL datagrams. Offset by 1
 * so a value of 0 can mean "never received" in the Pi's echo.
 */
function relayClockMs(): number {
  return Math.floor(performance.now()) + 1;
}

function nextSeq(): number {
  outboundSeq = (outboundSeq + 1) & 0xffff;
  return outboundSeq;
}

function isPiAlive(): boolean {
  return piLink !== null && performance.now() - piLink.lastSeenAt <= PI_TIMEOUT_MS;
}

function getBrowserClientCount(): number {
  let count = 0;
  clients.forEach((client) => {
    if (client.authenticated) {
      count++;
    }
  });
  return count;
}

function sendTo(client: Client, message: OutgoingMessage): void {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(message));
  }
}

function sendError(client: Client, message: string): void {
  sendTo(client, { type: 'error', message });
}

function broadcastToBrowsers(message: OutgoingMessage): void {
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.authenticated && client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(data);
    }
  });
}

function broadcastStatus(): void {
  const alive = isPiAlive();
  lastReportedPiAlive = alive;

  const status: StatusMessage = {
    type: 'status',
    piConnected: alive,
    browserClients: getBrowserClientCount(),
  };
  if (alive && piLink && piLink.rttMs !== null) {
    status.latency = piLink.rttMs;
  }
  broadcastToBrowsers(status);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket (browser leg)
// ---------------------------------------------------------------------------

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      piConnected: isPiAlive(),
      browserClients: getBrowserClientCount(),
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// Per-message deflate adds CPU and buffering delay and gains nothing on
// ~60-byte control messages.
const wss = new WebSocketServer({ server, path: '/', perMessageDeflate: false });

function parseClientMessage(data: RawData): IncomingMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  if (parsed.type === 'auth') {
    if (typeof parsed.token !== 'string' || parsed.clientType !== 'browser') {
      return null;
    }
    return { type: 'auth', token: parsed.token, clientType: 'browser' };
  }

  if (parsed.type === 'control') {
    return {
      type: 'control',
      timestamp: readNumber(parsed.timestamp, 0),
      steer: readNumber(parsed.steer, 0),
      throttle: readNumber(parsed.throttle, 0),
      brake: readNumber(parsed.brake, 0),
      camYaw: readNumber(parsed.camYaw, 0),
      camPitch: readNumber(parsed.camPitch, 0),
    };
  }

  return null;
}

function handleMessage(client: Client, data: RawData): void {
  const message = parseClientMessage(data);
  if (message === null) {
    sendError(client, 'Invalid message');
    return;
  }

  if (message.type === 'auth') {
    handleAuth(client, message);
    return;
  }

  if (!client.authenticated) {
    sendError(client, 'Not authenticated');
    return;
  }

  handleControlCommand(client, message);
}

function handleAuth(client: Client, message: AuthMessage): void {
  if (message.token !== AUTH_TOKEN) {
    sendError(client, 'Invalid authentication token');
    client.socket.close(4001, 'Unauthorized');
    return;
  }

  client.authenticated = true;
  console.log(`[INFO] Browser connected: ${client.id}`);

  sendTo(client, { type: 'auth_success' });
  broadcastStatus();
}

/**
 * Validate a browser command and forward it to the Pi immediately.
 *
 * Every command is sent as soon as it arrives (no batching or queueing). If
 * the socket backlog ever grows, `ws` delivers messages in order, but the Pi
 * keeps only the newest sequence number, so late stragglers are discarded
 * there rather than replayed.
 */
function handleControlCommand(client: Client, command: ControlCommand): void {
  const steer = clamp(command.steer, -1, 1);
  const throttle = clamp(command.throttle, 0, 1);
  const brake = clamp(command.brake ?? 0, 0, 1);
  const camYaw = clamp(command.camYaw ?? 0, -1, 1);
  const camPitch = clamp(command.camPitch ?? 0, -1, 1);

  const channels: ControlChannels = {
    // Braking overrides throttle.
    throttle: brake > 0 ? 0 : throttle * 1000,
    steer: steer * 1000,
    camYaw: camYaw * 1000,
    camPitch: camPitch * 1000,
  };

  if (!sendControlToPi(channels)) {
    const now = performance.now();
    if (now - client.lastNotConnectedNoticeAt >= NOT_CONNECTED_NOTICE_INTERVAL_MS) {
      client.lastNotConnectedNoticeAt = now;
      sendError(client, 'Pi not connected');
    }
  }
}

wss.on('connection', (socket: WebSocket, request: http.IncomingMessage) => {
  // Send each control message immediately instead of letting Nagle's
  // algorithm coalesce small writes.
  request.socket.setNoDelay(true);

  const clientId = uuidv4();
  const client: Client = {
    id: clientId,
    socket,
    authenticated: false,
    lastPing: Date.now(),
    lastNotConnectedNoticeAt: 0,
  };

  clients.set(clientId, client);
  console.log(`[INFO] Client connected: ${clientId} from ${request.socket.remoteAddress}`);

  socket.on('pong', () => {
    client.lastPing = Date.now();
  });

  socket.on('message', (data: RawData) => {
    handleMessage(client, data);
  });

  socket.on('close', (code: number, reason: Buffer) => {
    console.log(`[INFO] Client disconnected: ${clientId} (code: ${code}, reason: ${reason.toString()})`);
    clients.delete(clientId);
    broadcastStatus();
  });

  socket.on('error', (error: Error) => {
    console.error(`[ERROR] WebSocket error for ${clientId}:`, error.message);
  });
});

// ---------------------------------------------------------------------------
// UDP (Pi leg)
// ---------------------------------------------------------------------------

const udp = dgram.createSocket('udp4');

function sendToPi(datagram: Buffer): boolean {
  if (!piLink || !isPiAlive()) {
    return false;
  }
  udp.send(datagram, piLink.port, piLink.address, (error: Error | null) => {
    if (error) {
      console.error('[ERROR] UDP send failed:', error.message);
    }
  });
  return true;
}

function sendControlToPi(channels: ControlChannels): boolean {
  return sendToPi(buildControlDatagram(AUTH_KEY, nextSeq(), relayClockMs(), channels));
}

function toTelemetryMessage(packet: TelemetryPacket, rttMs: number | null): TelemetryMessage {
  const message: TelemetryMessage = {
    type: 'telemetry',
    timestamp: Date.now(),
    cpuTemp: packet.cpuTempC,
    rttMs,
    throttledFlags: packet.throttledFlags,
    arduino: {
      framesSinceBoot: packet.arduinoFrames,
      failsafeActive: packet.arduinoFailsafe,
      linkAgeMs: packet.arduinoLinkHeard ? packet.arduinoAgeMs : null,
    },
  };
  if (packet.wifiRssiDbm !== 0) {
    message.rssi = packet.wifiRssiDbm;
  }
  return message;
}

function handleUdpMessage(datagram: Buffer, remote: dgram.RemoteInfo): void {
  const telemetry = parseTelemetryDatagram(AUTH_KEY, datagram);
  if (telemetry === null) {
    return;
  }

  const rttMs = computeRttMs(relayClockMs(), telemetry.echoTsMs, telemetry.holdMs);
  const wasAlive = isPiAlive();

  if (!piLink || piLink.address !== remote.address || piLink.port !== remote.port) {
    console.log(`[INFO] Pi endpoint ${remote.address}:${remote.port}`);
  }
  piLink = {
    address: remote.address,
    port: remote.port,
    lastSeenAt: performance.now(),
    rttMs: rttMs ?? piLink?.rttMs ?? null,
  };

  if (!wasAlive) {
    console.log('[INFO] Pi link up');
    broadcastStatus();
  }

  broadcastToBrowsers(toTelemetryMessage(telemetry, rttMs));
}

udp.on('message', handleUdpMessage);

udp.on('error', (error: Error) => {
  console.error('[ERROR] UDP socket error:', error.message);
});

udp.bind(UDP_PORT, () => {
  console.log(`[INFO] Pi UDP link listening on port ${UDP_PORT}`);
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

// Keep RTT fresh and the relay -> Pi NAT mapping warm even when nobody drives.
const pingTimer = setInterval(() => {
  sendToPi(buildPingDatagram(AUTH_KEY, nextSeq(), relayClockMs()));
}, PING_INTERVAL_MS);

// Detect a silent Pi (power loss, link down) and tell the browsers.
const piLinkTimer = setInterval(() => {
  const alive = isPiAlive();
  if (alive !== lastReportedPiAlive) {
    console.log(alive ? '[INFO] Pi link up' : '[WARN] Pi link lost');
    broadcastStatus();
  }
}, PI_LINK_CHECK_INTERVAL_MS);

// Heartbeat to detect dead browser connections.
const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  clients.forEach((client, id) => {
    if (now - client.lastPing > HEARTBEAT_INTERVAL_MS * 2) {
      console.log(`[WARN] Client ${id} timed out, closing connection`);
      client.socket.terminate();
      clients.delete(id);
    } else if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.ping();
    }
  });
}, HEARTBEAT_INTERVAL_MS);

const statusTimer = setInterval(broadcastStatus, STATUS_BROADCAST_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

server.listen(WS_PORT, () => {
  console.log(`[INFO] FPV Control Relay running on port ${WS_PORT}`);
  console.log(`[INFO] Auth token: ${AUTH_TOKEN.substring(0, 4)}...`);
});

function shutdown(): void {
  console.log('[INFO] Shutting down...');

  clearInterval(pingTimer);
  clearInterval(piLinkTimer);
  clearInterval(heartbeatTimer);
  clearInterval(statusTimer);

  clients.forEach((client) => {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.close(1001, 'Server shutting down');
    }
  });

  udp.close();
  wss.close(() => {
    server.close(() => {
      console.log('[INFO] Server closed');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
