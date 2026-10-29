import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionState } from '../types';

// --- Janus AudioBridge surface types -------------------------------------
// We declare a slightly richer plugin handle here than the one in
// useJanusStream.ts because AudioBridge needs createOffer + handleRemoteJsep
// (the streaming plugin only needs createAnswer). Both files end up calling
// into the same window.Janus global at runtime; the type duplication is
// purely so each hook can describe what it actually uses.

interface AudioBridgeStatic {
    init: (options: { debug: string | boolean; callback: () => void }) => void;
    isWebrtcSupported: () => boolean;
}

interface AudioBridgeSession {
    destroy: (options?: { success?: () => void; error?: (error: string) => void }) => void;
    attach: (options: {
        plugin: string;
        opaqueId?: string;
        success: (handle: AudioBridgePluginHandle) => void;
        error: (error: string) => void;
        onmessage: (msg: AudioBridgeMessage, jsep?: RTCSessionDescriptionInit) => void;
        oncleanup: () => void;
    }) => void;
}

interface AudioBridgePluginHandle {
    send: (params: { message: Record<string, unknown>; jsep?: RTCSessionDescriptionInit }) => void;
    createOffer: (params: {
        media: { video: boolean; audioSend: boolean; audioRecv: boolean };
        success: (jsep: RTCSessionDescriptionInit) => void;
        error: (error: string) => void;
    }) => void;
    handleRemoteJsep: (params: { jsep: RTCSessionDescriptionInit }) => void;
    detach: (options?: { success?: () => void; error?: (error: string) => void }) => void;
    hangup: () => void;
}

interface AudioBridgeMessage {
    audiobridge?: string;
    error?: string;
    error_code?: number;
    room?: number;
    id?: number;
    participants?: unknown[];
}

interface JanusGlobalCtor {
    new (options: {
        server: string;
        success: () => void;
        error: (error: string) => void;
        destroyed: () => void;
    }): AudioBridgeSession;
}

type JanusGlobal = AudioBridgeStatic & JanusGlobalCtor;

interface UseAudioBridgeOptions {
    server: string;
    room: number;
    enabled: boolean;
}

interface UseAudioBridgeReturn {
    connectionState: ConnectionState;
    joined: boolean;
    muted: boolean;
    error: string | null;
    setMuted: (muted: boolean) => void;
}

// Tracks how many useAudioBridge instances have init'd Janus already, so we
// don't double-init across hot reloads.
let janusInited = false;

/**
 * Joins a Janus AudioBridge room as a publisher with the local mic. Starts
 * muted; flip with setMuted(false) for push-to-talk. Audio leaves the
 * browser via WebRTC, gets mixed by AudioBridge, and is forwarded as RTP
 * to the Pi by the audiobridge-bootstrap sidecar.
 */
