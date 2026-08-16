import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { clamp01, lerp } from './math.ts';
import { hueShift, type Genes } from './genes.ts';
import { annotate, decode, drift, FOUNDER_STRAND, type DnaStat, type StrandSpanKind } from './dna.ts';
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
  isHealing,
  learn,
  markPlace,
  placeAt,
  WARY_AT,
  type Dispositions,
} from './dispositions.ts';
import { createInput } from './input.ts';
import { makeName } from './names.ts';
import { clearSave, loadSave, MAX_SAVED_PIPS, storeSave, type LivePip } from './save.ts';
import { splitChance, splitOutcome, SPLIT_COOLDOWN } from './mitosis.ts';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hint = document.getElementById('hint') as HTMLDivElement;

// logical viewport in CSS px; the canvas backing store is scaled to the device
const view = { w: 0, h: 0, dpr: 1 };

// the meadow is bigger than the window: pips roam the world, and the camera's
// job is to always keep the whole family in frame
const WORLD_SCALE = 2.5;
const world = { w: 0, h: 0 };
const camera = { x: 0, y: 0, scale: 1 };

// faint world-anchored specks give the eye something to measure zoom against;
// a resize rescales them in place so the reference never flickers mid-drag
let specks: { x: number; y: number }[] = [];
function scatterSpecks(oldW: number, oldH: number): void {
  if (specks.length > 0 && oldW > 0 && oldH > 0) {
    for (const s of specks) {
      s.x = (s.x / oldW) * world.w;
      s.y = (s.y / oldH) * world.h;
    }
    return;
  }
  specks = Array.from({ length: 70 }, () => ({
    x: Math.random() * world.w,
    y: Math.random() * world.h,
  }));
}

function toWorld(sx: number, sy: number): { x: number; y: number } {
  return {
    x: camera.x + (sx - view.w / 2) / camera.scale,
    y: camera.y + (sy - view.h / 2) / camera.scale,
  };
}

// the ghost's position in the pips' world; presence/speed stay screen-truth
// (gentleness is about how softly the HAND moves, at any zoom)
const wp = { x: 0, y: 0 };

interface Treat {
  x: number;
  y: number;
  age: number;
  eater: Pip | null;
}

