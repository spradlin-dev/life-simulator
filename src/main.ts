import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { clamp01, lerp } from './math.ts';
import { descend, FOUNDER, hueShift, type Genes } from './genes.ts';
import {
  chooseState,
  knock,
  personalSpace,
  updateMoods,
  type CritterState,
  type Moods,
  type Senses,
} from './brain.ts';
import { eat, FRESH_NEEDS, happinessOf, tickNeeds, type Needs } from './needs.ts';
import {
  effectiveGenes,
  fadePlaces,
  FRESH_DISPOSITIONS,
  freshPlaces,
  learn,
  markPlace,
  placeAt,
  type Dispositions,
} from './dispositions.ts';
import { createInput } from './input.ts';
import { clearSave, loadSave, storeSave, type LivePip } from './save.ts';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLDivElement;

// logical viewport in CSS px; the canvas backing store is scaled to the device
const view = { w: 0, h: 0 };

interface Treat {
  x: number;
  y: number;
  age: number;
}

const treats: Treat[] = [];

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const treat of treats) {
    treat.x = Math.min(view.w - 30, Math.max(30, treat.x));
    treat.y = Math.min(view.h - 30, Math.max(30, treat.y));
  }
}
window.addEventListener('resize', resize);
resize();

const input = createInput();
const pointer = input.state;

if (matchMedia('(pointer: coarse)').matches) {
  hint.textContent = 'touch gently — press and hold, and it may come see you.';
}

// UI elements swallow pointerdown/move so touching them never knocks the glass,
// but pointerup passes through: a canvas-started drag ending on UI must still
// release touch contact
function shieldFromWorld(el: HTMLElement): void {
  for (const type of ['pointerdown', 'pointermove'] as const) {
    el.addEventListener(type, (e) => e.stopPropagation());
  }
}

const toast = document.getElementById('toast') as HTMLDivElement;
const toastReload = document.getElementById('toast-reload') as HTMLButtonElement;
shieldFromWorld(toast);
const updateSW = registerSW({
  onNeedRefresh() {
    toast.hidden = false;
  },
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = (): void => {
      if (navigator.onLine) registration.update().catch(() => {});
    };
    setInterval(check, 15 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  },
});
toastReload.addEventListener('click', () => void updateSW(true));

// ------------------------------------------------------------------ treats

const TREAT_LIFE = 60;
const TREAT_CAP = 3;
let treatArmed = false;

const treatButton = document.getElementById('treat-button') as HTMLButtonElement;
shieldFromWorld(treatButton);
treatButton.addEventListener('click', () => {
  if (treats.length >= TREAT_CAP) return;
  treatArmed = !treatArmed;
  document.body.classList.toggle('treat-armed', treatArmed);
});

function dropTreat(x: number, y: number): void {
  if (treats.length >= TREAT_CAP) return;
  // keep treats where a pip can physically reach them
  treats.push({
    x: Math.min(view.w - 30, Math.max(30, x)),
    y: Math.min(view.h - 30, Math.max(30, y)),
    age: 0,
  });
  treatArmed = false;
  document.body.classList.remove('treat-armed');
}

function updateTreats(dt: number): void {
  for (let i = treats.length - 1; i >= 0; i--) {
    treats[i].age += dt;
    if (treats[i].age > TREAT_LIFE) treats.splice(i, 1);
  }
  treatButton.disabled = treats.length >= TREAT_CAP;
}

function nearestTreatTo(x: number, y: number): { treat: Treat; dist: number } | null {
  let best: { treat: Treat; dist: number } | null = null;
  for (const treat of treats) {
    const dist = Math.hypot(treat.x - x, treat.y - y);
    if (!best || dist < best.dist) best = { treat, dist };
  }
  return best;
}

// ------------------------------------------------------------------ the pips

interface Vec {
  x: number;
  y: number;
}

type Quirk = 'yawn' | 'stretch' | 'lookAround' | 'wiggle' | 'sniff';

const QUIRK_SECONDS: Record<Quirk, number> = {
  yawn: 1.4,
  stretch: 1.1,
  lookAround: 1.6,
  wiggle: 0.9,
  sniff: 0.8,
};