export function useAudioBridge({
    server,
    room,
    enabled
}: UseAudioBridgeOptions): UseAudioBridgeReturn {
    const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
    const [joined, setJoined] = useState(false);
    const [muted, setMutedState] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const sessionRef = useRef<AudioBridgeSession | null>(null);
    const handleRef = useRef<AudioBridgePluginHandle | null>(null);

    const cleanup = useCallback(() => {
        if (handleRef.current) {
            try { handleRef.current.hangup(); } catch { /* already gone */ }
            try { handleRef.current.detach(); } catch { /* already gone */ }
            handleRef.current = null;
        }
        if (sessionRef.current) {
            try { sessionRef.current.destroy(); } catch { /* already gone */ }
            sessionRef.current = null;
        }
        setJoined(false);
    }, []);

    // Janus.js owns the local MediaStream internally (it called
    // getUserMedia inside createOffer). The proper way to mute is the
    // AudioBridge plugin's `configure` request: when muted=true the server
    // stops mixing our slot, so the Pi hears nothing. Cheap, no extra
    // browser-side bookkeeping needed.
    const setMuted = useCallback((next: boolean) => {
        setMutedState(next);
        if (handleRef.current) {
            handleRef.current.send({
                message: { request: 'configure', muted: next }
            });
        }
    }, []);

    useEffect(() => {
        if (!enabled) {
            cleanup();
            setConnectionState('disconnected');
            return;
        }

        const Janus = (window as unknown as { Janus?: JanusGlobal }).Janus;
        if (!Janus) {
            setError('Janus library not loaded');
            setConnectionState('error');
            return;
        }

        let cancelled = false;

        const startSession = () => {
            if (cancelled) return;
            setConnectionState('connecting');
            setError(null);

            const session = new Janus({
                server,
                success: () => {
                    if (cancelled) {
                        try { session.destroy(); } catch { /* ignore */ }
                        return;
                    }
                    sessionRef.current = session;

                    session.attach({
                        plugin: 'janus.plugin.audiobridge',
                        opaqueId: `fpv-audiobridge-${Date.now()}`,
                        success: (handle) => {
                            if (cancelled) {
                                try { handle.detach(); } catch { /* ignore */ }
                                return;
                            }
                            handleRef.current = handle;

                            // Join the room muted; we'll let setMuted(false)
                            // unmute on push-to-talk press. `display` is
                            // visible to other participants, but we're the
                            // only browser participant in this design.
                            handle.send({
                                message: {
                                    request: 'join',
                                    room,
                                    display: 'fpv-driver',
                                    muted: true
                                }
                            });
                        },
                        error: (err) => {
                            console.error('[AudioBridge] attach error:', err);
                            setError(`AudioBridge attach: ${err}`);
                            setConnectionState('error');
                        },
                        onmessage: (msg, jsep) => {
                            const event = msg.audiobridge;
                            if (msg.error) {
                                console.error('[AudioBridge] error:', msg.error);
                                setError(msg.error);
                                setConnectionState('error');
                                return;
                            }

                            if (event === 'joined') {
                                console.log('[AudioBridge] Joined room', msg.room, 'as id', msg.id);
                                // Now publish our mic. createOffer asks the
                                // browser for a sendonly audio peer so we
                                // never receive remote audio (we don't need
                                // to hear ourselves; the FPV mic comes back
                                // through the streaming plugin).
                                if (!handleRef.current) return;
                                handleRef.current.createOffer({
                                    media: { video: false, audioSend: true, audioRecv: false },
                                    success: (offerJsep) => {
                                        handleRef.current?.send({
                                            message: { request: 'configure', muted: true },
                                            jsep: offerJsep
                                        });
                                    },
                                    error: (err) => {
                                        console.error('[AudioBridge] createOffer error:', err);
                                        setError(`Mic offer: ${err}`);
                                        setConnectionState('error');
                                    }
                                });
                            }

                            if (jsep && handleRef.current) {
                                handleRef.current.handleRemoteJsep({ jsep });
                                setJoined(true);
                                setConnectionState('connected');
                            }
                        },
                        oncleanup: () => {
                            console.log('[AudioBridge] cleanup');
                            setJoined(false);
                        }
                    });
                },
                error: (err) => {
                    console.error('[AudioBridge] session error:', err);
                    setError(`Janus session: ${err}`);
                    setConnectionState('error');
                },
                destroyed: () => {
                    setConnectionState('disconnected');
                    setJoined(false);
                }
            });
        };

        if (!janusInited) {
            Janus.init({
                debug: 'warn',
                callback: () => {
                    janusInited = true;
                    if (!Janus.isWebrtcSupported()) {
                        setError('WebRTC not supported');
                        setConnectionState('error');
                        return;
                    }
                    startSession();
                }
            });
        } else {
            startSession();
        }

        return () => {
            cancelled = true;
            cleanup();
        };
    }, [enabled, server, room, cleanup]);

    return {
        connectionState,
        joined,
        muted,
        error,
        setMuted
    };
}
