import { useEffect, useRef, useCallback, useState } from 'react';
import nipplejs from 'nipplejs';
import type { JoystickManager, JoystickOutputData } from 'nipplejs';

type JoystickMode = 'drive' | 'camera';

interface VirtualJoystickProps {
    onMove: (x: number, y: number) => void;
    onEnd: () => void;
    mode: JoystickMode;
    disabled?: boolean;
}

// Max travel (in px) from center before the vector is clamped to magnitude 1.
// Must match half of `size` below.
const JOYSTICK_RADIUS = 50;

export function VirtualJoystick({ onMove, onEnd, mode, disabled = false }: VirtualJoystickProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const managerRef = useRef<JoystickManager | null>(null);
    const [isActive, setIsActive] = useState(false);

    const handleMove = useCallback((_evt: unknown, data: JoystickOutputData) => {
        if (disabled) return;

        // Convert nipplejs polar data to a unit-ish vector in [-1, 1] on both axes.
        // `data.angle.radian` uses standard math convention: 0 = right, pi/2 = up.
        const distance = Math.min(data.distance / JOYSTICK_RADIUS, 1);
        const x = Math.cos(data.angle.radian) * distance;
        const y = Math.sin(data.angle.radian) * distance;
        onMove(x, y);
    }, [onMove, disabled]);

    const handleEnd = useCallback(() => {
        setIsActive(false);
        onEnd();
    }, [onEnd]);

    const handleStart = useCallback(() => {
        setIsActive(true);
    }, []);

    useEffect(() => {
        if (!containerRef.current) return;

        const manager = nipplejs.create({
            zone: containerRef.current,
            mode: 'static',
            position: { left: '50%', top: '50%' },
            color: disabled ? '#666' : '#00ff88',
            size: JOYSTICK_RADIUS * 2,
            restOpacity: 0.5,
            fadeTime: 100
        });

        managerRef.current = manager;

        manager.on('start', handleStart);
        manager.on('move', handleMove);
        manager.on('end', handleEnd);

        return () => {
            manager.destroy();
        };
    }, [handleMove, handleEnd, handleStart, disabled]);

    return (
        <div className="relative">
            <div
                ref={containerRef}
                className={`joystick-zone w-32 h-32 relative touch-none ${disabled ? 'opacity-50' : ''}`}
            />

            <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-xs text-gray-500 hud-text whitespace-nowrap">
                {mode === 'drive' ? 'DRIVE' : 'CAMERA'}
            </div>

            {isActive && !disabled && (
                <div className="absolute inset-0 border-2 border-fpv-accent rounded-full animate-pulse pointer-events-none" />
            )}
        </div>
    );
}

interface DualJoystickControllerProps {
    onControl: (steer: number, throttle: number, camYaw: number, camPitch: number) => void;
    disabled?: boolean;
}

/**
 * Dual virtual joystick controller:
 *  - Left stick (DRIVE):  x -> steer (-1..+1), y -> throttle (0..+1, forward only)
 *  - Right stick (CAMERA): x -> camYaw (-1..+1), y -> camPitch (-1..+1)
 *
 * Both sticks are free-movement in all directions (no axis locking).
 */
export function DualJoystickController({ onControl, disabled = false }: DualJoystickControllerProps) {
    const steerRef = useRef(0);
    const throttleRef = useRef(0);
    const camYawRef = useRef(0);
    const camPitchRef = useRef(0);

    const sendUpdate = useCallback(() => {
        onControl(steerRef.current, throttleRef.current, camYawRef.current, camPitchRef.current);
    }, [onControl]);

    const handleDriveMove = useCallback((x: number, y: number) => {
        steerRef.current = x;
        // Throttle is forward-only for now (0..1). Reverse/brake can be added later.
        throttleRef.current = Math.max(0, y);
        sendUpdate();
    }, [sendUpdate]);

    const handleDriveEnd = useCallback(() => {
        steerRef.current = 0;
        throttleRef.current = 0;
        sendUpdate();
    }, [sendUpdate]);

    const handleCameraMove = useCallback((x: number, y: number) => {
        camYawRef.current = x;
        camPitchRef.current = y;
        sendUpdate();
    }, [sendUpdate]);

    const handleCameraEnd = useCallback(() => {
        camYawRef.current = 0;
        camPitchRef.current = 0;
        sendUpdate();
    }, [sendUpdate]);

    return (
        <div className="flex items-center justify-center gap-16 py-4">
            <VirtualJoystick
                mode="drive"
                onMove={handleDriveMove}
                onEnd={handleDriveEnd}
                disabled={disabled}
            />
            <VirtualJoystick
                mode="camera"
                onMove={handleCameraMove}
                onEnd={handleCameraEnd}
                disabled={disabled}
            />
        </div>
    );
}