const treats: Treat[] = [];

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  view.dpr = dpr;
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  const oldW = world.w;
  const oldH = world.h;
  world.w = view.w * WORLD_SCALE;
  world.h = view.h * WORLD_SCALE;
  scatterSpecks(oldW, oldH);
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const treat of treats) {
    treat.x = Math.min(world.w - 30, Math.max(30, treat.x));
    treat.y = Math.min(world.h - 30, Math.max(30, treat.y));
  }
  if (camera.x === 0 && camera.y === 0) {
    camera.x = world.w / 2;
    camera.y = world.h / 2;
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
const TREAT_CAP = 100;
const SPLIT_SWELL_S = 1.4;
// starving is loud long before it is final: the fade begins two sim-minutes in,
// the poof lands at three — and only ever while the player is present, since
// blur/hidden freeze the world entirely
const STARVE_FADE_AT = 120;
const STARVE_POOF_AT = 180;
const POOF_S = 0.9;
let treatArmed = false;

const treatButton = document.getElementById('treat-button') as HTMLButtonElement;
shieldFromWorld(treatButton);

// feeding at flock scale: hold F (desktop) to rain berries where you drag,
// hold the berry button (touch) to rain them across what the camera can see.
// a quick tap on the button still arms one precise berry
const RAIN_EVERY = 0.08;
let fRainHeld = false;
let buttonRainHeld = false;
let rainTimer = 0;
let suppressArmClick = false;
let holdTimer: number | null = null;

treatButton.addEventListener('pointerdown', () => {
  suppressArmClick = false;
  holdTimer = window.setTimeout(() => {
    buttonRainHeld = true;
    suppressArmClick = true;
    document.body.classList.add('raining');
  }, 350);
});
function endButtonRain(): void {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  buttonRainHeld = false;
  document.body.classList.remove('raining');
}
window.addEventListener('pointerup', endButtonRain);
window.addEventListener('pointercancel', endButtonRain);
window.addEventListener('keyup', (e) => {
  if (e.key === 'f' || e.key === 'F') fRainHeld = false;
});

treatButton.addEventListener('click', () => {
  if (suppressArmClick) {
    suppressArmClick = false;
    return;
  }
  if (treats.length >= TREAT_CAP) return;
  treatArmed = !treatArmed;
  document.body.classList.toggle('treat-armed', treatArmed);
});

function dropTreat(x: number, y: number): void {
  if (treats.length >= TREAT_CAP) return;
  // keep treats where a pip can physically reach them
  treats.push({
    x: Math.min(world.w - 30, Math.max(30, x)),
    y: Math.min(world.h - 30, Math.max(30, y)),
    age: 0,
    eater: null,
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

// the family portrait rule: frame every pip with breathing room, zoom clamped
// between today's intimacy (1) and the whole-world view, and always ease there
function updateCamera(dt: number): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pip of pips) {
    minX = Math.min(minX, pip.x);
    maxX = Math.max(maxX, pip.x);
    minY = Math.min(minY, pip.y);
    maxY = Math.max(maxY, pip.y);
  }
  const M = 90;
  const fitScale = Math.min(view.w / (maxX - minX + M * 2), view.h / (maxY - minY + M * 2));
  const wholeWorld = Math.max(view.w / world.w, view.h / world.h);
  const targetScale = Math.min(1, Math.max(wholeWorld, fitScale));
  const ease = Math.min(1, dt * 2.5);
  camera.scale += (targetScale - camera.scale) * ease;
  camera.x += ((minX + maxX) / 2 - camera.x) * ease;
  camera.y += ((minY + maxY) / 2 - camera.y) * ease;
  // never show past the world's edge, whatever the easing is mid-flight
  const { halfW, halfH } = visibleHalfExtent();
  camera.x = Math.min(world.w - halfW, Math.max(halfW, camera.x));
  camera.y = Math.min(world.h - halfH, Math.max(halfH, camera.y));
}

// half the world-space extent the camera currently shows. The edge clamp above
// and the rain sampler must agree on this rect exactly — the rain-stays-where-
// pips-are guarantee rests on it
function visibleHalfExtent(): { halfW: number; halfH: number } {
  return { halfW: view.w / (2 * camera.scale), halfH: view.h / (2 * camera.scale) };
}

// a berry someone else is already eating is invisible to the search — crowding
// one treat starved everyone (each shove reset the other's chewing progress)
function nearestTreatTo(x: number, y: number, self: Pip | null = null): { treat: Treat; dist: number } | null {
  let best: { treat: Treat; dist: number } | null = null;
  for (const treat of treats) {
    if (treat.eater !== null && treat.eater !== self) continue;
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
  strand: string;
  moods: Moods;
  needs: Needs;
  disp: Dispositions;
  places: number[];
  generation: number;
  name: string;
  grown: number;
  splitFor: number;
  sinceSplit: number;
  starvingFor: number;
  poofFor: number;
  wanderTarget: Vec | null;
  pauseFor: number;
  blinkIn: number;
  emote: string;
  emoteFor: number;
  quirk: Quirk | null;
  quirkFor: number;
  celebrate: boolean;
  munchFor: number;
  munchTarget: Treat | null;
  antenna: { x: number; y: number; vx: number; vy: number };
}

function makePip(genes: Genes, strand: string, x: number, y: number, generation = 0, name = makeName()): Pip {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    facing: 1,
    state: 'wander',
    stateTime: 0,
    genes,
    strand,
    moods: { fear: 0, curiosity: 0, trust: 0.5 },
    needs: { ...FRESH_NEEDS },
    disp: { ...FRESH_DISPOSITIONS },
    places: freshPlaces(),
    generation,
    name,
    grown: 1,
    splitFor: 0,
    // scattered readiness at creation, so a fresh or reloaded flock never
    // arrives synchronized (a newborn's 0 is set by divide)
    sinceSplit: SPLIT_COOLDOWN * (0.35 + Math.random() * 0.65),
    starvingFor: 0,
    poofFor: 0,
    wanderTarget: null,
    pauseFor: 0,
    blinkIn: 1.5 + Math.random() * 3,
    emote: '',
    emoteFor: 0,
    quirk: null,
    quirkFor: 0,
    celebrate: false,
    munchFor: 0,
    munchTarget: null,
    antenna: { x, y: y - 42, vx: 0, vy: 0 },
  };
}

function randomSpot(): Vec {
  return {
    x: 80 + Math.random() * Math.max(0, world.w - 160),
    y: 80 + Math.random() * Math.max(0, world.h - 160),
  };
}

// a pip several unseen generations from the founder: the strand drifts first
// and the stats are read from it — the genome is the only heredity there is
function wanderIn(x: number, y: number): Pip {
  const strand = drift(FOUNDER_STRAND, 6);
  return makePip(decode(strand), strand, x, y);
}

// the goodbye is a soft handful of pastel sparks, never a body
interface Sparkle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  hue: number;
}

const sparkles: Sparkle[] = [];

function spawnSparkles(pip: Pip): void {
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
    sparkles.push({
      x: pip.x,
      y: pip.y,
      vx: Math.cos(a) * (30 + Math.random() * 40),
      vy: Math.sin(a) * (30 + Math.random() * 40) - 20,
      age: 0,
      hue: pip.genes.hue,
    });
  }
}

