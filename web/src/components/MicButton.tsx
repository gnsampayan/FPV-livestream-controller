import { useCallback, useEffect, useRef } from 'react';
import type { ConnectionState } from '../types';

interface MicButtonProps {
    connectionState: ConnectionState;
    joined: boolean;
    muted: boolean;
    error: string | null;
    setMuted: (muted: boolean) => void;
    disabled?: boolean;
}

/**
 * Push-to-talk button. Hold to transmit, release to mute. Bound to the
 * spacebar globally so the driver can talk without taking a hand off the
 * mouse/joystick. Touch-friendly on mobile (pointer events cover both
 * mouse and touch).
 */
export function MicButton({
    connectionState,
    joined,
    muted,
    error,
    setMuted,
    disabled
}: MicButtonProps) {
    const isReady = connectionState === 'connected' && joined && !disabled;
    const isHolding = !muted;

    // Track whether THIS component initiated the unmute, so we don't fight
    // with mouse-up handlers when the spacebar is also held.
    const heldByPointer = useRef(false);
    const heldByKey = useRef(false);

    const press = useCallback(() => {
        if (!isReady) return;
        setMuted(false);
    }, [isReady, setMuted]);

    const release = useCallback(() => {
        // Only mute when neither input source is still asking for mic on.
        if (heldByPointer.current || heldByKey.current) return;
        setMuted(true);
    }, [setMuted]);

    // Spacebar push-to-talk. We listen on window (not the button) so the
    // user doesn't need to focus the button first.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.code !== 'Space' || e.repeat) return;
            // Don't hijack space when typing in a real input.
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
            e.preventDefault();
            heldByKey.current = true;
            press();
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.code !== 'Space') return;
            heldByKey.current = false;
            release();
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, [press, release]);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        heldByPointer.current = true;
        press();
    }, [press]);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        heldByPointer.current = false;
        release();
    }, [release]);

    let label: string;
    let stateClass: string;
    if (error) {
        label = 'MIC ERROR';
        stateClass = 'border-fpv-danger text-fpv-danger';
    } else if (!isReady) {
        label = connectionState === 'connecting' ? 'MIC CONNECTING' : 'MIC OFFLINE';
        stateClass = 'border-fpv-border text-gray-500 cursor-not-allowed';
    } else if (isHolding) {
        label = 'TALKING';
        stateClass = 'border-fpv-accent bg-fpv-accent/20 text-fpv-accent';
    } else {
        label = 'HOLD TO TALK';
        stateClass = 'border-fpv-border text-gray-300 hover:border-fpv-accent hover:text-fpv-accent';
    }

    return (
        <button
            type="button"
            disabled={!isReady}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={(e) => {
                // If the user drags off the button while pressed, treat it
                // like a release. This avoids "stuck mic" if a touch slides.
                if (heldByPointer.current) {
                    heldByPointer.current = false;
                    e.currentTarget.releasePointerCapture(e.pointerId);
                    release();
                }
            }}
            onContextMenu={(e) => e.preventDefault()}
            title={error ?? 'Hold (or hold spacebar) to talk'}
            className={`select-none touch-none px-4 py-2 border font-mono text-xs tracking-wider transition-colors ${stateClass}`}
        >
            {label}
        </button>
    );
}
