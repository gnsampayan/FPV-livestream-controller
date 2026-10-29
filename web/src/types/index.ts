// Control command sent to the Pi
export interface ControlCommand {
  type: 'control';
  timestamp: number;
  steer: number;     // -1 (full left) to 1 (full right)
  throttle: number;  //  0 (stop) to 1 (full forward)
  brake?: number;    //  0 to 1 (optional)
  camYaw?: number;   // -1 (full left)  to 1 (full right)
  camPitch?: number; // -1 (full down)  to 1 (full up)
}

// Arduino link health published by the Pi daemon in telemetry
export interface ArduinoLink {
  framesSinceBoot: number;
  failsafeActive: boolean;
  linkAgeMs: number | null;
}

// Authentication message
export interface AuthMessage {
  type: 'auth';
  token: string;
  clientType: 'browser' | 'pi';
}

// Status update from server
export interface StatusMessage {
  type: 'status';
  piConnected: boolean;
  browserClients: number;
  latency?: number;
}

// Telemetry from Pi
export interface TelemetryMessage {
  type: 'telemetry';
  timestamp: number;
  cpuTemp?: number;
  battery?: number;
  rssi?: number;
  arduino?: ArduinoLink;
}

// Error message
export interface ErrorMessage {
  type: 'error';
  message: string;
}

// Auth success message
export interface AuthSuccessMessage {
  type: 'auth_success';
}

// Union type for all incoming messages
export type ServerMessage = StatusMessage | TelemetryMessage | ErrorMessage | AuthSuccessMessage;

// Connection state
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// Janus session types
export interface JanusSession {
  destroy: () => void;
  attach: (options: JanusPluginOptions) => void;
}

export interface JanusPluginOptions {
  plugin: string;
  opaqueId?: string;
  success: (pluginHandle: JanusPluginHandle) => void;
  error: (error: string) => void;
  onmessage: (msg: JanusMessage, jsep?: RTCSessionDescriptionInit) => void;
  onremotetrack: (track: MediaStreamTrack, mid: string, on: boolean) => void;
  oncleanup: () => void;
}

export interface JanusPluginHandle {
  send: (params: { message: Record<string, unknown>; jsep?: RTCSessionDescriptionInit }) => void;
  createAnswer: (params: {
    jsep: RTCSessionDescriptionInit;
    media: { audioSend: boolean; videoSend: boolean };
    success: (jsep: RTCSessionDescriptionInit) => void;
    error: (error: string) => void;
  }) => void;
  detach: () => void;
}

export interface JanusMessage {
  streaming?: string;
  result?: {
    status?: string;
  };
  error?: string;
}