function updateAndDrawSparkles(dt: number): void {
  for (let i = sparkles.length - 1; i >= 0; i--) {
    const s = sparkles[i];
    s.age += dt;
    if (s.age > 1) {
      sparkles.splice(i, 1);
      continue;
    }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy -= 10 * dt;
    ctx.globalAlpha = 1 - s.age;
    ctx.fillStyle = `hsl(${s.hue.toFixed(1)}, 60%, 80%)`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.2 * (1 - s.age * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function clampToWorld(x: number, y: number, margin = 26): Vec {
  return {
    x: Math.min(world.w - margin, Math.max(margin, x)),
    y: Math.min(world.h - margin, Math.max(margin, y)),
  };
}

const pips: Pip[] = [];

function snapshotWorld(): LivePip[] {
  return pips.map((pip) => ({
    genes: pip.genes,
    strand: pip.strand,
    trust: pip.moods.trust,
    needs: pip.needs,
    pos: { x: pip.x, y: pip.y },
    disp: pip.disp,
    places: pip.places,
    generation: pip.generation,
    name: pip.name,
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
    const spot = entry.pos ? clampToWorld(entry.pos.x, entry.pos.y) : randomSpot();
    const pip = makePip(entry.genes, entry.strand, spot.x, spot.y, entry.generation, entry.name);
    pip.moods.trust = entry.trust;
    pip.needs = entry.needs;
    pip.disp = entry.disp;
    pip.places = entry.places;
    pips.push(pip);
  }
} else {
  pips.push(wanderIn(world.w / 2, world.h / 2));
  storeSave(snapshotWorld());
}

// dev knob: ?flock=N tops the roster up with fresh descendants
const flockWanted = Number(params.get('flock'));
if (Number.isFinite(flockWanted) && flockWanted >= 2) {
  const cap = Math.min(100, Math.floor(flockWanted));
  while (pips.length < cap) {
    const spot = randomSpot();
    const pip = wanderIn(spot.x, spot.y);
    // even minute one is unsynchronized: fresh flocks arrive mid-day, not factory-new
    pip.needs = {
      food: 0.82 + Math.random() * 0.18,
      rest: 0.82 + Math.random() * 0.18,
      fun: 0.55 + Math.random() * 0.3,
    };
    pips.push(pip);
  }
}

// dev knob: ?fecund=N multiplies the split rate for mutation review
const fecund = Math.min(1000, Math.max(1, Number(params.get('fecund')) || 1));

// dev knob: ?famine=N empties bellies and runs the goodbye clock N times
// faster, so a fade and poof can be watched without a real-time vigil
const famine = Math.min(1000, Math.max(1, Number(params.get('famine')) || 1));

let selectedPip: Pip = pips[0];
// bumped on any population change; roster AND census rebuild against it
let flockVersion = 0;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') storeSave(snapshotWorld());
});
window.addEventListener('pagehide', () => storeSave(snapshotWorld()));

// the world holds its breath while you work elsewhere: an unfocused window
// freezes sim time entirely, so stepping away never costs a pip anything
let paused = !document.hasFocus();
window.addEventListener('blur', () => {
  paused = true;
  fRainHeld = false;
  endButtonRain();
  document.body.classList.add('paused');
  storeSave(snapshotWorld());
});
window.addEventListener('focus', () => {
  paused = false;
  document.body.classList.remove('paused');
});
if (paused) document.body.classList.add('paused');

// one pip becomes two: the pure outcome from mitosis.ts, plus the fresh-start
// rule — lifetime scars and place memories do NOT survive a division
function divide(parent: Pip): Pip {
  const [a, b] = splitOutcome({
    strand: parent.strand,
    needs: parent.needs,
    generation: parent.generation,
  });
  const angle = Math.random() * Math.PI * 2;
  const at = clampToWorld(parent.x + Math.cos(angle) * 20, parent.y + Math.sin(angle) * 20);
  const kid = makePip(b.genes, b.strand, at.x, at.y, b.generation);
  kid.needs = b.needs;
  // born unafraid; curiosity and the bond with the watcher carry over
  kid.moods = { fear: 0, curiosity: parent.moods.curiosity, trust: parent.moods.trust };
  kid.grown = 0.65;
  kid.sinceSplit = 0;
  kid.vx = parent.vx + Math.cos(angle) * 70;
  kid.vy = parent.vy + Math.sin(angle) * 70;
  parent.genes = a.genes;
  parent.strand = a.strand;
  parent.needs = a.needs;
  parent.generation = a.generation;
  parent.disp = { ...FRESH_DISPOSITIONS };
  parent.places = freshPlaces();
  parent.grown = 0.65;
  parent.sinceSplit = 0;
  parent.vx -= Math.cos(angle) * 70;
  parent.vy -= Math.sin(angle) * 70;
  showEmote(parent, '♥');
  showEmote(kid, '♥');
  return kid;
}

function distToPointerOf(pip: Pip): number {
  return Math.hypot(wp.x - pip.x, wp.y - pip.y);
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
  const treat = nearestTreatTo(pip.x, pip.y, pip);
  return {
    presence: pointer.presence,
    dist: distToPointerOf(pip),
    speed: pointer.speed,
    stillFor: pointer.stillFor,
    treatDist: treat ? treat.dist : Infinity,
    place: placeAt(pip.places, pip.x / world.w, pip.y / world.h),
    alarm: alarmNear(pip),
  };
}

function showEmote(pip: Pip, symbol: string): void {
  pip.emote = symbol;
  pip.emoteFor = 1.2;
}

// ------------------------------------------------------------------ movement

function steerToward(pip: Pip, tx: number, ty: number, accel: number, maxSpeed: number, dt: number, sulkFactor: number): void {
  // a tired pip shuffles: pace fades once rest drops below half
  const shuffle = 0.75 + 0.25 * Math.min(1, pip.needs.rest * 2);
  const zip = lerp(0.85, 1.15, pip.genes.liveliness) * lerp(1, 0.8, sulkFactor) * shuffle;
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
          x: 60 + Math.random() * Math.max(0, world.w - 120),
          y: 60 + Math.random() * Math.max(0, world.h - 120),
        });
        let pick = roll();
        let bestFeel = placeAt(pip.places, pick.x / world.w, pick.y / world.h);
        for (let i = 0; i < 3; i++) {
          const cand = roll();
          const feel = placeAt(pip.places, cand.x / world.w, cand.y / world.h);
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
      if (dist > space && stepping) steerToward(pip, wp.x, wp.y, 260, 75, dt, sulkFactor);
      else settle(pip, dt, 5);
      if (pip.stateTime < 0.05) showEmote(pip, '?');
      break;
    }
    case 'follow': {
      if (dist > space + 26) steerToward(pip, wp.x, wp.y, 500, 210, dt, sulkFactor);
      else settle(pip, dt, 4);
      break;
    }
    case 'flee': {
      const away = Math.atan2(pip.y - wp.y, pip.x - wp.x);
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
      if (dist > space * 0.8) steerToward(pip, wp.x, wp.y, 120, 40, dt, sulkFactor);
      else settle(pip, dt, 3);
      if (pip.emoteFor <= 0 && Math.random() < dt / 2) showEmote(pip, '♥');
      // shared warmth suffuses the spot itself
      pip.places = markPlace(pip.places, pip.x / world.w, pip.y / world.h, dt * 0.012);
      break;
    }
    case 'snack': {
      const target = nearestTreatTo(pip.x, pip.y, pip);
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
        // jostled out of range: chewing pauses but progress survives
        steerToward(pip, target.treat.x, target.treat.y, 320, 130, dt, sulkFactor);
      } else {
        target.treat.eater = pip;
        settle(pip, dt, 8);
        pip.munchFor += dt;
        if (pip.munchFor >= 1.2) {
          // a good meal warms the memory of where it happened
          pip.places = markPlace(pip.places, target.treat.x / world.w, target.treat.y / world.h, 0.2);
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
  if (pip.x > world.w - m) pip.vx -= (pip.x - (world.w - m)) * 60 * dt;
  if (pip.y < m) pip.vy += (m - pip.y) * 60 * dt;
  if (pip.y > world.h - m) pip.vy -= (pip.y - (world.h - m)) * 60 * dt;

  pip.x += pip.vx * dt;
  pip.y += pip.vy * dt;
  const held = clampToWorld(pip.x, pip.y);
  pip.x = held.x;
  pip.y = held.y;

  if (Math.abs(pip.vx) > 5) pip.facing = Math.sign(pip.vx);
}

function updateAntenna(pip: Pip, dt: number, sulkFactor: number): void {
  const a = pip.antenna;
  const droop = sulkFactor * 14;
  a.vx += (pip.x - pip.facing * 4 - a.x) * 60 * dt;
  a.vy += (pip.y - lerp(30, 54, pip.genes.antLength) * pip.grown + droop - a.y) * 60 * dt;
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
  pip.grown = Math.min(1, pip.grown + dt / 30);
  pip.blinkIn -= dt;
  if (pip.blinkIn < -0.12) pip.blinkIn = 1.5 + Math.random() * 4;
  if (pip.celebrate && inIdleState(pip)) {
    pip.celebrate = false;
    showEmote(pip, '♥');
    pip.quirk = 'wiggle';
    pip.quirkFor = QUIRK_SECONDS.wiggle;
  }
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
  // screen-constant radii: the touch player's only affordance must stay findable
  // at any zoom (pip perception uses distances, never this drawing)
  const gr = 26 / camera.scale;
  const glow = ctx.createRadialGradient(wp.x, wp.y, 2 / camera.scale, wp.x, wp.y, gr);
  glow.addColorStop(0, 'rgba(180, 240, 220, 0.8)');
  glow.addColorStop(1, 'rgba(180, 240, 220, 0)');
  ctx.globalAlpha = pointer.presence * 0.35;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(wp.x, wp.y, gr, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = pointer.presence * 0.5;
  ctx.strokeStyle = 'rgba(190, 235, 220, 0.9)';
  ctx.lineWidth = 1.5 / camera.scale;
  ctx.beginPath();
  ctx.arc(wp.x, wp.y, 18 / camera.scale, 0, Math.PI * 2);
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
function bodyColorOf(pip: Pip, sulkFactor: number, hungry: number): string {
  const g = pip.genes;
  const fear = pip.moods.fear;
  let h = hueShift(g.hue, 250, fear * 0.4);
  let s = g.sat * (1 - fear * 0.35) * lerp(1, 0.55, sulkFactor) * (1 - hungry * 0.2);
  const l = g.light + fear * 5 - sulkFactor * 4 - hungry * 3;
  if (pip.state === 'snuggle') {
    h = hueShift(h, 30, 0.35);
    s = Math.min(90, s + 12);
  }
  return `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
}

// an empty belly is worn on the body: sagging posture, damped bounce, dimmer color
function hungerOf(pip: Pip): number {
  return Math.max(0, (0.45 - pip.needs.food) / 0.45);
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

  const hungry = hungerOf(pip);
  const bob = asleep
    ? Math.sin(t * 2) * 1.5
    : Math.sin(t * (6 + speed / 40)) * Math.min(3, 1 + speed / 80) * (1 - hungry * 0.5);
  const x = pip.x + jx + jiggle;
  const y = pip.y + jy + bob + hungry * 2;

  // newborns are small and regrow; a dividing pip swells and shudders
  let swell = 1;
  if (pip.splitFor > 0) {
    const p = 1 - pip.splitFor / SPLIT_SWELL_S;
    swell = 1 + p * 0.18 + Math.sin(p * Math.PI * 8) * 0.06 * p;
  }
  // a poofing pip shrinks away; a long-starving one grows translucent first
  const poofScale = pip.poofFor > 0 ? pip.poofFor / POOF_S : 1;
  let bodyAlpha = 1;
  if (pip.starvingFor > STARVE_FADE_AT) {
    const gone = Math.min(1, (pip.starvingFor - STARVE_FADE_AT) / (STARVE_POOF_AT - STARVE_FADE_AT));
    bodyAlpha = 1 - 0.45 * gone;
    ctx.globalAlpha = bodyAlpha;
  }
  const g = pip.genes;
  const R = 24 * lerp(0.85, 1.15, g.size) * pip.grown * swell * poofScale;
  const stretch = Math.min(0.22, speed / 900);
  // roundness bends the silhouette: low = tall bean, high = wide bun, 0.5 = classic
  const wide = lerp(-0.1, 0.1, g.roundness);
  const sx = (1 + stretch) * (1 - stretchPose * 0.35) * (1 + wide);
  const sy = (1 - stretch) * (asleep ? 1 + Math.sin(t * 2) * 0.04 : 1) * (1 + stretchPose) * (1 - wide);
  const squish = pip.state === 'cower' ? 0.78 : 1;
  const color = bodyColorOf(pip, sulkFactor, hungry);

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
  ctx.arc(pip.antenna.x, pip.antenna.y, lerp(2, 6, g.antTip), 0, Math.PI * 2);
  ctx.fill();

  // body
  ctx.beginPath();
  ctx.ellipse(x, y, R * sx, R * sy * squish, 0, 0, Math.PI * 2);
  ctx.fill();

  // freckles: only past the midpoint band, seeded from the genome so each
  // pip's pattern is its own and never flickers
  if (g.freckles > 0.55) {
    const count = 1 + Math.floor(((g.freckles - 0.55) / 0.45) * 5);
    let seed = Math.floor(g.hue * 7 + g.sat * 13 + g.light * 31 + g.freckles * 97);
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    ctx.fillStyle = `hsl(${g.hue.toFixed(1)}, ${g.sat.toFixed(1)}%, ${Math.max(20, g.light - 18).toFixed(1)}%)`;
    for (let i = 0; i < count; i++) {
      const fx = x + (next() - 0.5) * R * 1.3;
      const fy = y + R * 0.35 + next() * R * 0.4;
      ctx.beginPath();
      ctx.arc(fx, fy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // fondness shows: blush blooms near a trusted watcher, brightest mid-snuggle
  const eyeY = y - 4;
  const distNow = Math.hypot(wp.x - pip.x, wp.y - pip.y);
  const fondness = pip.state === 'snuggle'
    ? 1
    : pointer.presence > 0 && distNow < 260 && pip.moods.trust > 0.6
      ? ((pip.moods.trust - 0.6) / 0.4) * pointer.presence
      : 0;
  if (fondness > 0.05) {
    ctx.fillStyle = `rgba(255, 130, 150, ${(0.4 * fondness).toFixed(3)})`;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + side * 13, eyeY + 8, 4.5, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // eyes — geometry deliberately ignores `grown`: newborns look big-eyed on purpose
  let lookX = 0;
  let lookY = 0;
  if (pointer.presence > 0) {
    const a = Math.atan2(wp.y - y, wp.x - x);
    lookX = Math.cos(a) * 2.8;
    lookY = Math.sin(a) * 2.8;
  }
  if (pip.state === 'snack') {
    const target = nearestTreatTo(pip.x, pip.y, pip);
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
  // tiredness sits on the eyelids: they sink as rest drains
  const lid = Math.max(0, (0.5 - pip.needs.rest) / 0.5) * 0.65;
  const eyeGap = lerp(6.5, 11.5, g.eyeGap);
  for (const side of [-1, 1]) {
    const ex = x + side * eyeGap;
    if (asleep || blinking) {
      ctx.strokeStyle = '#1c2733';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ex, eyeY + 1, 3.5, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      continue;
    }
    const eyeR = lerp(4, 7, g.eyeSize) + pip.moods.fear * 2.5;
    ctx.fillStyle = '#f4f7f5';
    ctx.beginPath();
    ctx.arc(ex, eyeY, eyeR, 0, Math.PI * 2);
    ctx.fill();
    const pupil = Math.max(1.2, Math.min(4.2, 2 + pip.moods.curiosity * 2 - pip.moods.fear * 1.4));
    ctx.fillStyle = '#1c2733';
    ctx.beginPath();
    ctx.arc(ex + lookX, eyeY + lookY, pupil, 0, Math.PI * 2);
    ctx.fill();
    if (lid > 0.02) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(ex, eyeY - eyeR * (2 - 1.7 * lid), eyeR + 1.5, eyeR, 0, 0, Math.PI * 2);
      ctx.fill();
    }
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
    // labels keep their SCREEN size at any zoom — readability over diegesis
    ctx.font = `${16 / camera.scale}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = EMOTE_COLORS[pip.emote] ?? '#dfe8f0';
    ctx.fillText(pip.emote, x + 16 / camera.scale, y - R - (14 + rise) / camera.scale);
  }

  // the name floats above everything the pip is — recognition at a glance,
  // soft enough not to shout over a crowd
  ctx.globalAlpha = bodyAlpha;
  ctx.font = `${10 / camera.scale}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.fillStyle = isSelected ? 'rgba(223, 232, 240, 0.95)' : 'rgba(143, 163, 184, 0.6)';
  ctx.fillText(pip.name, x, y - lerp(30, 54, g.antLength) * pip.grown - 10 / camera.scale);
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ selection

const roster = document.getElementById('roster') as HTMLDivElement;
shieldFromWorld(roster);
let rosterBuiltVersion = -1;
// past this many pips, individual dots are confetti — show a count instead
const ROSTER_DOT_LIMIT = 40;

function dotColor(g: Genes): string {
  return `hsl(${g.hue}, ${g.sat}%, ${g.light}%)`;
}

function rebuildRoster(): void {
  roster.replaceChildren();
  if (pips.length > ROSTER_DOT_LIMIT) {
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${pips.length} pips`;
    roster.append(count);
    return;
  }
  for (const pip of pips) {
    const dot = document.createElement('button');
    dot.className = 'dot';
    dot.style.background = dotColor(pip.genes);
    dot.setAttribute('aria-label', pip.name);
    dot.addEventListener('click', () => {
      selectedPip = pip;
    });
    roster.append(dot);
  }
}

function updateRoster(): void {
  if (rosterBuiltVersion !== flockVersion) {
    rebuildRoster();
    rosterBuiltVersion = flockVersion;
  }
  roster.hidden = pips.length < 2;
  if (pips.length > ROSTER_DOT_LIMIT) return;
  for (const [i, dot] of [...roster.children].entries()) {
    dot.classList.toggle('selected', pips[i] === selectedPip);
  }
}

// ------------------------------------------------------------------ census

const census = document.getElementById('census') as HTMLDivElement;
const censusButton = document.getElementById('census-button') as HTMLButtonElement;
shieldFromWorld(census);
shieldFromWorld(censusButton);
let censusOpen = params.has('census');
let censusBuiltVersion = -1;
let censusRefreshedAt = -1;
censusButton.addEventListener('click', () => {
  censusOpen = !censusOpen;
});

function rebuildCensus(): void {
  census.replaceChildren(dnaPanel);
  for (const pip of pips) {
    const row = document.createElement('button');
    row.className = 'census-row';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = dotColor(pip.genes);
    const label = document.createElement('span');
    row.append(dot, label);
    row.addEventListener('click', () => {
      selectedPip = pip;
    });
    census.append(row);
  }
}

// each trait's census color, grouped by function — personality warm, tempo
// green, looks blue, color pink — so the strand is read by meaning, not letter
const STAT_HUES: Record<DnaStat, number> = {
  boldness: 25,
  clinginess: 45,
  nosiness: 65,
  liveliness: 90,
  metabolism: 120,
  stamina: 140,
  playfulness: 160,
  size: 190,
  roundness: 205,
  antLength: 220,
  antTip: 235,
  eyeSize: 250,
  eyeGap: 265,
  freckles: 280,
  sat: 300,
  light: 315,
  hueX: 330,
  hueY: 345,
};
const SPAN_CLASS: Record<StrandSpanKind, string> = {
  tag: 'dna-tag',
  body: 'dna-body',
  junk: 'dna-junk',
  nearTag: 'dna-near',
};

const statLabel = (stat: string): string => stat.replace(/([A-Z])/g, ' $1').toLowerCase();

const dnaPanel = document.createElement('div');
dnaPanel.id = 'dna';
const dnaTitle = document.createElement('div');
dnaTitle.id = 'dna-title';
const dnaStrand = document.createElement('div');
dnaStrand.id = 'dna-strand';
const dnaLegend = document.createElement('div');
dnaLegend.id = 'dna-legend';
for (const [stat, hue] of Object.entries(STAT_HUES)) {
  const key = document.createElement('span');
  key.className = 'dna-key';
  key.style.setProperty('--h', String(hue));
  key.textContent = statLabel(stat);
  dnaLegend.append(key);
}
dnaPanel.append(dnaTitle, dnaStrand, dnaLegend);

// the selected pip's genome, colored by what each stretch DOES: tag landmarks,
// bodies in their trait's hue, junk dimmed, dormant near-tags shimmering
let dnaShownStrand = '';
function updateDnaPanel(): void {
  dnaTitle.textContent = `${selectedPip.name} · ${selectedPip.strand.length} bases`;
  if (dnaShownStrand === selectedPip.strand) return;
  dnaShownStrand = selectedPip.strand;
  dnaStrand.replaceChildren();
  for (const span of annotate(selectedPip.strand)) {
    const bit = document.createElement('span');
    bit.className = SPAN_CLASS[span.kind];
    if (span.stat !== null) bit.style.setProperty('--h', String(STAT_HUES[span.stat]));
    bit.textContent = selectedPip.strand.slice(span.from, span.to);
    dnaStrand.append(bit);
  }
}

function updateCensus(t: number): void {
  census.hidden = !censusOpen;
  censusButton.classList.toggle('active', censusOpen);
  if (!censusOpen) return;
  if (censusBuiltVersion !== flockVersion) {
    rebuildCensus();
    censusBuiltVersion = flockVersion;
    censusRefreshedAt = -1;
  }
  // rewriting hundreds of rows every frame janks — a few refreshes a second reads the same
  if (t - censusRefreshedAt < 0.25) return;
  censusRefreshedAt = t;
  updateDnaPanel();
  for (const [i, row] of [...census.children].entries()) {
    const pip = pips[i - 1]; // child 0 is the dna panel; rows follow
    if (!pip) continue;
    const happiness = happinessOf(pip.needs, pip.moods.trust, pip.moods.fear);
    (row.lastElementChild as HTMLElement).textContent =
      `${pip.name} · gen ${pip.generation} · ${natureLabel(pip.genes)}${temperSuffix(pip.disp, isHealing(pip.disp, happiness))} · ${meter(happiness)} · ${MOOD_LABELS[pip.state]}`;
    row.classList.toggle('selected', pip === selectedPip);
  }
}

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'c' || e.key === 'C') {
    censusOpen = !censusOpen;
    return;
  }
  if ((e.key === 'f' || e.key === 'F') && pointer.presence > 0) {
    dropTreat(wp.x, wp.y);
    fRainHeld = true;
    return;
  }
  if (e.key !== 'Tab' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  // Tab keeps its focus-traversal job while the toast is up or there is no flock
  if (e.key === 'Tab' && (!toast.hidden || pips.length < 2)) return;
  e.preventDefault();
  const step = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
  const idx = Math.max(0, pips.indexOf(selectedPip));
  selectedPip = pips[(idx + step + pips.length) % pips.length];
});

// ------------------------------------------------------------------ hud & loop

const MOOD_LABELS: Record<CritterState, string> = {
  wander: 'moseying about',
  curious: 'intrigued…',
  follow: 'tagging along',
  flee: 'nope nope nope',
  cower: 'frozen — be gentle',
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
function temperSuffix(d: Dispositions, healing = false): string {
  const parts: string[] = [];
  if (d.wariness > 0.7) parts.push('shy');
  else if (d.wariness > WARY_AT) parts.push('wary');
  if (healing) parts.push('healing');
  if (d.attachment > 0.7) parts.push('devoted');
  else if (d.attachment > 0.4) parts.push('fond');
  return parts.length ? ' · ' + parts.join(', ') : '';
}

function meter(v: number): string {
  const n = Math.round(clamp01(v) * 8);
  return '▰'.repeat(n) + '▱'.repeat(8 - n);
}

let last = performance.now();
let playedFor = 0;
let sinceSave = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000) || 0.016;
  last = now;
  if (paused) {
    requestAnimationFrame(frame);
    return;
  }
  const t = now / 1000;

  input.update(dt);
  {
    const w = toWorld(pointer.x, pointer.y);
    wp.x = w.x;
    wp.y = w.y;
  }
  updateTreats(dt);

  if (fRainHeld || buttonRainHeld) {
    rainTimer -= dt;
    while (rainTimer <= 0) {
      rainTimer += RAIN_EVERY;
      if (fRainHeld && pointer.presence > 0) dropTreat(wp.x, wp.y);
      else if (buttonRainHeld) {
        // rain only where the camera looks: the frame already holds every
        // pip, and a berry outside it would only expire unseen
        const { halfW, halfH } = visibleHalfExtent();
        dropTreat(camera.x - halfW + Math.random() * halfW * 2, camera.y - halfH + Math.random() * halfH * 2);
      }
    }
  } else {
    rainTimer = 0;
  }

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
    const kw = toWorld(k.x, k.y);
    if (treatArmed) {
      dropTreat(kw.x, kw.y);
      break; // discard this frame's remaining knocks — feeding intent shouldn't startle
    }
    for (const pip of pips) {
      const before = pip.moods.fear;
      const expressed = effectiveGenes(pip.genes, pip.disp);
      pip.moods = knock(pip.moods, expressed, Math.hypot(kw.x - pip.x, kw.y - pip.y), k.strength);
      if (pip.moods.fear > before) showEmote(pip, '!');
    }
  }

  const born: Pip[] = [];
  const leaving: Pip[] = [];
  // in-flight swells are committed growth: counting them in the gate means the
  // population can never overshoot the cap while divisions are mid-animation
  let reserved = 0;
  for (const p of pips) if (p.splitFor > 0) reserved++;
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
      for (const treat of treats) {
        if (treat.eater === pip) treat.eater = null;
      }
    }
    pip.stateTime += dt;

    pip.needs = tickNeeds(pip.needs, pip.state, Math.hypot(pip.vx, pip.vy), dt, expressed, famine);
    const happiness = happinessOf(pip.needs, pip.moods.trust, pip.moods.fear);
    const sulkFactor = sulkOf(happiness);

    // terror leaves marks: on the self, and on the place where it happened
    const wasWary = pip.disp.wariness;
    pip.disp = learn(pip.disp, pip.moods.fear, happiness, dt);
    // forgiveness earns a celebration, held until the pip is calm enough to feel it
    if (wasWary >= WARY_AT && pip.disp.wariness < WARY_AT) pip.celebrate = true;
    pip.places = fadePlaces(pip.places, dt);
    if (pip.moods.fear > 0.6 && fearAtFrameStart[i] <= 0.6) {
      pip.places = markPlace(pip.places, pip.x / world.w, pip.y / world.h, -0.34);
    }

    act(pip, dt, t, expressed, sulkFactor);
    updateAntenna(pip, dt, sulkFactor);
    updateTimers(pip, dt, sulkFactor);

    // the gentle goodbye: a long-empty belly fades a pip, and if nobody ever
    // feeds it, it shrinks and poofs into sparkles. any bite cancels everything
    if (pip.needs.food <= 0) pip.starvingFor += dt * famine;
    else pip.starvingFor = 0;
    if (pip.poofFor > 0 && pip.needs.food > 0) {
      pip.poofFor = 0;
      showEmote(pip, '♥');
    } else if (pip.poofFor > 0) {
      pip.poofFor -= dt;
      if (pip.poofFor <= 0) leaving.push(pip);
    } else if (pip.starvingFor >= STARVE_POOF_AT) {
      pip.poofFor = POOF_S;
      showEmote(pip, '✧');
    }

    // mitosis: a hazard rate, not a timer — settled, well-lived pips sometimes
    // just... double
    pip.sinceSplit += dt;
    const settled = pip.state !== 'flee' && pip.state !== 'cower' && pip.state !== 'sleep';
    if (pip.splitFor > 0) {
      if (!settled) {
        pip.splitFor = 0; // a scare aborts the division
        reserved--;
      } else {
        pip.splitFor -= dt;
        if (pip.splitFor <= 0) {
          born.push(divide(pip));
          reserved--;
        }
      }
    } else if (
      settled &&
      pip.poofFor <= 0 &&
      pips.length + born.length + reserved < MAX_SAVED_PIPS &&
      Math.random() < splitChance(happiness, pip.sinceSplit, dt, fecund)
    ) {
      pip.splitFor = SPLIT_SWELL_S;
      reserved++;
    }
  }

  if (leaving.length) {
    for (const pip of leaving) {
      spawnSparkles(pip);
      pips.splice(pips.indexOf(pip), 1);
    }
    // the meadow never stays empty: a new little one wanders in
    if (pips.length === 0) {
      const spot = randomSpot();
      const arrival = wanderIn(spot.x, spot.y);
      showEmote(arrival, '✧');
      pips.push(arrival);
    }
    if (!pips.includes(selectedPip)) selectedPip = pips[0];
    flockVersion++;
    sinceSave = 0;
    storeSave(snapshotWorld());
  }

  if (born.length) {
    pips.push(...born);
    flockVersion++;
    sinceSave = 0;
    storeSave(snapshotWorld());
  }

  updateCamera(dt);
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.setTransform(
    view.dpr * camera.scale, 0, 0, view.dpr * camera.scale,
    view.dpr * (view.w / 2 - camera.x * camera.scale),
    view.dpr * (view.h / 2 - camera.y * camera.scale),
  );
  ctx.fillStyle = 'rgba(96, 116, 136, 0.22)';
  for (const s of specks) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  drawTouchGhost();
  drawTreats(t);
  updateAndDrawSparkles(dt);
  for (const pip of pips) {
    const sulkFactor = sulkOf(happinessOf(pip.needs, pip.moods.trust, pip.moods.fear));
    drawPip(pip, t, pip === selectedPip && pips.length > 1, sulkFactor);
  }

  updateRoster();
  updateCensus(t);

  if (pointer.presence > 0.9 && playedFor < 9) {
    playedFor += dt;
    if (playedFor >= 9) hint.classList.add('hidden');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
