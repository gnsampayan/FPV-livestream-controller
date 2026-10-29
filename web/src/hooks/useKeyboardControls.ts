import { useCallback, useEffect, useRef, useState } from 'react';

interface KeyboardState {
  // Drive
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  brake: boolean;
  // Camera
  camUp: boolean;
  camDown: boolean;
  camLeft: boolean;
  camRight: boolean;
}

interface UseKeyboardControlsReturn {
  steer: number;    // -1..+1
  throttle: number; //  0..+1
  brake: number;    //  0..+1
  camYaw: number;   // -1..+1
  camPitch: number; // -1..+1
  isActive: boolean;
  keys: KeyboardState;
}

const EMPTY_STATE: KeyboardState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  brake: false,
  camUp: false,
  camDown: false,
  camLeft: false,
  camRight: false,
};

type StateField = keyof KeyboardState;

function fieldForKey(key: string): StateField | null {
  switch (key) {
    case 'w':
      return 'forward';
    case 's':
      return 'backward';
    case 'a':
      return 'left';
    case 'd':
      return 'right';
    case ' ':
      return 'brake';
    case 'arrowup':
      return 'camUp';
    case 'arrowdown':
      return 'camDown';
    case 'arrowleft':
      return 'camLeft';
    case 'arrowright':
      return 'camRight';
    default:
      return null;
  }
}

/**
 * Keyboard input hook:
 *  - W/A/S/D move the car, Space brakes.
 *  - Arrow keys aim the camera (Up/Down -> camPitch, Left/Right -> camYaw).
 *
 * Drive and camera axes are independent so the user can pan the camera
 * while driving straight.
 */
export function useKeyboardControls(enabled: boolean = true): UseKeyboardControlsReturn {
  const [keys, setKeys] = useState<KeyboardState>(EMPTY_STATE);
  const isActive = useRef(false);

  const setField = useCallback((field: StateField, pressed: boolean) => {
    setKeys((prev) => {
      if (prev[field] === pressed) return prev;
      const next = { ...prev, [field]: pressed };
      // Recompute isActive from the new state rather than tracking drift.
      isActive.current =
        next.forward || next.backward || next.left || next.right || next.brake ||
        next.camUp || next.camDown || next.camLeft || next.camRight;
      return next;
    });
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!enabled) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    const field = fieldForKey(event.key.toLowerCase());
    if (!field) return;
    // Stop arrow keys from scrolling the page and space from triggering buttons/scroll.
    if (field === 'brake' || field.startsWith('cam')) {
      event.preventDefault();
    }
    setField(field, true);
  }, [enabled, setField]);

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    if (!enabled) return;
    const field = fieldForKey(event.key.toLowerCase());
    if (!field) return;
    setField(field, false);
  }, [enabled, setField]);

  const handleBlur = useCallback(() => {
    setKeys(EMPTY_STATE);
    isActive.current = false;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [enabled, handleKeyDown, handleKeyUp, handleBlur]);

  const steer = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);
  // Backward is slower than forward so a tap of S doesn't behave like full reverse.
  const throttle = keys.forward ? 1 : keys.backward ? 0.5 : 0;
  const brake = keys.brake ? 1 : 0;
  const camYaw = (keys.camLeft ? -1 : 0) + (keys.camRight ? 1 : 0);
  const camPitch = (keys.camDown ? -1 : 0) + (keys.camUp ? 1 : 0);

  return {
    steer,
    throttle,
    brake,
    camYaw,
    camPitch,
    isActive:
      isActive.current ||
      keys.forward || keys.backward || keys.left || keys.right || keys.brake ||
      keys.camUp || keys.camDown || keys.camLeft || keys.camRight,
    keys,
  };
}
