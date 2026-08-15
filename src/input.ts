// One adapter for mouse and touch, producing the same "watcher" senses.
// Touch has no passive hover, so contact leaves a fading ghost — the critter
// can still react to where the hand just was.

export interface PointerSense {
  x: number;
  y: number;
  presence: number;
  speed: number;
  stillFor: number;
  kind: 'mouse' | 'touch';
}

export interface Knock {
  x: number;
  y: number;
  strength: number;
}

const GHOST_FADE_S = { mouse: 1.5, touch: 4 };
const TAP_MAX_MS = 250;
const TAP_MAX_DRIFT = 12;
const KNOCK_CLICK = 1.0;
// screens with coarse pointers are small, so every tap lands close — soften it
const KNOCK_TAP = 0.6;

export interface Input {
  state: PointerSense;
  update(dt: number): void;
  takeKnocks(): Knock[];
}

export function createInput(): Input {
  const state: PointerSense = {
    x: -9999,
    y: -9999,
    presence: 0,
    speed: 0,
    stillFor: 999,
    kind: 'mouse',
  };
  let contact = false;
  let fadeRate = 1 / GHOST_FADE_S.mouse;
  let prev: { x: number; y: number } | null = null;
  let knocks: Knock[] = [];
  let touchStart: { x: number; y: number; at: number } | null = null;

  function begin(e: PointerEvent): void {
    contact = true;
    state.kind = e.pointerType === 'touch' ? 'touch' : 'mouse';
    state.x = e.clientX;
    state.y = e.clientY;
    state.presence = 1;
    prev = null; // no phantom lunge on (re)entry
  }

  function release(): void {
    contact = false;
    fadeRate = 1 / GHOST_FADE_S[state.kind];
    prev = null;
  }

  window.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    if (e.pointerType === 'touch') {
      begin(e);
      touchStart = { x: e.clientX, y: e.clientY, at: performance.now() };
    } else {
      begin(e);
      knocks.push({ x: e.clientX, y: e.clientY, strength: KNOCK_CLICK });
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return;
    if (e.pointerType === 'touch' && !contact) return;
    if (!contact) begin(e);
    state.x = e.clientX;
    state.y = e.clientY;
    if (touchStart && Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) > TAP_MAX_DRIFT) {
      touchStart = null; // strayed too far to ever count as a tap
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (!e.isPrimary || e.pointerType !== 'touch') return;
    if (touchStart && performance.now() - touchStart.at < TAP_MAX_MS) {
      knocks.push({ x: e.clientX, y: e.clientY, strength: KNOCK_TAP });
    }
    touchStart = null;
    release();
  });

  window.addEventListener('pointercancel', (e) => {
    if (!e.isPrimary) return;
    touchStart = null;
    release();
  });

  document.addEventListener('mouseleave', () => release());
  // leaving the window sometimes skips mouseleave; mouseout with no relatedTarget
  // is the robust exit signal
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget === null) release();
  });
  window.addEventListener('blur', () => {
    touchStart = null;
    release();
  });
  if (matchMedia('(pointer: coarse)').matches) {
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function update(dt: number): void {
    if (contact) {
      state.presence = 1;
      if (prev) {
        const step = Math.hypot(state.x - prev.x, state.y - prev.y);
        const instant = step / dt;
        state.speed += (instant - state.speed) * Math.min(1, dt * 12);
        if (instant > 60) state.stillFor = 0;
        else state.stillFor += dt;
      }
      prev = { x: state.x, y: state.y };
    } else {
      state.presence = Math.max(0, state.presence - fadeRate * dt);
      state.speed *= Math.max(0, 1 - 12 * dt);
      state.stillFor += dt;
    }
  }

  function takeKnocks(): Knock[] {
    const out = knocks;
    knocks = [];
    return out;
  }

  return { state, update, takeKnocks };
}
