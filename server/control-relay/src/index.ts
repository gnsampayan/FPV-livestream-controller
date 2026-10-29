import { WebSocketServer, WebSocket, RawData } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import http from 'http';

// Configuration
const PORT = parseInt(process.env.PORT || '3001', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';
const PI_RECONNECT_INTERVAL = parseInt(process.env.PI_RECONNECT_INTERVAL || '5000', 10);
const HEARTBEAT_INTERVAL = 30000;

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
  clientType: 'browser' | 'pi';
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
  cpuTemp?: number;
  battery?: number;
  rssi?: number;
  arduino?: ArduinoLink;
}

type IncomingMessage = AuthMessage | ControlCommand | TelemetryMessage;
type OutgoingMessage = StatusMessage | ControlCommand | TelemetryMessage | { type: 'error'; message: string } | { type: 'auth_success' };

interface Client {
  id: string;
  socket: WebSocket;
  authenticated: boolean;
  clientType: 'browser' | 'pi' | null;
  lastPing: number;
}

// State
const clients = new Map<string, Client>();
let piClient: Client | null = null;

// Create HTTP server
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      piConnected: piClient !== null,
      browserClients: getBrowserClientCount()
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// Create WebSocket server
const wss = new WebSocketServer({ server, path: '/' });

function getBrowserClientCount(): number {
  let count = 0;
  clients.forEach(client => {
    if (client.authenticated && client.clientType === 'browser') {
      count++;
    }
  });
  return count;
}

function broadcastToBrowsers(message: OutgoingMessage): void {
  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.authenticated && client.clientType === 'browser' && client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(data);
    }
  });
}

function broadcastStatus(): void {
  const status: StatusMessage = {
    type: 'status',
    piConnected: piClient !== null && piClient.socket.readyState === WebSocket.OPEN,
    browserClients: getBrowserClientCount()
  };
  broadcastToBrowsers(status);
  
  // Also send to Pi if connected
  if (piClient && piClient.socket.readyState === WebSocket.OPEN) {
    piClient.socket.send(JSON.stringify(status));
  }
}

function handleMessage(client: Client, data: RawData): void {
  let message: IncomingMessage;
  
  try {
    message = JSON.parse(data.toString()) as IncomingMessage;
  } catch {
    sendError(client, 'Invalid JSON');
    return;
  }

  // Handle authentication
  if (message.type === 'auth') {
    handleAuth(client, message as AuthMessage);
    return;
  }

  // All other messages require authentication
  if (!client.authenticated) {
    sendError(client, 'Not authenticated');
    return;
  }

  // Handle control commands from browser
  if (message.type === 'control' && client.clientType === 'browser') {
    handleControlCommand(client, message as ControlCommand);
    return;
  }

  // Handle telemetry from Pi
  if (message.type === 'telemetry' && client.clientType === 'pi') {
    handleTelemetry(message as TelemetryMessage);
    return;
  }
}

function handleAuth(client: Client, message: AuthMessage): void {
  if (message.token !== AUTH_TOKEN) {
    sendError(client, 'Invalid authentication token');
    client.socket.close(4001, 'Unauthorized');
    return;
  }

  client.authenticated = true;
  client.clientType = message.clientType;

  if (message.clientType === 'pi') {
    // Only one Pi connection allowed
    if (piClient && piClient.id !== client.id) {
      console.log(`[WARN] New Pi connection replacing existing: ${piClient.id}`);
      piClient.socket.close(4002, 'Replaced by new connection');
    }
    piClient = client;
    console.log(`[INFO] Pi connected: ${client.id}`);
  } else {
    console.log(`[INFO] Browser connected: ${client.id}`);
  }

  // Send auth success
  const response: OutgoingMessage = { type: 'auth_success' };
  client.socket.send(JSON.stringify(response));

  // Broadcast updated status
  broadcastStatus();
}

function handleControlCommand(client: Client, command: ControlCommand): void {
  // Clamp every axis. Using ?? (not ||) so a legitimate 0 is preserved.
  const steer    = Math.max(-1, Math.min(1, command.steer    ?? 0));
  const throttle = Math.max( 0, Math.min(1, command.throttle ?? 0));
  const brake    = Math.max( 0, Math.min(1, command.brake    ?? 0));
  const camYaw   = Math.max(-1, Math.min(1, command.camYaw   ?? 0));
  const camPitch = Math.max(-1, Math.min(1, command.camPitch ?? 0));

  const validatedCommand: ControlCommand = {
    type: 'control',
    timestamp: Date.now(),
    steer,
    throttle,
    brake,
    camYaw,
    camPitch,
  };

  // Forward to Pi if connected
  if (piClient && piClient.socket.readyState === WebSocket.OPEN) {
    piClient.socket.send(JSON.stringify(validatedCommand));
  } else {
    // Pi not connected - inform browser
    sendError(client, 'Pi not connected');
  }
}

function handleTelemetry(telemetry: TelemetryMessage): void {
  // Forward telemetry to all browser clients
  broadcastToBrowsers(telemetry);
}

function sendError(client: Client, message: string): void {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify({ type: 'error', message }));
  }
}

// WebSocket connection handler
wss.on('connection', (socket: WebSocket, request: http.IncomingMessage) => {
  const clientId = uuidv4();
  const client: Client = {
    id: clientId,
    socket,
    authenticated: false,
    clientType: null,
    lastPing: Date.now()
  };

  clients.set(clientId, client);
  console.log(`[INFO] Client connected: ${clientId} from ${request.socket.remoteAddress}`);

  // Set up ping/pong for connection health
  socket.on('pong', () => {
    client.lastPing = Date.now();
  });

  socket.on('message', (data: RawData) => {
    handleMessage(client, data);
  });

  socket.on('close', (code: number, reason: Buffer) => {
    console.log(`[INFO] Client disconnected: ${clientId} (code: ${code}, reason: ${reason.toString()})`);
    
    if (piClient && piClient.id === clientId) {
      piClient = null;
      console.log('[WARN] Pi disconnected');
      broadcastStatus();
    }
    
    clients.delete(clientId);
    broadcastStatus();
  });

  socket.on('error', (error: Error) => {
    console.error(`[ERROR] WebSocket error for ${clientId}:`, error.message);
  });

  // Send initial status after short delay (to allow auth)
  setTimeout(() => {
    if (client.authenticated) {
      broadcastStatus();
    }
  }, 100);
});

// Heartbeat interval to detect dead connections
setInterval(() => {
  const now = Date.now();
  clients.forEach((client, id) => {
    if (now - client.lastPing > HEARTBEAT_INTERVAL * 2) {
      console.log(`[WARN] Client ${id} timed out, closing connection`);
      client.socket.terminate();
      clients.delete(id);
      if (piClient && piClient.id === id) {
        piClient = null;
        broadcastStatus();
      }
    } else if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.ping();
    }
  });
}, HEARTBEAT_INTERVAL);

// Status broadcast interval
setInterval(() => {
  broadcastStatus();
}, 5000);

// Start server
server.listen(PORT, () => {
  console.log(`[INFO] FPV Control Relay running on port ${PORT}`);
  console.log(`[INFO] Auth token: ${AUTH_TOKEN.substring(0, 4)}...`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[INFO] SIGTERM received, shutting down...');
  
  // Notify all clients
  clients.forEach(client => {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.close(1001, 'Server shutting down');
    }
  });
  
  wss.close(() => {
    server.close(() => {
      console.log('[INFO] Server closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  process.emit('SIGTERM', 'SIGTERM');
});

