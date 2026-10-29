declare module 'nipplejs' {
  export interface JoystickOptions {
    zone: HTMLElement;
    mode?: 'static' | 'semi' | 'dynamic';
    position?: { left?: string; top?: string; right?: string; bottom?: string };
    color?: string;
    size?: number;
    lockX?: boolean;
    lockY?: boolean;
    restOpacity?: number;
    fadeTime?: number;
    multitouch?: boolean;
    maxNumberOfNipples?: number;
    dataOnly?: boolean;
    restJoystick?: boolean | { size?: number; stroke?: number };
    threshold?: number;
    catchDistance?: number;
    shape?: 'circle' | 'square';
    dynamicPage?: boolean;
    follow?: boolean;
  }

  export interface JoystickOutputData {
    angle: {
      radian: number;
      degree: number;
    };
    direction?: {
      x: 'left' | 'right';
      y: 'up' | 'down';
      angle: string;
    };
    distance: number;
    force: number;
    identifier: number;
    instance: JoystickInstance;
    lockX: boolean;
    lockY: boolean;
    position: {
      x: number;
      y: number;
    };
    pressure: number;
    raw: {
      distance: number;
      position: {
        x: number;
        y: number;
      };
    };
    vector: {
      x: number;
      y: number;
    };
  }

  export interface JoystickInstance {
    id: number;
    options: JoystickOptions;
    position: { x: number; y: number };
    frontPosition: { x: number; y: number };
    ui: {
      el: HTMLElement;
      front: HTMLElement;
      back: HTMLElement;
    };
    identifier: number;
    trigger: (type: string, data?: JoystickOutputData) => void;
    show: (cb?: () => void) => void;
    hide: (cb?: () => void) => void;
    add: () => void;
    remove: () => void;
    destroy: () => void;
    resetDirection: () => void;
    computeDirection: (evt: { angle: { degree: number } }) => void;
  }

  export interface JoystickManager {
    on: (
      type: 'start' | 'end' | 'move' | 'dir' | 'dir:up' | 'dir:down' | 'dir:left' | 'dir:right' | 'plain' | 'plain:up' | 'plain:down' | 'plain:left' | 'plain:right' | 'shown' | 'hidden' | 'pressure' | 'added' | 'removed',
      handler: (evt: unknown, data: JoystickOutputData) => void
    ) => void;
    off: (
      type: string,
      handler?: (evt: unknown, data: JoystickOutputData) => void
    ) => void;
    get: (id?: number) => JoystickInstance | JoystickInstance[];
    destroy: () => void;
    ids: number[];
    id: number;
    options: JoystickOptions;
  }

  export function create(options: JoystickOptions): JoystickManager;
}

