import { useState, useEffect, useRef, useCallback } from 'react';
import type { 
  ControlCommand, 
  AuthMessage, 
  ServerMessage, 
  StatusMessage, 
  TelemetryMessage,
  ConnectionState 
} from '../types';

interface UseControlSocketOptions {
  url: string;
  token: string;
  onStatus?: (status: StatusMessage) => void;
  onTelemetry?: (telemetry: TelemetryMessage) => void;
  onError?: (error: string) => void;
}

interface UseControlSocketReturn {
  connectionState: ConnectionState;
  piConnected: boolean;
  browserClients: number;
  sendControl: (
    steer: number,
    throttle: number,
    brake?: number,
    camYaw?: number,
    camPitch?: number
  ) => void;
  connect: () => void;
  disconnect: () => void;
}

export function useControlSocket({
  url,
  token,
  onStatus,
  onTelemetry,
  onError
}: UseControlSocketOptions): UseControlSocketReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [piConnected, setPiConnected] = useState(false);
  const [browserClients, setBrowserClients] = useState(0);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    clearReconnectTimeout();
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
    reconnectAttempts.current++;
    
    reconnectTimeoutRef.current = window.setTimeout(() => {
      if (connectionState !== 'connected') {
        connect();
      }
    }, delay);
  }, [connectionState, clearReconnectTimeout]);

  const connect = useCallback(() => {
    // Bail if we already have an OPEN or CONNECTING socket. Without the
    // CONNECTING check a second connect() call during the handshake would
    // open a duplicate socket, overwrite wsRef.current, and leave the first
    // one to die with code 1006 (which is what produces the "first attempt
    // fails, retry succeeds" symptom we were seeing in the UI).
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setConnectionState('connecting');
    
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Control] WebSocket connected');
        reconnectAttempts.current = 0;
        
        // Send authentication
        const authMsg: AuthMessage = {
          type: 'auth',
          token,
          clientType: 'browser'
        };
        ws.send(JSON.stringify(authMsg));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          
          switch (msg.type) {
            case 'auth_success':
              setConnectionState('connected');
              console.log('[Control] Authenticated');
              break;
              
            case 'status':
              setPiConnected(msg.piConnected);
              setBrowserClients(msg.browserClients);
              onStatus?.(msg);
              break;
              
            case 'telemetry':
              onTelemetry?.(msg);
              break;
              
            case 'error':
              console.error('[Control] Server error:', msg.message);
              onError?.(msg.message);
              break;
          }
        } catch (e) {
          console.error('[Control] Failed to parse message:', e);
        }
      };

      ws.onerror = (error) => {
        console.error('[Control] WebSocket error:', error);
        setConnectionState('error');
      };

      ws.onclose = (event) => {
        console.log('[Control] WebSocket closed:', event.code, event.reason);
        setConnectionState('disconnected');
        setPiConnected(false);
        wsRef.current = null;
        
        // Auto-reconnect unless intentionally closed
        if (event.code !== 1000) {
          scheduleReconnect();
        }
      };
    } catch (error) {
      console.error('[Control] Failed to connect:', error);
      setConnectionState('error');
      scheduleReconnect();
    }
  }, [url, token, onStatus, onTelemetry, onError, scheduleReconnect]);

  const disconnect = useCallback(() => {
    clearReconnectTimeout();
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnect');
      wsRef.current = null;
    }
    setConnectionState('disconnected');
  }, [clearReconnectTimeout]);

  const sendControl = useCallback((
    steer: number,
    throttle: number,
    brake?: number,
    camYaw?: number,
    camPitch?: number
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    const command: ControlCommand = {
      type: 'control',
      timestamp: Date.now(),
      steer: Math.max(-1, Math.min(1, steer)),
      throttle: Math.max(0, Math.min(1, throttle)),
      brake: brake !== undefined ? Math.max(0, Math.min(1, brake)) : undefined,
      camYaw: camYaw !== undefined ? Math.max(-1, Math.min(1, camYaw)) : undefined,
      camPitch: camPitch !== undefined ? Math.max(-1, Math.min(1, camPitch)) : undefined,
    };

    wsRef.current.send(JSON.stringify(command));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearReconnectTimeout();
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmount');
      }
    };
  }, [clearReconnectTimeout]);

  return {
    connectionState,
    piConnected,
    browserClients,
    sendControl,
    connect,
    disconnect
  };
}

