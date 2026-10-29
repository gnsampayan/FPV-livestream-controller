interface ControlDisplayProps {
    steer: number;
    throttle: number;
    brake: number;
    camYaw: number;
    camPitch: number;
    inputSource: 'gamepad' | 'keyboard' | 'joystick' | 'none';
    gamepadConnected?: boolean;
}

export function ControlDisplay({
    steer,
    throttle,
    brake,
    camYaw,
    camPitch,
    inputSource,
    gamepadConnected = false,
}: ControlDisplayProps) {
    return (
        <div className="panel">
            <div className="panel-header">Control Input</div>

            <div className="p-3 space-y-4">
                {/* Visual steering indicator */}
                <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Steering</span>
                        <span className="text-fpv-accent">{(steer * 100).toFixed(0)}%</span>
                    </div>
                    <BipolarBar value={steer} colorClass="bg-fpv-accent" />
                    <div className="flex justify-between text-[10px] text-gray-600">
                        <span>LEFT</span>
                        <span>RIGHT</span>
                    </div>
                </div>

                {/* Throttle bar */}
                <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Throttle</span>
                        <span className="text-fpv-accent">{(throttle * 100).toFixed(0)}%</span>
                    </div>
                    <div className="h-4 bg-fpv-panel border border-fpv-border rounded overflow-hidden">
                        <div
                            className="h-full bg-gradient-to-r from-fpv-accent/50 to-fpv-accent transition-all duration-75"
                            style={{ width: `${throttle * 100}%` }}
                        />
                    </div>
                </div>

                {/* Brake bar */}
                <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Brake</span>
                        <span className={brake > 0 ? 'text-fpv-danger' : 'text-gray-500'}>
                            {(brake * 100).toFixed(0)}%
                        </span>
                    </div>
                    <div className="h-4 bg-fpv-panel border border-fpv-border rounded overflow-hidden">
                        <div
                            className="h-full bg-fpv-danger transition-all duration-75"
                            style={{ width: `${brake * 100}%` }}
                        />
                    </div>
                </div>

                {/* Camera yaw */}
                <div className="space-y-1 pt-2 border-t border-fpv-border">
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Cam Yaw</span>
                        <span className="text-fpv-info">{(camYaw * 100).toFixed(0)}%</span>
                    </div>
                    <BipolarBar value={camYaw} colorClass="bg-fpv-info" />
                </div>

                {/* Camera pitch */}
                <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Cam Pitch</span>
                        <span className="text-fpv-info">{(camPitch * 100).toFixed(0)}%</span>
                    </div>
                    <BipolarBar value={camPitch} colorClass="bg-fpv-info" />
                    <div className="flex justify-between text-[10px] text-gray-600">
                        <span>DOWN</span>
                        <span>UP</span>
                    </div>
                </div>

                {/* Input source indicator */}
                <div className="flex items-center justify-between pt-2 border-t border-fpv-border">
                    <span className="text-xs text-gray-500">Input</span>
                    <div className="flex items-center gap-2">
                        <span
                            className={`text-xs ${
                                inputSource !== 'none' ? 'text-fpv-accent' : 'text-gray-600'
                            }`}
                        >
                            {inputSource.toUpperCase()}
                        </span>
                        {gamepadConnected && (
                            <span className="text-[10px] text-fpv-info">(PAD)</span>
                        )}
                    </div>
                </div>

                {/* Key hints: drive */}
                <div className="grid grid-cols-3 gap-1 pt-2">
                    <div />
                    <div className="key-hint justify-self-center">W</div>
                    <div />
                    <div className="key-hint justify-self-center">A</div>
                    <div className="key-hint justify-self-center">S</div>
                    <div className="key-hint justify-self-center">D</div>
                </div>
                <div className="flex justify-center">
                    <div className="key-hint px-4">SPACE</div>
                </div>
                <div className="text-center text-[10px] text-gray-600">BRAKE</div>

                {/* Key hints: camera */}
                <div className="grid grid-cols-3 gap-1 pt-2">
                    <div />
                    <div className="key-hint justify-self-center">↑</div>
                    <div />
                    <div className="key-hint justify-self-center">←</div>
                    <div className="key-hint justify-self-center">↓</div>
                    <div className="key-hint justify-self-center">→</div>
                </div>
                <div className="text-center text-[10px] text-gray-600">CAMERA</div>
            </div>
        </div>
    );
}

interface BipolarBarProps {
    value: number; // -1..+1
    colorClass: string;
}

function BipolarBar({ value, colorClass }: BipolarBarProps) {
    const clamped = Math.max(-1, Math.min(1, value));
    return (
        <div className="relative h-4 bg-fpv-panel border border-fpv-border rounded">
            {/* Center line */}
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-fpv-border" />
            {/* Indicator */}
            <div
                className={`absolute top-0.5 bottom-0.5 w-2 rounded transition-all duration-75 ${colorClass}`}
                style={{
                    left: `${50 + clamped * 45}%`,
                    transform: 'translateX(-50%)',
                }}
            />
        </div>
    );
}
