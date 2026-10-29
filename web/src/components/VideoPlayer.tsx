import { useRef, useEffect, useState, useCallback } from 'react';
import { useJanusStream } from '../hooks/useJanusStream';

interface VideoPlayerProps {
    janusServer: string;
    streamId: number;
    onConnectionChange?: (connected: boolean) => void;
}

/** Number of clockwise quarter turns applied to the video. */
type QuarterTurns = 0 | 1 | 2 | 3;

const ROTATION_STORAGE_KEY = 'fpv.videoRotation';

// Full class names must appear literally so Tailwind can detect them.
// For 90/270 degree rotations the element's box is swapped (container height
// x container width) so that, once rotated, it exactly fills the container
// and `object-contain` letterboxes correctly.
const ROTATION_CLASSES: Record<QuarterTurns, string> = {
    0: 'w-full h-full',
    1: 'w-[100cqh] h-[100cqw] rotate-90',
    2: 'w-full h-full rotate-180',
    3: 'w-[100cqh] h-[100cqw] -rotate-90'
};

function isQuarterTurns(value: number): value is QuarterTurns {
    return value === 0 || value === 1 || value === 2 || value === 3;
}

function loadStoredRotation(): QuarterTurns {
    try {
        const parsed = Number.parseInt(window.localStorage.getItem(ROTATION_STORAGE_KEY) ?? '', 10);
        return isQuarterTurns(parsed) ? parsed : 0;
    } catch {
        // localStorage can throw (privacy mode, disabled storage); default to upright.
        return 0;
    }
}

function storeRotation(rotation: QuarterTurns): void {
    try {
        window.localStorage.setItem(ROTATION_STORAGE_KEY, String(rotation));
    } catch {
        // Persistence is best-effort only.
    }
}