interface Pip {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  state: CritterState;
  stateTime: number;
  genes: Genes;
  moods: Moods;
  needs: Needs;
  disp: Dispositions;
  places: number[];
  wanderTarget: Vec | null;
  pauseFor: number;
  blinkIn: number;
  emote: string;
  emoteFor: number;
  quirk: Quirk | null;
  quirkFor: number;
  munchFor: number;
  munchTarget: Treat | null;
  antenna: { x: number; y: number; vx: number; vy: number };
}

function makePip(genes: Genes, x: number, y: number): Pip {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    facing: 1,
    state: 'wander',
    stateTime: 0,
    genes,
    moods: { fear: 0, curiosity: 0, trust: 0.5 },
    needs: { ...FRESH_NEEDS },
    disp: { ...FRESH_DISPOSITIONS },
    places: freshPlaces(),
    wanderTarget: null,
    pauseFor: 0,
    blinkIn: 1.5 + Math.random() * 3,
    emote: '',
    emoteFor: 0,
    quirk: null,
    quirkFor: 0,
    munchFor: 0,
    munchTarget: null,
    antenna: { x, y: y - 42, vx: 0, vy: 0 },
  };
}

function randomSpot(): Vec {
  return {
    x: 80 + Math.random() * Math.max(0, view.w - 160),
    y: 80 + Math.random() * Math.max(0, view.h - 160),
  };
}

const pips: Pip[] = [];
let selected = 0;

function snapshotWorld(): LivePip[] {
  return pips.map((pip) => ({
    genes: pip.genes,
    trust: pip.moods.trust,
    needs: pip.needs,
    pos: { x: pip.x, y: pip.y },
    disp: pip.disp,
    places: pip.places,
  }));
}

const params = new URLSearchParams(location.search);
// dev knob: ?reset abandons the saved world (the installed app shares this
// origin's storage, so a browser-tab reset wipes the PWA's world too)
if (params.has('reset')) clearSave();

// the same pips, and how far you got with them, survive the refresh
const saved = loadSave();
if (saved) {
  for (const entry of saved.pips) {
    const spot = entry.pos
      ? {
          x: Math.min(view.w - 26, Math.max(26, entry.pos.x)),
          y: Math.min(view.h - 26, Math.max(26, entry.pos.y)),
        }
      : randomSpot();
    const pip = makePip(entry.genes, spot.x, spot.y);
    pip.moods.trust = entry.trust;
    pip.needs = entry.needs;
    pip.disp = entry.disp;
    pip.places = entry.places;
    pips.push(pip);
  }
} else {
  pips.push(makePip(descend(FOUNDER, 6), view.w / 2, view.h / 2));
  storeSave(snapshotWorld());
}

// dev knob until mitosis: ?flock=N tops the roster up with fresh descendants
const flockWanted = Number(params.get('flock'));
if (Number.isFinite(flockWanted) && flockWanted >= 2) {
  const cap = Math.min(12, Math.floor(flockWanted));
  while (pips.length < cap) {
    const spot = randomSpot();
    pips.push(makePip(descend(FOUNDER, 6), spot.x, spot.y));
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') storeSave(snapshotWorld());
});
window.addEventListener('pagehide', () => storeSave(snapshotWorld()));

function distToPointerOf(pip: Pip): number {
  return Math.hypot(pointer.x - pip.x, pointer.y - pip.y);
}

// panic radiates downhill: only a MORE frightened neighbor is alarming, and only
// by the fear gap — so a mutual panic always drains instead of self-sustaining
function alarmNear(self: Pip): number {
  let worst = 0;
  for (const other of pips) {
    if (other === self) continue;
    if (other.state !== 'flee' && other.state !== 'cower') continue;
    const d = Math.hypot(other.x - self.x, other.y - self.y);
    const gap = other.moods.fear - self.moods.fear;
    worst = Math.max(worst, gap * Math.max(0, 1 - d / 240));
  }
  return worst;
}

function sensesFor(pip: Pip): Senses {
  const treat = nearestTreatTo(pip.x, pip.y);
  return {
    presence: pointer.presence,
    dist: distToPointerOf(pip),
    speed: pointer.speed,
    stillFor: pointer.stillFor,
    treatDist: treat ? treat.dist : Infinity,
    place: placeAt(pip.places, pip.x / view.w, pip.y / view.h),
    alarm: alarmNear(pip),
  };
}

