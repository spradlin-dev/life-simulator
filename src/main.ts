import './style.css';
import {
  chooseState,
  clamp01,
  knock,
  lerp,
  personalSpace,
  updateMoods,
  type CritterState,
  type Moods,
  type Senses,
} from './brain.ts';
import { createInput } from './input.ts';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLDivElement;

// logical viewport in CSS px; the canvas backing store is scaled to the device
const view = { w: 0, h: 0 };

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const input = createInput();
const pointer = input.state;

if (matchMedia('(pointer: coarse)').matches) {
  hint.textContent = 'touch gently — press and hold, and it may come see you.';
}

// ------------------------------------------------------------------ the critter

interface Vec {
  x: number;
  y: number;
}

const pip = {
  x: view.w / 2,
  y: view.h / 2,
  vx: 0,
  vy: 0,
  facing: 1,
  state: 'wander' as CritterState,
  stateTime: 0,
  moods: { fear: 0, curiosity: 0, trust: 0.5 } as Moods,
  wanderTarget: null as Vec | null,
  pauseFor: 0,
  blinkIn: 2,
  emote: '',
  emoteFor: 0,
  antenna: { x: view.w / 2, y: view.h / 2 - 42, vx: 0, vy: 0 },
};

function distToPointer(): number {
  return Math.hypot(pointer.x - pip.x, pointer.y - pip.y);
}

function currentSenses(): Senses {
  return {
    presence: pointer.presence,
    dist: distToPointer(),
    speed: pointer.speed,
    stillFor: pointer.stillFor,
  };
}

function space(): number {
  return personalSpace(pip.moods.trust);
}

function showEmote(symbol: string): void {
  pip.emote = symbol;
  pip.emoteFor = 1.2;
}

// ------------------------------------------------------------------ movement

function steerToward(tx: number, ty: number, accel: number, maxSpeed: number, dt: number): void {
  const dx = tx - pip.x;
  const dy = ty - pip.y;
  const d = Math.hypot(dx, dy);
  if (d > 1) {
    pip.vx += (dx / d) * accel * dt;
    pip.vy += (dy / d) * accel * dt;
  }
  const sp = Math.hypot(pip.vx, pip.vy);
  if (sp > maxSpeed) {
    pip.vx = (pip.vx / sp) * maxSpeed;
    pip.vy = (pip.vy / sp) * maxSpeed;
  }
}

function settle(dt: number, rate: number): void {
  const k = Math.max(0, 1 - rate * dt);
  pip.vx *= k;
  pip.vy *= k;
}

function act(dt: number, t: number): void {
  const dist = distToPointer();

  switch (pip.state) {
    case 'wander': {
      if (pip.pauseFor > 0) {
        pip.pauseFor -= dt;
        settle(dt, 4);
        break;
      }
      let wt = pip.wanderTarget;
      if (!wt || Math.hypot(wt.x - pip.x, wt.y - pip.y) < 20) {
        wt = {
          x: 60 + Math.random() * Math.max(0, view.w - 120),
          y: 60 + Math.random() * Math.max(0, view.h - 120),
        };
        pip.wanderTarget = wt;
        if (Math.random() < 0.4) pip.pauseFor = 1 + Math.random() * 2.5;
      }
      steerToward(wt.x, wt.y, 300, 60, dt);
      break;
    }
    case 'curious': {
      // creeps closer in fits and starts, stopping at a respectful distance
      const stepping = Math.sin(pip.stateTime * 2.4) > -0.2;
      if (dist > space() && stepping) steerToward(pointer.x, pointer.y, 260, 75, dt);
      else settle(dt, 5);
      if (pip.stateTime < 0.05) showEmote('?');
      break;
    }
    case 'follow': {
      if (dist > space() + 26) steerToward(pointer.x, pointer.y, 500, 210, dt);
      else settle(dt, 4);
      break;
    }
    case 'flee': {
      const away = Math.atan2(pip.y - pointer.y, pip.x - pointer.x);
      const wobble = Math.sin(t * 9) * 0.5;
      steerToward(
        pip.x + Math.cos(away + wobble) * 100,
        pip.y + Math.sin(away + wobble) * 100,
        900, 330, dt);
      break;
    }
    case 'cower':
      settle(dt, 10);
      break;
    case 'snuggle': {
      if (dist > space() * 0.8) steerToward(pointer.x, pointer.y, 120, 40, dt);
      else settle(dt, 3);
      if (pip.emoteFor <= 0 && Math.random() < dt / 2) showEmote('♥');
      break;
    }
    case 'sleep':
      settle(dt, 3);
      if (pip.emoteFor <= 0 && Math.random() < dt / 3) showEmote('z');
      break;
    default: {
      const unhandled: never = pip.state;
      throw new Error(`unhandled state: ${String(unhandled)}`);
    }
  }

  // soft spring away from the edges, hard clamp as a backstop
  const m = 50;
  if (pip.x < m) pip.vx += (m - pip.x) * 60 * dt;
  if (pip.x > view.w - m) pip.vx -= (pip.x - (view.w - m)) * 60 * dt;
  if (pip.y < m) pip.vy += (m - pip.y) * 60 * dt;
  if (pip.y > view.h - m) pip.vy -= (pip.y - (view.h - m)) * 60 * dt;

  pip.x += pip.vx * dt;
  pip.y += pip.vy * dt;
  pip.x = Math.min(view.w - 26, Math.max(26, pip.x));
  pip.y = Math.min(view.h - 26, Math.max(26, pip.y));

  if (Math.abs(pip.vx) > 5) pip.facing = Math.sign(pip.vx);
}