export function VideoPlayer({ janusServer, streamId, onConnectionChange }: VideoPlayerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [rotation, setRotation] = useState<QuarterTurns>(loadStoredRotation);
    // Start muted so autoplay always works. The user can unmute via the
    // speaker button after the stream starts (browsers block autoplay-with-
    // sound until a user gesture).
    const [muted, setMuted] = useState(true);
    const { connectionState, isPlaying, error, connect, disconnect } = useJanusStream({
        server: janusServer,
        streamId,
        videoRef
    });

    useEffect(() => {
        onConnectionChange?.(connectionState === 'connected' && isPlaying);
    }, [connectionState, isPlaying, onConnectionChange]);

    // Keep the <video> element's muted property in sync with our state. We
    // can't rely solely on the JSX `muted` prop because we mutate it after
    // the user clicks the speaker button.
    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.muted = muted;
        }
    }, [muted]);

    const toggleMuted = useCallback(() => {
        setMuted((prev) => {
            const next = !prev;
            const video = videoRef.current;
            if (video) {
                video.muted = next;
                if (!next) {
                    // Unmute is a user gesture; nudge play() in case the
                    // browser had paused it pending audio permission.
                    video.play().catch(() => {});
                }
            }
            return next;
        });
    }, []);

    const rotate = useCallback((direction: 1 | -1) => {
        setRotation((prev) => ((prev + direction + 4) % 4) as QuarterTurns);
    }, []);

    useEffect(() => {
        storeRotation(rotation);
    }, [rotation]);
    const rotateClockwise = useCallback(() => rotate(1), [rotate]);
    const rotateCounterClockwise = useCallback(() => rotate(-1), [rotate]);

    const isConnected = connectionState === 'connected';
    const isConnecting = connectionState === 'connecting';

    return (
        <div className="video-container video-rotation-container relative w-full h-full bg-black">
            {/* Video element (centered so rotation pivots around the middle) */}
            <video
                ref={videoRef}
                className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 object-contain ${ROTATION_CLASSES[rotation]}`}
                autoPlay
                playsInline
                muted
            />

            {/* Connection overlay */}
            {!isPlaying && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-fpv-dark/90">
                    {error ? (
                        <>
                            <div className="text-fpv-danger text-lg mb-4">{error}</div>
                            <button
                                onClick={connect}
                                className="px-6 py-2 bg-fpv-panel border border-fpv-accent text-fpv-accent 
                         hover:bg-fpv-accent hover:text-fpv-dark transition-colors font-mono"
                            >
                                RETRY CONNECTION
                            </button>
                        </>
                    ) : isConnecting ? (
                        <>
                            <div className="w-12 h-12 border-2 border-fpv-accent border-t-transparent rounded-full animate-spin mb-4" />
                            <div className="hud-text text-fpv-accent">ESTABLISHING LINK...</div>
                        </>
                    ) : (
                        <>
                            <div className="hud-text text-gray-400 mb-4">VIDEO FEED OFFLINE</div>
                            <button
                                onClick={connect}
                                className="px-6 py-2 bg-fpv-panel border border-fpv-accent text-fpv-accent 
                         hover:bg-fpv-accent hover:text-fpv-dark transition-colors font-mono"
                            >
                                CONNECT TO STREAM
                            </button>
                        </>
                    )}
                </div>
            )}

            {/* HUD overlay when playing */}
            {isPlaying && (
                <>
                    {/* Top left - status */}
                    <div className="absolute top-3 left-3 flex items-center gap-2">
                        <div className="status-dot connected" />
                        <span className="hud-text text-xs text-fpv-accent">LIVE</span>
                    </div>

                    {/* Top right - audio mute toggle + REC indicator */}
                    <div className="absolute top-3 right-3 flex items-center gap-3">
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={rotateCounterClockwise}
                                className="px-2 py-1 border border-fpv-border text-xs font-mono text-gray-400 hover:text-fpv-accent hover:border-fpv-accent transition-colors"
                                title="Rotate video 90° counter-clockwise"
                                aria-label="Rotate video 90 degrees counter-clockwise"
                            >
                                ↺
                            </button>
                            <button
                                type="button"
                                onClick={rotateClockwise}
                                className="px-2 py-1 border border-fpv-border text-xs font-mono text-gray-400 hover:text-fpv-accent hover:border-fpv-accent transition-colors"
                                title="Rotate video 90° clockwise"
                                aria-label="Rotate video 90 degrees clockwise"
                            >
                                ↻
                            </button>
                        </div>
                        <button
                            onClick={toggleMuted}
                            className={`flex items-center gap-1.5 px-2 py-1 border text-xs font-mono transition-colors ${
                                muted
                                    ? 'border-fpv-border text-gray-400 hover:text-fpv-accent hover:border-fpv-accent'
                                    : 'border-fpv-accent text-fpv-accent'
                            }`}
                            title={muted ? 'Unmute FPV audio' : 'Mute FPV audio'}
                        >
                            <span className="hud-text">{muted ? 'MUTED' : 'AUDIO ON'}</span>
                        </button>
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-fpv-danger animate-pulse" />
                            <span className="hud-text text-xs text-fpv-danger">REC</span>
                        </div>
                    </div>

                    {/* Center crosshair */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <svg width="40" height="40" viewBox="0 0 40 40" className="opacity-30">
                            <line x1="20" y1="0" x2="20" y2="15" stroke="#00ff88" strokeWidth="1" />
                            <line x1="20" y1="25" x2="20" y2="40" stroke="#00ff88" strokeWidth="1" />
                            <line x1="0" y1="20" x2="15" y2="20" stroke="#00ff88" strokeWidth="1" />
                            <line x1="25" y1="20" x2="40" y2="20" stroke="#00ff88" strokeWidth="1" />
                            <circle cx="20" cy="20" r="8" stroke="#00ff88" strokeWidth="1" fill="none" />
                        </svg>
                    </div>

                    {/* Bottom timestamp */}
                    <div className="absolute bottom-3 left-3">
                        <span className="hud-text text-xs text-gray-500">
                            {new Date().toLocaleTimeString()}
                        </span>
                    </div>

                    {/* Scanline effect */}
                    <div className="scanline-overlay opacity-20" />
                </>
            )}

            {/* Disconnect button when connected */}
            {isConnected && (
                <button
                    onClick={disconnect}
                    className="absolute bottom-3 right-3 px-3 py-1 bg-fpv-panel/80 border border-fpv-border 
                   text-gray-400 hover:text-fpv-danger hover:border-fpv-danger 
                   transition-colors text-xs font-mono"
                >
                    DISCONNECT
                </button>
            )}
        </div>
    );
}

