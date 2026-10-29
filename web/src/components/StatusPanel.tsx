import { THROTTLE_ACTIVE_MASK } from '../types';
import type { ArduinoLink, TelemetryMessage, ConnectionState } from '../types';

// Control round-trip thresholds (ms) for colouring the readout.
const RTT_WARN_MS = 100;
const RTT_DANGER_MS = 250;

interface StatusPanelProps {
    controlState: ConnectionState;
    videoState: ConnectionState;
    piConnected: boolean;
    browserClients: number;
    telemetry?: TelemetryMessage;
}

export function StatusPanel({
    controlState,
    videoState,
    piConnected,
    browserClients,
    telemetry
}: StatusPanelProps) {
    return (
        <div className="panel">
            <div className="panel-header">System Status</div>

            <div className="p-3 space-y-3">
                {/* Connection status */}
                <div className="space-y-2">
                    <StatusRow
                        label="Control Link"
                        status={controlState}
                        connected={controlState === 'connected'}
                    />
                    <StatusRow
                        label="Video Link"
                        status={videoState}
                        connected={videoState === 'connected'}
                    />
                    <StatusRow
                        label="Pi Status"
                        status={piConnected ? 'connected' : 'disconnected'}
                        connected={piConnected}
                    />
                </div>

                {/* Divider */}
                <div className="border-t border-fpv-border" />

                {/* Telemetry */}
                {telemetry && (
                    <div className="space-y-2">
                        <RttRow rttMs={telemetry.rttMs} />
                        {telemetry.throttledFlags !== undefined &&
                            (telemetry.throttledFlags & THROTTLE_ACTIVE_MASK) !== 0 && (
                                <div className="px-2 py-1 bg-fpv-warning/20 border border-fpv-warning rounded text-[11px] text-fpv-warning font-semibold tracking-wider">
                                    PI THROTTLED - check power and cooling
                                </div>
                            )}
                        {telemetry.battery !== undefined && (
                            <TelemetryBar
                                label="Battery"
                                value={telemetry.battery}
                                max={100}
                                unit="%"
                                warning={telemetry.battery < 20}
                            />
                        )}
                        {telemetry.rssi !== undefined && (
                            <TelemetryBar
                                label="Signal"
                                value={Math.abs(telemetry.rssi)}
                                max={100}
                                unit="dBm"
                                inverted
                            />
                        )}
                        {telemetry.cpuTemp !== undefined && (
                            <TelemetryBar
                                label="CPU Temp"
                                value={telemetry.cpuTemp}
                                max={85}
                                unit="°C"
                                warning={telemetry.cpuTemp > 70}
                            />
                        )}
                    </div>
                )}

                {/* Arduino link health */}
                <div className="border-t border-fpv-border" />
                <ArduinoLinkPanel link={telemetry?.arduino} />

                {/* Stats */}
                <div className="text-xs text-gray-500 space-y-1">
                    <div className="flex justify-between">
                        <span>Viewers</span>
                        <span className="text-fpv-info">{browserClients}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

interface StatusRowProps {
    label: string;
    status: string;
    connected: boolean;
}

function StatusRow({ label, status, connected }: StatusRowProps) {
    return (
        <div className="flex items-center justify-between text-xs">
            <span className="text-gray-400">{label}</span>
            <div className="flex items-center gap-2">
                <span className={connected ? 'text-fpv-accent' : 'text-gray-500'}>
                    {status.toUpperCase()}
                </span>
                <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
            </div>
        </div>
    );
}

interface RttRowProps {
    rttMs?: number | null;
}

function RttRow({ rttMs }: RttRowProps) {
    if (rttMs === undefined || rttMs === null) {
        return (
            <div className="flex justify-between text-xs">
                <span className="text-gray-400">Control RTT</span>
                <span className="text-gray-500">--</span>
            </div>
        );
    }

    let colorClass = 'text-fpv-accent';
    if (rttMs > RTT_DANGER_MS) {
        colorClass = 'text-fpv-danger';
    } else if (rttMs > RTT_WARN_MS) {
        colorClass = 'text-fpv-warning';
    }

    return (
        <div className="flex justify-between text-xs">
            <span className="text-gray-400">Control RTT</span>
            <span className={colorClass}>{rttMs} ms</span>
        </div>
    );
}

interface TelemetryBarProps {
    label: string;
    value: number;
    max: number;
    unit: string;
    warning?: boolean;
    inverted?: boolean;
}

function TelemetryBar({ label, value, max, unit, warning = false, inverted = false }: TelemetryBarProps) {
    const percentage = inverted ? ((max - value) / max) * 100 : (value / max) * 100;
    const color = warning ? 'bg-fpv-danger' : 'bg-fpv-accent';

    return (
        <div className="space-y-1">
            <div className="flex justify-between text-xs">
                <span className="text-gray-400">{label}</span>
                <span className={warning ? 'text-fpv-danger' : 'text-fpv-accent'}>
                    {value.toFixed(1)}{unit}
                </span>
            </div>
            <div className="telemetry-bar">
                <div
                    className={`telemetry-bar-fill ${color}`}
                    style={{ width: `${Math.min(100, percentage)}%` }}
                />
            </div>
        </div>
    );
}

interface ArduinoLinkPanelProps {
    link?: ArduinoLink;
}

function ArduinoLinkPanel({ link }: ArduinoLinkPanelProps) {
    // No telemetry yet / older Pi firmware - keep the section so layout doesn't jump.
    if (!link) {
        return (
            <div className="text-xs text-gray-500">
                <div className="flex justify-between">
                    <span>Arduino Link</span>
                    <span>unknown</span>
                </div>
            </div>
        );
    }

    // Stale-link color thresholds in ms. Null linkAgeMs means the Pi has never heard back.
    const age = link.linkAgeMs;
    let ageLabel: string;
    let ageClass: string;
    if (age === null || age === undefined) {
        ageLabel = 'no reply';
        ageClass = 'text-fpv-danger';
    } else if (age > 500) {
        ageLabel = `${age} ms`;
        ageClass = 'text-fpv-danger';
    } else if (age > 150) {
        ageLabel = `${age} ms`;
        ageClass = 'text-fpv-warning';
    } else {
        ageLabel = `${age} ms`;
        ageClass = 'text-fpv-accent';
    }

    return (
        <div className="space-y-2">
            {link.failsafeActive && (
                <div className="px-2 py-1 bg-fpv-danger/20 border border-fpv-danger rounded text-[11px] text-fpv-danger font-semibold tracking-wider">
                    FAILSAFE - motors disarmed
                </div>
            )}
            <div className="flex justify-between text-xs">
                <span className="text-gray-400">Arduino Link</span>
                <span className={ageClass}>{ageLabel}</span>
            </div>
            <div className="flex justify-between text-[11px] text-gray-500">
                <span>Frames</span>
                <span className="text-gray-300">{link.framesSinceBoot.toLocaleString()}</span>
            </div>
        </div>
    );
}

