import { useEffect, useRef, useState } from 'react';

// Standard "Xbox-style" mapping used by the Gamepad API.
// axes[0/1] = left stick X/Y, axes[2/3] = right stick X/Y,
// buttons[6] = left trigger (LT), buttons[7] = right trigger (RT).
const AXIS_LEFT_X = 0;
const AXIS_LEFT_Y = 1;
const AXIS_RIGHT_X = 2;
const AXIS_RIGHT_Y = 3;
const BTN_LT = 6;
const BTN_RT = 7;

export interface GamepadInput {
  steer: number;    // -1..+1  (left stick X)
  throttle: number; //  0..+1  (right trigger OR forward push on left stick)
  brake: number;    //  0..+1  (left trigger)
  camYaw: number;   // -1..+1  (right stick X)
  camPitch: number; // -1..+1  (right stick Y, inverted so up = +1)
  isActive: boolean;
  connected: boolean;
}

const NEUTRAL: GamepadInput = {
  steer: 0,
  throttle: 0,
  brake: 0,
  camYaw: 0,
  camPitch: 0,
  isActive: false,
  connected: false,
};

/**
 * Apply a radial deadzone to a 2D stick so diagonals feel smooth.
 * Returns the scaled [x, y] pair; both are 0 inside the deadzone.
 */
function applyRadialDeadzone(x: number, y: number, deadzone: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < deadzone) return [0, 0];
  // Rescale the remainder so mag=deadzone -> 0 output, mag=1 -> full output.
  const scale = (mag - deadzone) / (1 - deadzone) / mag;
  return [x * scale, y * scale];
}

function applyScalarDeadzone(v: number, deadzone: number): number {
  return Math.abs(v) < deadzone ? 0 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Reads the first connected gamepad via the native Gamepad API.
 * Polls on requestAnimationFrame, applies radial deadzones, and re-renders
 * only when any reported axis/button changes by more than ~1 bit of noise.
 */
export function useGamepad(enabled: boolean = true, deadzone: number = 0.08): GamepadInput {
  const [input, setInput] = useState<GamepadInput>(NEUTRAL);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<GamepadInput>(NEUTRAL);

  useEffect(() => {
    if (!enabled) {
      setInput(NEUTRAL);
      lastRef.current = NEUTRAL;
      return;
    }

    const poll = (): void => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      // Pick the first non-null, connected gamepad.
      let pad: Gamepad | null = null;
      for (const p of pads) {
        if (p && p.connected) {
          pad = p;
          break;
        }
      }

      let next: GamepadInput;
      if (!pad) {
        next = NEUTRAL;
      } else {
        const [lx, ly] = applyRadialDeadzone(
          pad.axes[AXIS_LEFT_X] ?? 0,
          pad.axes[AXIS_LEFT_Y] ?? 0,
          deadzone,
        );
        const [rx, ry] = applyRadialDeadzone(
          pad.axes[AXIS_RIGHT_X] ?? 0,
          pad.axes[AXIS_RIGHT_Y] ?? 0,
          deadzone,
        );

        const rt = applyScalarDeadzone(pad.buttons[BTN_RT]?.value ?? 0, deadzone);
        const lt = applyScalarDeadzone(pad.buttons[BTN_LT]?.value ?? 0, deadzone);

        // Throttle source of truth: prefer right trigger; fall back to forward push on left stick
        // so people without analog triggers still have something to drive with.
        const forwardStick = ly < 0 ? -ly : 0;
        const throttle = clamp(Math.max(rt, forwardStick), 0, 1);
        const brake = clamp(lt, 0, 1);
        const steer = clamp(lx, -1, 1);
        const camYaw = clamp(rx, -1, 1);
        const camPitch = clamp(-ry, -1, 1);

        const isActive =
          steer !== 0 ||
          throttle !== 0 ||
          brake !== 0 ||
          camYaw !== 0 ||
          camPitch !== 0;

        next = {
          steer,
          throttle,
          brake,
          camYaw,
          camPitch,
          isActive,
          connected: true,
        };
      }

      const prev = lastRef.current;
      // Only re-render when something actually changed (noise threshold).
      const EPS = 0.01;
      const changed =
        prev.connected !== next.connected ||
        prev.isActive !== next.isActive ||
        Math.abs(prev.steer - next.steer) > EPS ||
        Math.abs(prev.throttle - next.throttle) > EPS ||
        Math.abs(prev.brake - next.brake) > EPS ||
        Math.abs(prev.camYaw - next.camYaw) > EPS ||
        Math.abs(prev.camPitch - next.camPitch) > EPS;

      if (changed) {
        lastRef.current = next;
        setInput(next);
      }

      rafRef.current = window.requestAnimationFrame(poll);
    };

    const onConnect = (): void => {
      // Kick the poll so we pick up the freshly attached pad.
      if (rafRef.current === null) {
        rafRef.current = window.requestAnimationFrame(poll);
      }
    };
    const onDisconnect = (): void => {
      lastRef.current = NEUTRAL;
      setInput(NEUTRAL);
    };

    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
    rafRef.current = window.requestAnimationFrame(poll);

    return () => {
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnect);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, deadzone]);

  return input;
}
