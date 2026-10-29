import { useState, useEffect, useCallback, useRef } from 'react';
import { VideoPlayer } from './components/VideoPlayer';
import { DualJoystickController } from './components/VirtualJoystick';
import { StatusPanel } from './components/StatusPanel';
import { ControlDisplay } from './components/ControlDisplay';
import { MicButton } from './components/MicButton';
import { useControlSocket } from './hooks/useControlSocket';
import { useKeyboardControls } from './hooks/useKeyboardControls';
import { useGamepad } from './hooks/useGamepad';
import { useAudioBridge } from './hooks/useAudioBridge';
import type { TelemetryMessage, StatusMessage } from './types';

type InputSource = 'gamepad' | 'keyboard' | 'joystick' | 'none';

// Build WebSocket URLs from the page's own origin so the same build works
// behind nginx regardless of hostname (LAN IP, Tailscale IP, real domain).
// Paths match the reverse-proxy locations in
// server/nginx/templates/default.conf.template.
const wsProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsHost = typeof window !== 'undefined' ? window.location.host : 'localhost';

const CONFIG = {
    janusServer: `${wsProtocol}//${wsHost}/janus`,
    controlServer: `${wsProtocol}//${wsHost}/ws/control`,
    streamId: 1,
    // AudioBridge room id used for browser-to-Pi push-to-talk. Must match
    // server/janus/janus.plugin.audiobridge.jcfg and the AUDIOBRIDGE_ROOM
    // env on the audiobridge-bootstrap sidecar.
    audioBridgeRoom: 1234,
    // Baked in at build time from VITE_AUTH_TOKEN. Must match
    // CONTROL_AUTH_TOKEN in server/.env. Browser-visible in DevTools; this is
    // a shared secret, not a per-user credential.
    authToken: import.meta.env.VITE_AUTH_TOKEN ?? 'changeme',
    controlRate: 50, // Hz - how often to send control updates
};

