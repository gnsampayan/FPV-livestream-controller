import { useState, useEffect, useRef, useCallback } from 'react';
import type { ConnectionState } from '../types';

// Janus types (simplified for our use case)
interface JanusStatic {
  init: (options: { debug: string | boolean; callback: () => void }) => void;
  isWebrtcSupported: () => boolean;
  attachMediaStream: (element: HTMLVideoElement, stream: MediaStream) => void;
}

interface JanusSession {
  destroy: (options?: { success?: () => void; error?: (error: string) => void }) => void;
  attach: (options: {
    plugin: string;
    opaqueId?: string;
    success: (pluginHandle: JanusPluginHandle) => void;
    error: (error: string) => void;
    onmessage: (msg: JanusMessage, jsep?: RTCSessionDescriptionInit) => void;
    onremotetrack: (track: MediaStreamTrack, mid: string, on: boolean) => void;
    oncleanup: () => void;
  }) => void;
}

interface JanusPluginHandle {
  send: (params: { message: Record<string, unknown>; jsep?: RTCSessionDescriptionInit }) => void;
  createAnswer: (params: {
    jsep: RTCSessionDescriptionInit;
    media: { audioSend: boolean; videoSend: boolean };
    success: (jsep: RTCSessionDescriptionInit) => void;
    error: (error: string) => void;
  }) => void;
  detach: (options?: { success?: () => void; error?: (error: string) => void }) => void;
}

interface JanusMessage {
  streaming?: string;
  result?: {
    status?: string;
  };
  error?: string;
}

// Declare Janus as a global
declare global {
  interface Window {
    Janus: JanusStatic & {
      new (options: {
        server: string;
        success: () => void;
        error: (error: string) => void;
        destroyed: () => void;
      }): JanusSession;
    };
  }
}

interface UseJanusStreamOptions {
  server: string;
  streamId: number;
  videoRef: { current: HTMLVideoElement | null };
}

interface UseJanusStreamReturn {
  connectionState: ConnectionState;
  isPlaying: boolean;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
}

export function useJanusStream({
  server,
  streamId,
  videoRef
}: UseJanusStreamOptions): UseJanusStreamReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const janusRef = useRef<JanusSession | null>(null);
  const pluginRef = useRef<JanusPluginHandle | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const initedRef = useRef(false);

  const cleanup = useCallback(() => {
    if (pluginRef.current) {
      pluginRef.current.detach();
      pluginRef.current = null;
    }
    if (janusRef.current) {
      janusRef.current.destroy();
      janusRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsPlaying(false);
  }, [videoRef]);

  const connect = useCallback(() => {
    if (!window.Janus) {
      setError('Janus library not loaded');
      setConnectionState('error');
      return;
    }

    // Avoid spawning a second Janus session if one is already being set up
    // or in use (prevents duplicate WS handshakes to /janus on re-renders).
    if (janusRef.current) {
      return;
    }

    setConnectionState('connecting');
    setError(null);

    // Initialize Janus if not already done
    const initAndConnect = () => {
      const janus = new window.Janus({
        server,
        success: () => {
          console.log('[Janus] Connected to server');
          janusRef.current = janus;

          // Attach to streaming plugin
          janus.attach({
            plugin: 'janus.plugin.streaming',
            opaqueId: `fpvstream-${Date.now()}`,
            success: (pluginHandle) => {
              console.log('[Janus] Attached to streaming plugin');
              pluginRef.current = pluginHandle;

              // Request the stream
              pluginHandle.send({
                message: {
                  request: 'watch',
                  id: streamId
                }
              });
            },
            error: (err) => {
              console.error('[Janus] Plugin attach error:', err);
              setError(`Plugin error: ${err}`);
              setConnectionState('error');
            },
            onmessage: (msg, jsep) => {
              console.log('[Janus] Message:', msg);

              if (msg.error) {
                setError(msg.error);
                setConnectionState('error');
                return;
              }

              if (msg.result?.status === 'starting') {
                console.log('[Janus] Stream starting...');
              }

              // Handle offer from Janus
              if (jsep && pluginRef.current) {
                pluginRef.current.createAnswer({
                  jsep,
                  media: { audioSend: false, videoSend: false },
                  success: (answerJsep: RTCSessionDescriptionInit) => {
                    pluginRef.current?.send({
                      message: { request: 'start' },
                      jsep: answerJsep
                    });
                    setConnectionState('connected');
                  },
                  error: (err: string) => {
                    console.error('[Janus] createAnswer error:', err);
                    setError(`WebRTC error: ${err}`);
                    setConnectionState('error');
                  }
                });
              }
            },
            onremotetrack: (track: MediaStreamTrack, mid: string, on: boolean) => {
              console.log('[Janus] Remote track:', track.kind, mid, on);

              if (!on) {
                return;
              }

              // Attach BOTH video and audio tracks to the same MediaStream so
              // the <video> element plays them in sync. The Pi pushes Opus
              // audio to a separate RTP port (5006) but Janus bundles both
              // into one PeerConnection on subscribe.
              if (track.kind !== 'video' && track.kind !== 'audio') {
                return;
              }

              if (!streamRef.current) {
                streamRef.current = new MediaStream();
              }
              streamRef.current.addTrack(track);

              if (videoRef.current) {
                videoRef.current.srcObject = streamRef.current;
                videoRef.current.play().then(() => {
                  setIsPlaying(true);
                  console.log('[Janus] Playback started, kind=', track.kind);
                }).catch((e: Error) => {
                  // Autoplay-with-sound is blocked by some browsers until a
                  // user gesture. The VideoPlayer mute toggle handles this.
                  console.error('[Janus] play() error:', e);
                });
              }
            },
            oncleanup: () => {
              console.log('[Janus] Cleanup');
              streamRef.current = null;
              setIsPlaying(false);
            }
          });
        },
        error: (err) => {
          console.error('[Janus] Connection error:', err);
          setError(`Connection error: ${err}`);
          setConnectionState('error');
        },
        destroyed: () => {
          console.log('[Janus] Session destroyed');
          setConnectionState('disconnected');
          setIsPlaying(false);
        }
      });
    };

    if (!initedRef.current) {
      window.Janus.init({
        debug: 'all',
        callback: () => {
          initedRef.current = true;
          if (window.Janus.isWebrtcSupported()) {
            initAndConnect();
          } else {
            setError('WebRTC not supported');
            setConnectionState('error');
          }
        }
      });
    } else {
      initAndConnect();
    }
  }, [server, streamId, videoRef]);

  const disconnect = useCallback(() => {
    cleanup();
    setConnectionState('disconnected');
  }, [cleanup]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    connectionState,
    isPlaying,
    error,
    connect,
    disconnect
  };
}