function updateAntenna(dt: number): void {
  const a = pip.antenna;
  a.vx += (pip.x - pip.facing * 4 - a.x) * 60 * dt;
  a.vy += (pip.y - 42 - a.y) * 60 * dt;
  a.vx *= Math.max(0, 1 - 6 * dt);
  a.vy *= Math.max(0, 1 - 6 * dt);
  a.x += a.vx * dt;
  a.y += a.vy * dt;
}

function updateTimers(dt: number): void {
  pip.emoteFor = Math.max(0, pip.emoteFor - dt);
  pip.blinkIn -= dt;
  if (pip.blinkIn < -0.12) pip.blinkIn = 1.5 + Math.random() * 4;
}

// ------------------------------------------------------------------ drawing

type Rgb = [number, number, number];

function mixColor(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// the touch ghost, made visible: its opacity IS the presence value the brain sees
function drawTouchGhost(): void {
  if (pointer.kind !== 'touch' || pointer.presence <= 0) return;
  const glow = ctx.createRadialGradient(pointer.x, pointer.y, 2, pointer.x, pointer.y, 26);
  glow.addColorStop(0, 'rgba(180, 240, 220, 0.8)');
  glow.addColorStop(1, 'rgba(180, 240, 220, 0)');
  ctx.globalAlpha = pointer.presence * 0.35;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(pointer.x, pointer.y, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = pointer.presence * 0.5;
  ctx.strokeStyle = 'rgba(190, 235, 220, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(pointer.x, pointer.y, 18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function bodyColor(): string {
  const calm: Rgb = [111, 211, 176];
  const scared: Rgb = [154, 160, 214];
  const warm: Rgb = [255, 178, 122];
  let c = mixColor(calm, scared, pip.moods.fear);
  if (pip.state === 'snuggle') c = mixColor(c, warm, 0.6);
  return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
}

function draw(t: number): void {
  ctx.clearRect(0, 0, view.w, view.h);

  drawTouchGhost();

  const speed = Math.hypot(pip.vx, pip.vy);
  const asleep = pip.state === 'sleep';
  const trembling = pip.state === 'cower' ? 1 : pip.moods.fear > 0.5 ? 0.4 : 0;
  const jx = (Math.random() - 0.5) * 4 * trembling;
  const jy = (Math.random() - 0.5) * 4 * trembling;

  const bob = asleep
    ? Math.sin(t * 2) * 1.5
    : Math.sin(t * (6 + speed / 40)) * Math.min(3, 1 + speed / 80);
  const x = pip.x + jx;
  const y = pip.y + jy + bob;

  const R = 24;
  const stretch = Math.min(0.22, speed / 900);
  const sx = 1 + stretch;
  const sy = (1 - stretch) * (asleep ? 1 + Math.sin(t * 2) * 0.04 : 1);
  const squish = pip.state === 'cower' ? 0.78 : 1;
  const color = bodyColor();

  // shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.ellipse(pip.x, pip.y + R * 0.95, R * sx * 0.9, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  // antenna
  const headTopY = y - R * sy * squish + 3;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x, headTopY);
  ctx.quadraticCurveTo(
    (x + pip.antenna.x) / 2,
    (headTopY + pip.antenna.y) / 2 - 4,
    pip.antenna.x, pip.antenna.y);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(pip.antenna.x, pip.antenna.y, 4, 0, Math.PI * 2);
  ctx.fill();

  // body
  ctx.beginPath();
  ctx.ellipse(x, y, R * sx, R * sy * squish, 0, 0, Math.PI * 2);
  ctx.fill();

  // blush
  const eyeY = y - 4;
  if (pip.state === 'snuggle') {
    ctx.fillStyle = 'rgba(255, 130, 150, 0.4)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + side * 13, eyeY + 8, 4.5, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // eyes
  let lookX = 0;
  let lookY = 0;
  if (pointer.presence > 0) {
    const a = Math.atan2(pointer.y - y, pointer.x - x);
    lookX = Math.cos(a) * 2.8;
    lookY = Math.sin(a) * 2.8;
  }
  const blinking = pip.blinkIn < 0;
  for (const side of [-1, 1]) {
    const ex = x + side * 9;
    if (asleep || blinking) {
      ctx.strokeStyle = '#1c2733';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ex, eyeY + 1, 3.5, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = '#f4f7f5';
    ctx.beginPath();
    ctx.arc(ex, eyeY, 5.5 + pip.moods.fear * 2.5, 0, Math.PI * 2);
    ctx.fill();
    const pupil = Math.max(1.2, Math.min(4.2, 2 + pip.moods.curiosity * 2 - pip.moods.fear * 1.4));
    ctx.fillStyle = '#1c2733';
    ctx.beginPath();
    ctx.arc(ex + lookX, eyeY + lookY, pupil, 0, Math.PI * 2);
    ctx.fill();
  }

  // emote bubble
  if (pip.emoteFor > 0) {
    const rise = (1.2 - pip.emoteFor) * 12;
    ctx.globalAlpha = Math.min(1, pip.emoteFor / 0.4);
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = pip.emote === '♥' ? '#ff8fa3' : '#dfe8f0';
    ctx.fillText(pip.emote, x + 16, y - R - 14 - rise);
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ hud & loop

const MOOD_LABELS: Record<CritterState, string> = {
  wander: 'moseying about',
  curious: 'intrigued…',
  follow: 'tagging along',
  flee: 'nope nope nope',
  cower: 'too scared to move',
  snuggle: 'happy near you',
  sleep: 'fast asleep',
};

function meter(v: number): string {
  const n = Math.round(clamp01(v) * 8);
  return '▰'.repeat(n) + '▱'.repeat(8 - n);
}

function updateHud(): void {
  hud.textContent =
    `pip: ${MOOD_LABELS[pip.state]}\n` +
    `trust     ${meter(pip.moods.trust)}\n` +
    `fear      ${meter(pip.moods.fear)}\n` +
    `curiosity ${meter(pip.moods.curiosity)}`;
}

let last = performance.now();
let playedFor = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000) || 0.016;
  last = now;
  const t = now / 1000;

  input.update(dt);

  for (const k of input.takeKnocks()) {
    const before = pip.moods.fear;
    pip.moods = knock(pip.moods, Math.hypot(k.x - pip.x, k.y - pip.y), k.strength);
    if (pip.moods.fear > before) showEmote('!');
  }

  const senses = currentSenses();
  const beforeFear = pip.moods.fear;
  pip.moods = updateMoods(pip.moods, senses, dt);
  if (pip.moods.fear > 0.3 && beforeFear <= 0.3) showEmote('!');

  const decision = chooseState(pip.state, pip.moods, senses);
  pip.moods = decision.moods;
  if (decision.startled) showEmote('!');
  if (decision.state !== pip.state) {
    pip.state = decision.state;
    pip.stateTime = 0;
  }
  pip.stateTime += dt;

  act(dt, t);
  updateAntenna(dt);
  updateTimers(dt);
  draw(t);
  updateHud();

  if (pointer.presence > 0.9 && playedFor < 9) {
    playedFor += dt;
    if (playedFor >= 9) hint.classList.add('hidden');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