function App() {
    const [telemetry, setTelemetry] = useState<TelemetryMessage | undefined>();
    const [videoConnected, setVideoConnected] = useState(false);
    const [tabVisible, setTabVisible] = useState(true);
    const [joystickInput, setJoystickInput] = useState({
        steer: 0,
        throttle: 0,
        camYaw: 0,
        camPitch: 0,
    });
    const [liveControl, setLiveControl] = useState({
        steer: 0,
        throttle: 0,
        brake: 0,
        camYaw: 0,
        camPitch: 0,
        source: 'none' as InputSource,
    });

    const lastControlTime = useRef(0);

    // Input sources. All are disabled when the tab isn't visible (safety).
    const keyboard = useKeyboardControls(tabVisible);
    const gamepad = useGamepad(tabVisible);

    // Stable callbacks so useControlSocket's internal useCallback doesn't
    // change identity on every App render (which would refire the
    // auto-connect effect below and open duplicate WebSockets).
    const onControlStatus = useCallback((status: StatusMessage) => {
        console.log('[App] Status update:', status);
    }, []);
    const onControlError = useCallback((error: string) => {
        console.error('[App] Control error:', error);
    }, []);

    const {
        connectionState: controlState,
        piConnected,
        browserClients,
        sendControl,
        connect: connectControl
    } = useControlSocket({
        url: CONFIG.controlServer,
        token: CONFIG.authToken,
        onTelemetry: setTelemetry,
        onStatus: onControlStatus,
        onError: onControlError,
    });

    // Browser -> Pi push-to-talk audio. We only spin up the AudioBridge
    // session once the Pi is reachable so we don't waste a Janus session
    // (and a getUserMedia prompt) when there's nothing on the other end.
    const audioBridge = useAudioBridge({
        server: CONFIG.janusServer,
        room: CONFIG.audioBridgeRoom,
        enabled: controlState === 'connected' && piConnected
    });

    // Handle joystick input (left stick = drive, right stick = camera)
    const handleJoystickControl = useCallback(
        (steer: number, throttle: number, camYaw: number, camPitch: number) => {
            setJoystickInput({ steer, throttle, camYaw, camPitch });
        },
        []
    );

    // Merge gamepad + keyboard + virtual joystick into a single 5-axis command
    // and send at a fixed rate.
    useEffect(() => {
        const interval = setInterval(() => {
            const now = Date.now();
            if (now - lastControlTime.current < (1000 / CONFIG.controlRate)) {
                return;
            }

            // Drive axes: prefer whichever source is currently active, highest priority first.
            let steer: number;
            let throttle: number;
            let brake: number;
            let driveSource: InputSource;
            if (gamepad.isActive) {
                steer = gamepad.steer;
                throttle = gamepad.throttle;
                brake = gamepad.brake;
                driveSource = 'gamepad';
            } else if (keyboard.isActive) {
                steer = keyboard.steer;
                throttle = keyboard.throttle;
                brake = keyboard.brake;
                driveSource = 'keyboard';
            } else if (joystickInput.steer !== 0 || joystickInput.throttle !== 0) {
                steer = joystickInput.steer;
                throttle = joystickInput.throttle;
                brake = 0;
                driveSource = 'joystick';
            } else {
                steer = 0;
                throttle = 0;
                brake = 0;
                driveSource = 'none';
            }

            // Camera axes are independent: gamepad right stick, else keyboard arrows,
            // else the virtual camera joystick.
            let camYaw: number;
            let camPitch: number;
            if (gamepad.camYaw !== 0 || gamepad.camPitch !== 0) {
                camYaw = gamepad.camYaw;
                camPitch = gamepad.camPitch;
            } else if (keyboard.camYaw !== 0 || keyboard.camPitch !== 0) {
                camYaw = keyboard.camYaw;
                camPitch = keyboard.camPitch;
            } else {
                camYaw = joystickInput.camYaw;
                camPitch = joystickInput.camPitch;
            }

            const anyInput =
                steer !== 0 || throttle !== 0 || brake !== 0 ||
                camYaw !== 0 || camPitch !== 0;
            const anyActive = gamepad.isActive || keyboard.isActive || anyInput;

            if (anyActive) {
                sendControl(steer, throttle, brake, camYaw, camPitch);
                lastControlTime.current = now;
            }

            setLiveControl((prev) => {
                if (
                    prev.steer === steer &&
                    prev.throttle === throttle &&
                    prev.brake === brake &&
                    prev.camYaw === camYaw &&
                    prev.camPitch === camPitch &&
                    prev.source === driveSource
                ) {
                    return prev;
                }
                return { steer, throttle, brake, camYaw, camPitch, source: driveSource };
            });
        }, 1000 / CONFIG.controlRate);

        return () => clearInterval(interval);
    }, [keyboard, gamepad, joystickInput, sendControl]);

    // Handle tab visibility (safety feature)
    useEffect(() => {
        const handleVisibilityChange = () => {
            const visible = document.visibilityState === 'visible';
            setTabVisible(visible);

            if (!visible) {
                // Tab hidden - send a full neutral command (drive + camera).
                sendControl(0, 0, 0, 0, 0);
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [sendControl]);

    // Auto-connect on mount
    useEffect(() => {
        connectControl();
    }, [connectControl]);

    // Values the HUD should display - mirror what we last sent to the server.
    const currentSteer = liveControl.steer;
    const currentThrottle = liveControl.throttle;
    const currentBrake = liveControl.brake;
    const currentCamYaw = liveControl.camYaw;
    const currentCamPitch = liveControl.camPitch;
    const inputSource = liveControl.source;

    const isControlReady = controlState === 'connected' && piConnected;

    return (
        <div className="w-full h-full bg-fpv-dark flex flex-col">
            {/* Header */}
            <header className="flex-shrink-0 px-4 py-2 border-b border-fpv-border bg-fpv-panel">
                <div className="flex items-center justify-between">
                    <h1 className="hud-text text-lg text-fpv-accent tracking-wider">
                        FPV CONTROL CENTER
                    </h1>

                    <div className="flex items-center gap-4">
                        {/* Warning when tab not visible */}
                        {!tabVisible && (
                            <div className="flex items-center gap-2 px-3 py-1 bg-fpv-danger/20 border border-fpv-danger rounded">
                                <span className="text-fpv-danger text-xs">TAB INACTIVE - CONTROLS DISABLED</span>
                            </div>
                        )}

                        {/* Quick status */}
                        <div className="flex items-center gap-3 text-xs">
                            <div className="flex items-center gap-1.5">
                                <span className="text-gray-500">CTRL</span>
                                <div className={`status-dot ${controlState === 'connected' ? 'connected' : 'disconnected'}`} />
                            </div>
                            <div className="flex items-center gap-1.5">
                                <span className="text-gray-500">VIDEO</span>
                                <div className={`status-dot ${videoConnected ? 'connected' : 'disconnected'}`} />
                            </div>
                            <div className="flex items-center gap-1.5">
                                <span className="text-gray-500">PI</span>
                                <div className={`status-dot ${piConnected ? 'connected' : 'disconnected'}`} />
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            {/* Main content */}
            <div className="flex-1 flex overflow-hidden">
                {/* Video area */}
                <div className="flex-1 p-4 flex flex-col">
                    <div className="flex-1 min-h-0">
                        <VideoPlayer
                            janusServer={CONFIG.janusServer}
                            streamId={CONFIG.streamId}
                            onConnectionChange={setVideoConnected}
                        />
                    </div>

                    {/* Mobile joystick controls (shown on touch devices) */}
                    <div className="flex-shrink-0 mt-4 md:hidden">
                        <DualJoystickController
                            onControl={handleJoystickControl}
                            disabled={!isControlReady || !tabVisible}
                        />
                        <div className="mt-3 flex justify-center">
                            <MicButton
                                connectionState={audioBridge.connectionState}
                                joined={audioBridge.joined}
                                muted={audioBridge.muted}
                                error={audioBridge.error}
                                setMuted={audioBridge.setMuted}
                                disabled={!tabVisible}
                            />
                        </div>
                    </div>
                </div>

                {/* Side panel */}
                <aside className="w-72 flex-shrink-0 border-l border-fpv-border bg-fpv-dark p-4 space-y-4 overflow-y-auto hidden md:block">
                    {/* Status panel */}
                    <StatusPanel
                        controlState={controlState}
                        videoState={videoConnected ? 'connected' : 'disconnected'}
                        piConnected={piConnected}
                        browserClients={browserClients}
                        telemetry={telemetry}
                    />

                    {/* Control display */}
                    <ControlDisplay
                        steer={currentSteer}
                        throttle={currentThrottle}
                        brake={currentBrake}
                        camYaw={currentCamYaw}
                        camPitch={currentCamPitch}
                        inputSource={inputSource}
                        gamepadConnected={gamepad.connected}
                    />

                    {/* Desktop joystick controls */}
                    <div className="panel">
                        <div className="panel-header">Touch Controls</div>
                        <div className="p-3">
                            <DualJoystickController
                                onControl={handleJoystickControl}
                                disabled={!isControlReady || !tabVisible}
                            />
                        </div>
                    </div>

                    {/* Push-to-talk */}
                    <div className="panel">
                        <div className="panel-header">Comms</div>
                        <div className="p-3 flex flex-col items-center gap-2">
                            <MicButton
                                connectionState={audioBridge.connectionState}
                                joined={audioBridge.joined}
                                muted={audioBridge.muted}
                                error={audioBridge.error}
                                setMuted={audioBridge.setMuted}
                                disabled={!tabVisible}
                            />
                            <p className="text-xs text-gray-500 text-center">
                                Hold the button or spacebar to talk to the car.
                            </p>
                        </div>
                    </div>

                    {/* Safety info */}
                    <div className="panel">
                        <div className="panel-header text-fpv-warning">Safety</div>
                        <div className="p-3 text-xs text-gray-400 space-y-2">
                            <p>• Controls stop when tab loses focus</p>
                            <p>• 250ms deadman timeout on Pi</p>
                            <p>• Use physical kill switch for emergencies</p>
                        </div>
                    </div>
                </aside>
            </div>

            {/* Footer */}
            <footer className="flex-shrink-0 px-4 py-2 border-t border-fpv-border bg-fpv-panel">
                <div className="flex items-center justify-between text-xs text-gray-500">
                    <div className="flex items-center gap-4">
                        <span>Latency: {telemetry ? `~${Date.now() - telemetry.timestamp}ms` : '--'}</span>
                    </div>
                    <div>
                        <span className="hud-text text-[10px]">FPV STREAMING SYSTEM v1.0</span>
                    </div>
                </div>
            </footer>
        </div>
    );
}

export default App;