function showEmote(pip: Pip, symbol: string): void {
  pip.emote = symbol;
  pip.emoteFor = 1.2;
}

// ------------------------------------------------------------------ movement

function steerToward(pip: Pip, tx: number, ty: number, accel: number, maxSpeed: number, dt: number, sulkFactor: number): void {
  const zip = lerp(0.85, 1.15, pip.genes.liveliness) * lerp(1, 0.8, sulkFactor);
  const a = accel * zip;
  const cap = maxSpeed * zip;
  const dx = tx - pip.x;
  const dy = ty - pip.y;
  const d = Math.hypot(dx, dy);
  if (d > 1) {
    pip.vx += (dx / d) * a * dt;
    pip.vy += (dy / d) * a * dt;
  }
  const sp = Math.hypot(pip.vx, pip.vy);
  if (sp > cap) {
    pip.vx = (pip.vx / sp) * cap;
    pip.vy = (pip.vy / sp) * cap;
  }
}

function settle(pip: Pip, dt: number, rate: number): void {
  const k = Math.max(0, 1 - rate * dt);
  pip.vx *= k;
  pip.vy *= k;
}

function act(pip: Pip, dt: number, t: number, expressed: Genes, sulkFactor: number): void {
  const dist = distToPointerOf(pip);
  const space = personalSpace(pip.moods.trust, expressed);

  switch (pip.state) {
    case 'wander': {
      if (pip.pauseFor > 0) {
        pip.pauseFor -= dt;
        settle(pip, dt, 4);
        break;
      }
      let wt = pip.wanderTarget;
      if (!wt || Math.hypot(wt.x - pip.x, wt.y - pip.y) < 20) {
        // sample a few spots and prefer the fondest-remembered ground
        const roll = (): Vec => ({
          x: 60 + Math.random() * Math.max(0, view.w - 120),
          y: 60 + Math.random() * Math.max(0, view.h - 120),
        });
        let pick = roll();
        let bestFeel = placeAt(pip.places, pick.x / view.w, pick.y / view.h);
        for (let i = 0; i < 3; i++) {
          const cand = roll();
          const feel = placeAt(pip.places, cand.x / view.w, cand.y / view.h);
          if (feel > bestFeel) {
            bestFeel = feel;
            pick = cand;
          }
        }
        wt = pick;
        pip.wanderTarget = wt;
        if (Math.random() < 0.4) pip.pauseFor = 1 + Math.random() * 2.5;
      }
      steerToward(pip, wt.x, wt.y, 300, 60, dt, sulkFactor);
      break;
    }
    case 'curious': {
      // creeps closer in fits and starts, stopping at a respectful distance
      const stepping = Math.sin(pip.stateTime * 2.4) > -0.2;
      if (dist > space && stepping) steerToward(pip, pointer.x, pointer.y, 260, 75, dt, sulkFactor);
      else settle(pip, dt, 5);
      if (pip.stateTime < 0.05) showEmote(pip, '?');
      break;
    }
    case 'follow': {
      if (dist > space + 26) steerToward(pip, pointer.x, pointer.y, 500, 210, dt, sulkFactor);
      else settle(pip, dt, 4);
      break;
    }
    case 'flee': {
      const away = Math.atan2(pip.y - pointer.y, pip.x - pointer.x);
      const wobble = Math.sin(t * 9) * 0.5;
      steerToward(
        pip,
        pip.x + Math.cos(away + wobble) * 100,
        pip.y + Math.sin(away + wobble) * 100,
        900, 330, dt, sulkFactor);
      break;
    }
    case 'cower':
      settle(pip, dt, 10);
      break;
    case 'snuggle': {
      if (dist > space * 0.8) steerToward(pip, pointer.x, pointer.y, 120, 40, dt, sulkFactor);
      else settle(pip, dt, 3);
      if (pip.emoteFor <= 0 && Math.random() < dt / 2) showEmote(pip, '♥');
      // shared warmth suffuses the spot itself
      pip.places = markPlace(pip.places, pip.x / view.w, pip.y / view.h, dt * 0.012);
      break;
    }
    case 'snack': {
      const target = nearestTreatTo(pip.x, pip.y);
      if (!target) {
        pip.munchTarget = null;
        settle(pip, dt, 4);
        break;
      }
      if (target.treat !== pip.munchTarget) {
        pip.munchTarget = target.treat;
        pip.munchFor = 0;
      }
      if (target.dist > 18) {
        pip.munchFor = 0;
        steerToward(pip, target.treat.x, target.treat.y, 320, 130, dt, sulkFactor);
      } else {
        settle(pip, dt, 8);
        pip.munchFor += dt;
        if (pip.munchFor >= 1.2) {
          // a good meal warms the memory of where it happened
          pip.places = markPlace(pip.places, target.treat.x / view.w, target.treat.y / view.h, 0.2);
          treats.splice(treats.indexOf(target.treat), 1);
          pip.needs = eat(pip.needs);
          pip.moods = { ...pip.moods, trust: clamp01(pip.moods.trust + 0.03) };
          pip.munchFor = 0;
          pip.munchTarget = null;
          showEmote(pip, '♥');
        }
      }
      break;
    }
    case 'sleep':
      settle(pip, dt, 3);
      if (pip.emoteFor <= 0 && Math.random() < dt / 3) showEmote(pip, 'z');
      break;
    default: {
      const unhandled: never = pip.state;
      throw new Error(`unhandled state: ${String(unhandled)}`);
    }
  }

  // pips are solid-ish: overlapping neighbors push each other apart
  for (const other of pips) {
    if (other === pip) continue;
    const dx = pip.x - other.x;
    const dy = pip.y - other.y;
    const d = Math.hypot(dx, dy);
    if (d > 0 && d < 44) {
      const push = ((44 - d) / 44) * 220 * dt;
      pip.vx += (dx / d) * push;
      pip.vy += (dy / d) * push;
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

function updateAntenna(pip: Pip, dt: number, sulkFactor: number): void {
  const a = pip.antenna;
  const droop = sulkFactor * 14;
  a.vx += (pip.x - pip.facing * 4 - a.x) * 60 * dt;
  a.vy += (pip.y - 42 + droop - a.y) * 60 * dt;
  a.vx *= Math.max(0, 1 - 6 * dt);
  a.vy *= Math.max(0, 1 - 6 * dt);
  a.x += a.vx * dt;
  a.y += a.vy * dt;
}

function inIdleState(pip: Pip): boolean {
  return pip.state === 'wander' || pip.state === 'curious' || pip.state === 'snuggle';
}

function maybeStartQuirk(pip: Pip, dt: number): void {
  if (!inIdleState(pip) || Math.hypot(pip.vx, pip.vy) >= 30) return;
  if (Math.random() > dt / lerp(9, 4, pip.genes.liveliness)) return;
  const options: Quirk[] = ['stretch', 'lookAround', 'sniff'];
  if (pip.moods.fear < 0.1) options.push('yawn');
  if (pip.state === 'snuggle' || pip.moods.trust > 0.7) options.push('wiggle');
  pip.quirk = options[Math.floor(Math.random() * options.length)];
  pip.quirkFor = QUIRK_SECONDS[pip.quirk];
}

function sulkOf(happiness: number): number {
  return happiness < 0.35 ? 1 - happiness / 0.35 : 0;
}

function updateTimers(pip: Pip, dt: number, sulkFactor: number): void {
  pip.emoteFor = Math.max(0, pip.emoteFor - dt);
  pip.blinkIn -= dt;
  if (pip.blinkIn < -0.12) pip.blinkIn = 1.5 + Math.random() * 4;
  if (pip.quirk) {
    if (!inIdleState(pip)) {
      pip.quirk = null; // a scare or sleep interrupts whatever it was doing
    } else {
      pip.quirkFor -= dt;
      if (pip.quirkFor <= 0) pip.quirk = null;
    }
  } else {
    maybeStartQuirk(pip, dt);
  }
  // a hungry pip thinks about berries; a miserable one trails off
  if (pip.emoteFor <= 0 && pip.state !== 'sleep') {
    if (pip.needs.food < 0.3 && Math.random() < dt / 6) showEmote(pip, '●');
    else if (sulkFactor > 0.5 && Math.random() < dt / 8) showEmote(pip, '…');
  }
}

// ------------------------------------------------------------------ drawing

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

function drawTreats(t: number): void {
  for (const treat of treats) {
    const pop = Math.min(1, treat.age / 0.3);
    const fade = Math.min(1, (TREAT_LIFE - treat.age) / 5);
    const r = 5 * Math.sin(pop * Math.PI * 0.5);
    ctx.globalAlpha = fade;
    ctx.fillStyle = '#e05c6e';
    ctx.beginPath();
    ctx.arc(treat.x, treat.y + Math.sin(t * 3 + treat.x) * 1.2, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7fce9a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(treat.x, treat.y - r + Math.sin(t * 3 + treat.x) * 1.2);
    ctx.lineTo(treat.x + 3, treat.y - r - 4 + Math.sin(t * 3 + treat.x) * 1.2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// genetic base color with relative mood tinting: fear cools and washes out,
// snuggling warms, misery grays everything down
function bodyColorOf(pip: Pip, sulkFactor: number): string {
  const g = pip.genes;
  const fear = pip.moods.fear;
  let h = hueShift(g.hue, 250, fear * 0.4);
  let s = g.sat * (1 - fear * 0.35) * lerp(1, 0.55, sulkFactor);
  const l = g.light + fear * 5 - sulkFactor * 4;
  if (pip.state === 'snuggle') {
    h = hueShift(h, 30, 0.35);
    s = Math.min(90, s + 12);
  }
  return `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
}

const EMOTE_COLORS: Record<string, string> = { '♥': '#ff8fa3', '●': '#e05c6e' };

function drawPip(pip: Pip, t: number, isSelected: boolean, sulkFactor: number): void {
  const speed = Math.hypot(pip.vx, pip.vy);
  const asleep = pip.state === 'sleep';
  const trembling = pip.state === 'cower' ? 1 : pip.moods.fear > 0.5 ? 0.4 : 0;
  const jx = (Math.random() - 0.5) * 4 * trembling;
  const jy = (Math.random() - 0.5) * 4 * trembling;

  // idle quirks nudge the pose
  let stretchPose = 0;
  let jiggle = 0;
  let sweepLook: number | null = null;
  let mouthOpen = 0;
  if (pip.quirk) {
    const p = 1 - pip.quirkFor / QUIRK_SECONDS[pip.quirk];
    const arc = Math.sin(p * Math.PI);
    switch (pip.quirk) {
      case 'yawn':
        mouthOpen = arc;
        break;
      case 'stretch':
        stretchPose = arc * 0.16;
        break;
      case 'lookAround':
        sweepLook = Math.sin(p * Math.PI * 2) * 3;
        break;
      case 'wiggle':
        jiggle = Math.sin(p * Math.PI * 6) * 2.5;
        break;
      case 'sniff':
        jiggle = Math.sin(p * Math.PI * 10) * 0.8;
        break;
      default: {
        const unhandled: never = pip.quirk;
        throw new Error(`unhandled quirk: ${String(unhandled)}`);
      }
    }
  }
  // munching: happy little chews
  if (pip.state === 'snack' && pip.munchFor > 0) {
    mouthOpen = Math.abs(Math.sin(pip.munchFor * Math.PI * 4)) * 0.6;
  }

  const bob = asleep
    ? Math.sin(t * 2) * 1.5
    : Math.sin(t * (6 + speed / 40)) * Math.min(3, 1 + speed / 80);
  const x = pip.x + jx + jiggle;
  const y = pip.y + jy + bob;

  const R = 24;
  const stretch = Math.min(0.22, speed / 900);
  const sx = (1 + stretch) * (1 - stretchPose * 0.35);
  const sy = (1 - stretch) * (asleep ? 1 + Math.sin(t * 2) * 0.04 : 1) * (1 + stretchPose);
  const squish = pip.state === 'cower' ? 0.78 : 1;
  const color = bodyColorOf(pip, sulkFactor);

  // the watcher's quiet mark on whoever they are watching — pips can't sense it
  if (isSelected) {
    ctx.strokeStyle = 'rgba(223, 232, 240, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(pip.x, pip.y + 4, R * 1.7, 0, Math.PI * 2);
    ctx.stroke();
  }

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
  if (pip.state === 'snack') {
    const target = nearestTreatTo(pip.x, pip.y);
    if (target) {
      const a = Math.atan2(target.treat.y - y, target.treat.x - x);
      lookX = Math.cos(a) * 2.8;
      lookY = Math.sin(a) * 2.8;
    }
  }
  if (sweepLook !== null) {
    lookX = sweepLook;
    lookY = 0;
  }
  const blinking = pip.blinkIn < 0 || mouthOpen > 0.35;
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

  // mouth (yawns and munching)
  if (mouthOpen > 0.05) {
    ctx.fillStyle = '#1c2733';
    ctx.beginPath();
    ctx.ellipse(x, eyeY + 10, 3.5, 2 + mouthOpen * 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // emote bubble
  if (pip.emoteFor > 0) {
    const rise = (1.2 - pip.emoteFor) * 12;
    ctx.globalAlpha = Math.min(1, pip.emoteFor / 0.4);
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = EMOTE_COLORS[pip.emote] ?? '#dfe8f0';
    ctx.fillText(pip.emote, x + 16, y - R - 14 - rise);
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ selection

const roster = document.getElementById('roster') as HTMLDivElement;
shieldFromWorld(roster);
let rosterBuiltFor = -1;

function rebuildRoster(): void {
  roster.replaceChildren();
  pips.forEach((pip, i) => {
    const dot = document.createElement('button');
    dot.className = 'dot';
    dot.style.background = `hsl(${pip.genes.hue}, ${pip.genes.sat}%, ${pip.genes.light}%)`;
    dot.setAttribute('aria-label', `pip ${i + 1}`);
    dot.addEventListener('click', () => {
      selected = i;
    });
    roster.append(dot);
  });
  rosterBuiltFor = pips.length;
}

function updateRoster(): void {
  if (rosterBuiltFor !== pips.length) rebuildRoster();
  roster.hidden = pips.length < 2;
  for (const [i, dot] of [...roster.children].entries()) {
    dot.classList.toggle('selected', i === selected);
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  // Tab keeps its focus-traversal job while the toast is up or there is no flock
  if (e.key === 'Tab' && (!toast.hidden || pips.length < 2)) return;
  e.preventDefault();
  const step = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
  selected = (selected + step + pips.length) % pips.length;
});

// ------------------------------------------------------------------ hud & loop

const MOOD_LABELS: Record<CritterState, string> = {
  wander: 'moseying about',
  curious: 'intrigued…',
  follow: 'tagging along',
  flee: 'nope nope nope',
  cower: 'too scared to move',
  snuggle: 'happy near you',
  snack: 'munch munch',
  sleep: 'fast asleep',
};

function natureLabel(g: Genes): string {
  const parts: string[] = [];
  if (g.boldness > 0.65) parts.push('bold');
  else if (g.boldness < 0.35) parts.push('timid');
  if (g.clinginess > 0.65) parts.push('clingy');
  else if (g.clinginess < 0.35) parts.push('aloof');
  if (g.nosiness > 0.65) parts.push('nosy');
  else if (g.nosiness < 0.35) parts.push('indifferent');
  if (g.liveliness > 0.65) parts.push('zippy');
  else if (g.liveliness < 0.35) parts.push('sleepy');
  return parts.length ? parts.join(', ') : 'even-tempered';
}

// what life has made of it, appended to what it was born as
function temperSuffix(d: Dispositions): string {
  const parts: string[] = [];
  if (d.wariness > 0.7) parts.push('scarred');
  else if (d.wariness > 0.4) parts.push('wary');
  if (d.attachment > 0.7) parts.push('devoted');
  else if (d.attachment > 0.4) parts.push('fond');
  return parts.length ? ' · ' + parts.join(', ') : '';
}

function meter(v: number): string {
  const n = Math.round(clamp01(v) * 8);
  return '▰'.repeat(n) + '▱'.repeat(8 - n);
}

function updateHud(): void {
  const pip = pips[selected];
  if (!pip) {
    hud.textContent = '';
    return;
  }
  const happiness = happinessOf(pip.needs, pip.moods.trust, pip.moods.fear);
  const who = pips.length > 1 ? `pip ${selected + 1}/${pips.length}` : 'pip';
  hud.textContent =
    `${who}: ${MOOD_LABELS[pip.state]}\n` +
    `nature    ${natureLabel(pip.genes)}${temperSuffix(pip.disp)}\n` +
    `mood      ${meter(happiness)}\n` +
    `trust     ${meter(pip.moods.trust)}\n` +
    `fear      ${meter(pip.moods.fear)}\n` +
    `curiosity ${meter(pip.moods.curiosity)}\n` +
    `food      ${meter(pip.needs.food)}\n` +
    `rest      ${meter(pip.needs.rest)}\n` +
    `fun       ${meter(pip.needs.fun)}`;
}

let last = performance.now();
let playedFor = 0;
let sinceSave = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000) || 0.016;
  last = now;
  const t = now / 1000;

  input.update(dt);
  updateTreats(dt);

  sinceSave += dt;
  if (sinceSave >= 10) {
    sinceSave = 0;
    storeSave(snapshotWorld());
  }

  const knocks = input.takeKnocks();
  // captured before knocks land, so a click-spike still reads as a fear
  // crossing and scars the place where it happened
  const fearAtFrameStart = pips.map((pip) => pip.moods.fear);
  for (const k of knocks) {
    if (treatArmed) {
      dropTreat(k.x, k.y);
      break; // discard this frame's remaining knocks — feeding intent shouldn't startle
    }
    for (const pip of pips) {
      const before = pip.moods.fear;
      const expressed = effectiveGenes(pip.genes, pip.disp);
      pip.moods = knock(pip.moods, expressed, Math.hypot(k.x - pip.x, k.y - pip.y), k.strength);
      if (pip.moods.fear > before) showEmote(pip, '!');
    }
  }

  for (const [i, pip] of pips.entries()) {
    const expressed = effectiveGenes(pip.genes, pip.disp);
    const senses = sensesFor(pip);

    const beforeFear = pip.moods.fear;
    pip.moods = updateMoods(pip.moods, expressed, senses, dt);
    if (pip.moods.fear > 0.3 && beforeFear <= 0.3) showEmote(pip, '!');

    const decision = chooseState(pip.state, pip.moods, pip.needs, expressed, senses);
    pip.moods = decision.moods;
    if (decision.startled) showEmote(pip, '!');
    if (decision.state !== pip.state) {
      pip.state = decision.state;
      pip.stateTime = 0;
      pip.munchFor = 0;
      pip.munchTarget = null;
    }
    pip.stateTime += dt;

    pip.needs = tickNeeds(pip.needs, pip.state, Math.hypot(pip.vx, pip.vy), dt);
    const happiness = happinessOf(pip.needs, pip.moods.trust, pip.moods.fear);
    const sulkFactor = sulkOf(happiness);

    // terror leaves marks: on the self, and on the place where it happened
    pip.disp = learn(pip.disp, pip.moods.fear, happiness, dt);
    pip.places = fadePlaces(pip.places, dt);
    if (pip.moods.fear > 0.6 && fearAtFrameStart[i] <= 0.6) {
      pip.places = markPlace(pip.places, pip.x / view.w, pip.y / view.h, -0.34);
    }

    act(pip, dt, t, expressed, sulkFactor);
    updateAntenna(pip, dt, sulkFactor);
    updateTimers(pip, dt, sulkFactor);
  }

  ctx.clearRect(0, 0, view.w, view.h);
  drawTouchGhost();
  drawTreats(t);
  for (const [i, pip] of pips.entries()) {
    const sulkFactor = sulkOf(happinessOf(pip.needs, pip.moods.trust, pip.moods.fear));
    drawPip(pip, t, i === selected && pips.length > 1, sulkFactor);
  }

  updateRoster();
  updateHud();

  if (pointer.presence > 0.9 && playedFor < 9) {
    playedFor += dt;
    if (playedFor >= 9) hint.classList.add('hidden');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
