import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { clamp01, lerp } from './math.ts';
import { hueShift, type BerryKind, type Genes } from './genes.ts';
import { LAWS } from './laws.ts';
import {
  annotate,
  decode,
  drift,
  encode,
  enzymesOf,
  forceAppendGrant,
  FOUNDER_STRAND,
  integrateFragment,
  MOB_FLOOR,
  mobilityOf,
  needsEnzymeGrant,
  tryAppendGrant,
  type DnaStat,
  type StrandSpanKind,
} from './dna.ts';
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
import { eldernessOf, lifespanOf } from './aging.ts';
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
import { clearSave, loadSave, MAX_SAVED_PIPS, SAVE_KEYS, storeSave, type FloraSave, type LivePip } from './save.ts';
import { splitChance, splitOutcome, SPLIT_COOLDOWN } from './mitosis.ts';
import { DIAL_FIELDS, DIAL_SPECS, freshDials, loadDials, storeDials, type Dials } from './dials.ts';

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
  // ambient berries carry a color; what a body pulls from one is its own
  // enzymes' business. A gift from the watcher tastes like home to everyone
  kind: BerryKind | 'gift';
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
// what the masthead bothers to print: an enzyme fainter than this is noise
const ENZYME_TRACE_SHOW = 0.05;

// below this digestion a meal is not worth the walk; the gradient's neutral
// plateau ends here, and selection starts feeling the slope
const ENZYME_CHASE_FLOOR = 0.2;
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

// gifts cap separately from the meadow's own berries, so hand-feeding can
// never crowd the ambient growth out of the treat list (or vice versa)
function giftCount(): number {
  let n = 0;
  for (const treat of treats) if (treat.kind === 'gift') n++;
  return n;
}

treatButton.addEventListener('click', () => {
  if (suppressArmClick) {
    suppressArmClick = false;
    return;
  }
  if (giftCount() >= TREAT_CAP) return;
  treatArmed = !treatArmed;
  document.body.classList.toggle('treat-armed', treatArmed);
});

function dropTreat(x: number, y: number): void {
  if (giftCount() >= TREAT_CAP) return;
  // keep treats where a pip can physically reach them
  treats.push({
    x: Math.min(world.w - 30, Math.max(30, x)),
    y: Math.min(world.h - 30, Math.max(30, y)),
    age: 0,
    eater: null,
    kind: 'gift',
  });
  treatArmed = false;
  document.body.classList.remove('treat-armed');
}

// rain only where the camera looks: the frame already holds every pip, and a
// berry outside it would only expire unseen
function dropTreatInView(): void {
  const { halfW, halfH } = visibleHalfExtent();
  dropTreat(camera.x - halfW + Math.random() * halfW * 2, camera.y - halfH + Math.random() * halfH * 2);
}

// ------------------------------------------------------- the living meadow
// food is a loop, not a faucet: pips eat berries and carry the seeds in
// their gut, fallen fruit rots where it lies and sometimes takes root, and
// a thin wind-rain from beyond the meadow keeps every color alive somewhere.
// The ground's carrying capacity — CELL_CAP roots per color per cell — is
// the population ceiling now: land, not a spawn rate. The Phase D sim pins
// a red-only flock near 180, each discovered color adding about as much
const BERRY_KINDS: readonly BerryKind[] = ['red', 'gold', 'blue'];
const SEEDS_PER_BERRY = 2;
const GUT_MIN_S = 30;
const GUT_MAX_S = 90;
const SPROUT_S = 90;
const CELL_CAP = 3;
const ROT_P = 0.55;
// the wind's propagule pressure: seeds arriving from beyond the meadow
const WIND_PER_MIN = 6;
// the world in coarse cells: the unit of ground a root claims
const GRID_COLS = 8;
const GRID_ROWS = 5;
const windTimers: Record<BerryKind, number> = { red: 0, gold: 0, blue: 0 };

interface Sprout {
  x: number;
  y: number;
  age: number;
  kind: BerryKind;
}
const sprouts: Sprout[] = [];

function cellOf(x: number, y: number): number {
  const col = Math.min(GRID_COLS - 1, Math.floor((x / world.w) * GRID_COLS));
  const row = Math.min(GRID_ROWS - 1, Math.floor((y / world.h) * GRID_ROWS));
  return row * GRID_COLS + col;
}

// one cell of ground only feeds so many roots of one color; a seed that
// lands on full ground is simply lost — that loss IS the ceiling
function cellHasRoom(kind: BerryKind, x: number, y: number): boolean {
  const cell = cellOf(x, y);
  let n = 0;
  for (const t of treats) if (t.kind === kind && cellOf(t.x, t.y) === cell) n++;
  for (const s of sprouts) if (s.kind === kind && cellOf(s.x, s.y) === cell) n++;
  return n < CELL_CAP;
}

function plantSprout(kind: BerryKind, x: number, y: number): void {
  const at = clampToWorld(x, y, 30);
  if (!cellHasRoom(kind, at.x, at.y)) return;
  sprouts.push({ x: at.x, y: at.y, age: 0, kind });
}

function updateTreats(dt: number): void {
  for (let i = treats.length - 1; i >= 0; i--) {
    treats[i].age += dt;
    if (treats[i].age > TREAT_LIFE) {
      const gone = treats.splice(i, 1)[0];
      // fallen fruit seeds the ground it rots on (with a little roll for
      // spread) — how groves of a color nobody eats yet wait for the
      // lineage that will
      if (gone.kind !== 'gift' && Math.random() < ROT_P) {
        plantSprout(gone.kind, gone.x + (Math.random() - 0.5) * 120, gone.y + (Math.random() - 0.5) * 120);
      }
    }
  }
  for (let i = sprouts.length - 1; i >= 0; i--) {
    sprouts[i].age += dt;
    if (sprouts[i].age >= SPROUT_S) {
      const s = sprouts.splice(i, 1)[0];
      treats.push({ x: s.x, y: s.y, age: 0, eater: null, kind: s.kind });
    }
  }
  treatButton.disabled = giftCount() >= TREAT_CAP;
}

// the family portrait rule: frame every pip with breathing room, zoom clamped
// between today's intimacy (1) and the whole-world view, and always ease there
function updateCamera(dt: number): void {
  // an extinct world holds the camera still — there is nothing to frame
  if (pips.length === 0) return;
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
function nearestTreatTo(x: number, y: number, self: Pip): { treat: Treat; dist: number } | null {
  let best: { treat: Treat; dist: number } | null = null;
  for (const treat of treats) {
    if (treat.eater !== null && treat.eater !== self) continue;
    // a pip only smells food its body can use; the watcher's gifts are
    // honey — simple sugars, digestible by every genome there will ever be
    // (rescue must never depend on a lineage's enzymes)
    if (treat.kind !== 'gift' && self.enzymes[treat.kind] < ENZYME_CHASE_FLOOR) continue;
    const dist = Math.hypot(treat.x - x, treat.y - y);
    if (!best || dist < best.dist) best = { treat, dist };
  }
  return best;
}

// the food this body digests best — what its home ground should grow
function bestFood(pip: Pip): BerryKind {
  let best: BerryKind = 'red';
  for (const kind of BERRY_KINDS) if (pip.enzymes[kind] > pip.enzymes[best]) best = kind;
  return best;
}

// a playmate is an awake, unafraid flockmate that is neither fleeing nor
// visibly failing: pips romp with whoever is around, the way social
// animals do — no watcher required, but sleepers and the fading are left
// in peace
function nearestPlaymate(pip: Pip): { pip: Pip; dist: number } | null {
  let best: { pip: Pip; dist: number } | null = null;
  for (const other of pips) {
    if (other === pip || other.fading !== null || other.starvingFor > STARVE_FADE_AT) continue;
    if (other.state === 'sleep' || other.state === 'flee' || other.state === 'cower') continue;
    if (other.moods.fear >= 0.3) continue;
    const d = Math.hypot(other.x - pip.x, other.y - pip.y);
    if (!best || d < best.dist) best = { pip: other, dist: d };
  }
  return best;
}

// the single strand-mutation choke point: every future writer (gene
// transfer above all) inherits the derived-digestion refresh for free
function setStrand(pip: Pip, strand: string): void {
  pip.strand = strand;
  pip.enzymes = enzymesOf(strand);
  pip.mobility = mobilityOf(strand);
}

// ------------------------------------------------------- gene transfer
// conjugation needs a quiet nap together — sixteen calm seconds for the
// smallest fragment, forty-eight to fill the bridge, right inside an
// ordinary pile-nap. The head only walks while both bodies stay calm,
// slow, and touching, and only a PILIATED neighbor can be read from —
// most meadows hold none until some lineage invents the machinery in
// its junk (see MOB_SIG in dna.ts)
const PILUS_REACH = 50;
const PILUS_SPEED = 1; // letters per sim-second: duration IS the rate
const PILUS_MIN_FRAG = 16;
// the bridge only carries so much before it lets go: one event converts a
// gene's width or two, never an identity — however long the nap
const PILUS_MAX_FRAG = 48;
const TRANSFER_CALM_FEAR = 0.2;
const TRANSFER_CALM_SPEED = 30;

function calmForTransfer(pip: Pip): boolean {
  return pip.moods.fear < TRANSFER_CALM_FEAR && Math.hypot(pip.vx, pip.vy) < TRANSFER_CALM_SPEED;
}

// a walk in progress survives while both stay calm and in reach — a nearer
// donor never steals it (without this hysteresis a pip between two donors
// would reset forever, transferring LESS than one beside a single donor)
function linkHolds(pip: Pip, partner: Pip): boolean {
  return (
    calmForTransfer(pip) &&
    calmForTransfer(partner) &&
    partner.mobility >= MOB_FLOOR &&
    pips.includes(partner) &&
    Math.hypot(partner.x - pip.x, partner.y - pip.y) < PILUS_REACH
  );
}

function calmPiliatedNeighbor(pip: Pip): Pip | null {
  if (!calmForTransfer(pip)) return null;
  let best: Pip | null = null;
  let bestDist = PILUS_REACH;
  for (const other of pips) {
    if (other === pip || other.mobility < MOB_FLOOR) continue;
    if (!calmForTransfer(other)) continue;
    const d = Math.hypot(other.x - pip.x, other.y - pip.y);
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return best;
}

// the link broke: whatever the head copied while it rode tries to land in
// this pip's strand by homology. It reads a SNAPSHOT taken when the bridge
// formed — the letters delivered are the letters walked, whatever became
// of the neighbor since (a partner may even give this last gift from
// beyond its poof)
function settleFragment(pip: Pip): void {
  const head = pip.transferHead;
  if (head.strand && head.covered >= PILUS_MIN_FRAG) {
    const frag = head.strand.slice(head.start, head.start + Math.floor(head.covered));
    const grown = integrateFragment(pip.strand, frag);
    // converting identical letters is a biological no-op: only a REAL
    // change re-reads the pip or says anything to the watcher
    if (grown !== null && grown !== pip.strand) {
      setStrand(pip, grown);
      // rates and looks re-read live; the SPAN stays the body's own — it
      // was set by the flesh that grew, and acquired genes reach the
      // daughters through division's own re-pricing. No nap may hand a
      // pip its goodbye
      pip.genes = decode(grown);
      flockVersion++;
      saveQueued = true;
      if (pip.emoteFor <= 0 && pip.fading === null) showEmote(pip, '✦');
    }
  }
  head.partner = null;
  head.strand = '';
  head.covered = 0;
}

function updateTransferHead(pip: Pip, dt: number): void {
  const head = pip.transferHead;
  if (head.partner && linkHolds(pip, head.partner)) {
    head.covered = Math.min(head.covered + PILUS_SPEED * dt, PILUS_MAX_FRAG);
    return;
  }
  settleFragment(pip);
  const near = calmPiliatedNeighbor(pip);
  if (near) {
    head.partner = near;
    head.strand = near.strand;
    head.start = Math.floor(Math.random() * Math.max(1, near.strand.length - PILUS_MIN_FRAG));
    head.covered = 0;
  }
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
  swellComfort: number[];
  sinceSplit: number;
  starvingFor: number;
  age: number;
  // this body's own span, from its genes; the longevity dial scales it live
  lifespan: number;
  poofFor: number;
  // why a poof is underway: only a hunger fade can be cancelled by food
  fading: 'hunger' | 'age' | null;
  wanderTarget: Vec | null;
  // seeds in transit: eaten berries ride the gut and are sown where the
  // pip happens to stand when they drop
  gut: { kind: BerryKind; dropIn: number }[];
  // digestion per pigment, cached from the strand's enzyme genes — derived
  // state, recomputed wherever the strand changes, never saved
  enzymes: Record<BerryKind, number>;
  // this tick's romp partner, found once in the senses pass and reused by
  // the play act — never saved, refreshed every tick
  playmate: Pip | null;
  // whether this strand carries the transfer machinery, cached beside it
  // (the DONOR wears the pilus; this reading head belongs to the receiver)
  mobility: number;
  // the transfer head: which piliated neighbor it is reading, a snapshot
  // of their strand from the moment the bridge formed, and how far a
  // quiet hour has let it walk
  transferHead: { partner: Pip | null; strand: string; start: number; covered: number };
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

function makePip(genes: Genes, strand: string, x: number, y: number, generation = 0, name = makeName(), age = 0): Pip {
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
    swellComfort: [],
    // scattered readiness at creation, so a fresh or reloaded flock never
    // arrives synchronized (a newborn's 0 is set by divide)
    sinceSplit: SPLIT_COOLDOWN * (0.35 + Math.random() * 0.65),
    starvingFor: 0,
    age,
    lifespan: lifespanOf(genes),
    poofFor: 0,
    fading: null,
    wanderTarget: null,
    gut: [],
    enzymes: enzymesOf(strand),
    playmate: null,
    mobility: mobilityOf(strand),
    transferHead: { partner: null, strand: '', start: 0, covered: 0 },
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

// a pip some unseen generations from the founder: the strand drifts first
// and the stats are read from it — the genome is the only heredity there is.
// The strangeness dial sets how far every arrival has traveled
function wanderIn(x: number, y: number): Pip {
  // wanderers descend from the granted founder line, their enzymes drifted
  // exactly as far as the rest of their back-story — but survivorship keeps
  // the gate honest: a traveler who could digest nothing would never have
  // finished the journey, so a drift that broke digestion is re-granted
  // (respelled when even the grant will not join clean — a harsh road)
  let strand = drift(tryAppendGrant(FOUNDER_STRAND, 'red') ?? FOUNDER_STRAND, dials.strangeness);
  if (needsEnzymeGrant(strand)) {
    strand =
      tryAppendGrant(strand, 'red') ??
      tryAppendGrant(encode(decode(strand)), 'red') ??
      forceAppendGrant(encode(decode(strand)), 'red');
  }
  const pip = makePip(decode(strand), strand, x, y);
  // arrivals have lived a little already — mid-day, mid-life, unsynchronized
  // (scaled by the longevity dial, or a short-lived terrarium would welcome
  // wanderers already past their whole span)
  pip.age = Math.random() * 0.35 * pip.lifespan * dials.longevity;
  return pip;
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

function saveWorld(): void {
  storeSave(snapshotWorld(), SAVE_KEY, floraNow());
}

// the ground as the save layer sees it: every ambient berry and sprout;
// gifts melt away with the session, and gut seeds are lost in transit
function floraNow(): FloraSave[] {
  const out: FloraSave[] = [];
  for (const t of treats) {
    if (t.kind !== 'gift') out.push({ kind: t.kind, x: t.x, y: t.y, age: t.age, sprout: false });
  }
  for (const s of sprouts) out.push({ kind: s.kind, x: s.x, y: s.y, age: s.age, sprout: true });
  return out;
}

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
    age: pip.age,
  }));
}

// two worlds, one game: the MEADOW is the real one — a flock to care for,
// with no levers at all — and the TERRARIUM is a separate sandbox where
// every dial is exposed. Separate saves, and nothing transfers between them
type Mode = 'meadow' | 'terrarium';
const storedMode = (() => {
  try {
    return localStorage.getItem('pip-mode');
  } catch {
    return 'meadow';
  }
})();
const mode: Mode = storedMode === 'terrarium' ? 'terrarium' : 'meadow';
const SAVE_KEY = SAVE_KEYS[mode];

// dials are terrarium physics: the meadow always runs the ordinary day and
// never even reads the stored levers (loaded before the first wander-in so
// a terrarium arrival honors the strangeness dial)
const dials = mode === 'terrarium' ? loadDials() : freshDials();
// the world's constitution, chosen with the world (see laws.ts)
const laws = LAWS[mode];

// the same pips, and how far you got with them, survive the refresh
const saved = loadSave(SAVE_KEY);
if (saved) {
  for (const entry of saved.pips) {
    const spot = entry.pos ? clampToWorld(entry.pos.x, entry.pos.y) : randomSpot();
    const pip = makePip(entry.genes, entry.strand, spot.x, spot.y, entry.generation, entry.name, entry.age);
    pip.moods.trust = entry.trust;
    pip.needs = entry.needs;
    pip.disp = entry.disp;
    pip.places = entry.places;
    pips.push(pip);
  }
} else {
  pips.push(wanderIn(world.w / 2, world.h / 2));
}
// a meadow honors its no-empty promise even against a tampered-empty save;
// an extinct terrarium save is honored exactly as it lies
if (pips.length === 0 && laws.reseedOnEmpty) pips.push(wanderIn(world.w / 2, world.h / 2));

// dress the ground: a v12 world carries its own flora; older and fresh
// worlds warm-start settled, so nobody ever reloads into a famine
if (saved?.flora) {
  for (const f of saved.flora) {
    const at = clampToWorld(f.x, f.y, 30);
    if (f.sprout) sprouts.push({ x: at.x, y: at.y, age: Math.min(f.age, SPROUT_S), kind: f.kind });
    else treats.push({ x: at.x, y: at.y, age: Math.min(f.age, TREAT_LIFE), eater: null, kind: f.kind });
  }
} else {
  // each pip's home ground gets a settled stand of its own food, and the
  // wind gets credit for a few groves of the colors nobody here eats yet
  for (const pip of pips) {
    const diet = bestFood(pip);
    for (let i = 0; i < CELL_CAP; i++) {
      const x = pip.x + (Math.random() - 0.5) * 360;
      const y = pip.y + (Math.random() - 0.5) * 360;
      if (Math.random() < 0.4) {
        plantSprout(diet, x, y);
      } else {
        const at = clampToWorld(x, y, 30);
        if (cellHasRoom(diet, at.x, at.y)) {
          treats.push({ x: at.x, y: at.y, age: Math.random() * 40, eater: null, kind: diet });
        }
      }
    }
  }
  for (const kind of BERRY_KINDS) {
    for (let i = 0; i < 12; i++) {
      plantSprout(kind, 30 + Math.random() * (world.w - 60), 30 + Math.random() * (world.h - 60));
    }
  }
}
// the very first save waits until the ground is dressed, so a first-minute
// refresh never reloads onto bare earth
if (!saved) saveWorld();

// a knock on the meadow gate: wanderers walk in mid-day, not factory-new,
// so even a fresh crowd is unsynchronized from its first minute
function welcomeWanderers(count: number): void {
  const before = pips.length;
  for (let i = 0; i < count && pips.length < MAX_SAVED_PIPS; i++) {
    const spot = randomSpot();
    const pip = wanderIn(spot.x, spot.y);
    pip.needs = {
      food: 0.82 + Math.random() * 0.18,
      rest: 0.82 + Math.random() * 0.18,
      fun: 0.55 + Math.random() * 0.3,
    };
    pips.push(pip);
  }
  if (pips.length === before) return; // a full meadow: nobody arrived, nothing changed
  // a wanderer into an extinct dish becomes the one worth watching
  if (!selectedPip) selectedPip = pips[before];
  flockVersion++;
  sinceSave = 0;
  saveWorld();
}

let selectedPip: Pip | null = pips[0] ?? null;
// bumped on any population change; roster AND census rebuild against it
let flockVersion = 0;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveWorld();
});
window.addEventListener('pagehide', () => saveWorld());

// the world holds its breath while you work elsewhere: an unfocused window
// freezes sim time entirely, so stepping away never costs a pip anything
let paused = !document.hasFocus();
window.addEventListener('blur', () => {
  paused = true;
  fRainHeld = false;
  endButtonRain();
  document.body.classList.add('paused');
  saveWorld();
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
  }, parent.swellComfort, Math.random, dials.wildness);
  parent.swellComfort = [];
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
  parent.lifespan = lifespanOf(a.genes);
  setStrand(parent, a.strand);
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
  const friend = nearestPlaymate(pip);
  pip.playmate = friend ? friend.pip : null;
  return {
    presence: pointer.presence,
    dist: distToPointerOf(pip),
    speed: pointer.speed,
    stillFor: pointer.stillFor,
    treatDist: treat ? treat.dist : Infinity,
    friendDist: friend ? friend.dist : Infinity,
    place: placeAt(pip.places, pip.x / world.w, pip.y / world.h),
    alarm: alarmNear(pip),
    // torpor tracks the VISIBLE fade window, so the reach never narrows
    // before the watcher can see the body going — collapsed-but-solid keeps
    // its whole nose; the shrinking happens across the fade they can watch
    torpor: clamp01((pip.starvingFor - STARVE_FADE_AT) / (STARVE_POOF_AT - STARVE_FADE_AT)),
  };
}

function showEmote(pip: Pip, symbol: string): void {
  pip.emote = symbol;
  pip.emoteFor = 1.2;
}

// ------------------------------------------------------------------ movement

// how silver a pip is right now, with the terrarium's longevity dial applied
function elderOf(pip: Pip): number {
  return eldernessOf(pip.age, pip.lifespan * dials.longevity);
}

function steerToward(pip: Pip, tx: number, ty: number, accel: number, maxSpeed: number, dt: number, sulkFactor: number): void {
  // old bones amble: elders keep every destination, just at their own pace
  maxSpeed *= lerp(1, 0.62, elderOf(pip));
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
    case 'play': {
      // romping: tangential pursuit of a point ahead on the circle around
      // the friend — the orbit flows smoothly from wherever the romp is
      // now, and its 64px radius clears the 44px push bubble, so nobody
      // gets shoved through (and no napping neighbor's gene-transfer link
      // is jostled apart). Real exercise: a romp costs belly as it earns joy
      const friend = pip.playmate;
      if (!friend) {
        settle(pip, dt, 4);
        break;
      }
      const bearing = Math.atan2(pip.y - friend.y, pip.x - friend.x) + 0.9;
      steerToward(pip, friend.x + Math.cos(bearing) * 64, friend.y + Math.sin(bearing) * 64, 260, 150, dt, sulkFactor);
      if (pip.emoteFor <= 0 && Math.random() < dt / 4) showEmote(pip, '♪');
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
          // the meal is worth what this body's enzymes can pull from it;
          // the watcher's honey needs no enzymes at all
          pip.needs = eat(pip.needs, target.treat.kind === 'gift' ? 1 : pip.enzymes[target.treat.kind]);
          // an ambient berry's seeds ride along in the gut, to be sown
          // wherever the eater wanders over the next minute or so
          if (target.treat.kind !== 'gift') {
            for (let s = 0; s < SEEDS_PER_BERRY; s++) {
              pip.gut.push({ kind: target.treat.kind, dropIn: GUT_MIN_S + Math.random() * (GUT_MAX_S - GUT_MIN_S) });
            }
          }
          // trust is food-association, and it attaches to the feeder: only
          // the watcher's own gift builds the bond — a wild berry feeds the
          // body, not the relationship
          if (target.treat.kind === 'gift') {
            pip.moods = { ...pip.moods, trust: clamp01(pip.moods.trust + 0.03) };
          }
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

// each berry color as drawn; the watcher's gift wears the founder mint, so
// love is recognizable at a glance in any meadow
const BERRY_COLORS: Record<BerryKind | 'gift', string> = {
  red: '#e05c6e',
  gold: '#e0b04f',
  blue: '#6f9fe0',
  gift: '#6fd3b0',
};

function drawTreats(t: number): void {
  // sprouts first, under the ripe fruit: a nub swelling toward berryhood,
  // the queue of coming food visible on the ground
  for (const s of sprouts) {
    const grown = s.age / SPROUT_S;
    ctx.globalAlpha = 0.3 + grown * 0.5;
    ctx.fillStyle = BERRY_COLORS[s.kind];
    ctx.beginPath();
    ctx.arc(s.x, s.y, 1.5 + grown * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7fce9a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x, s.y - 3 - grown * 3);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const treat of treats) {
    const pop = Math.min(1, treat.age / 0.3);
    const fade = Math.min(1, (TREAT_LIFE - treat.age) / 5);
    const r = 5 * Math.sin(pop * Math.PI * 0.5);
    ctx.globalAlpha = fade;
    ctx.fillStyle = BERRY_COLORS[treat.kind];
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
  // silver comes with the years: an elder's color quiets and lightens
  const silver = elderOf(pip);
  let h = hueShift(g.hue, 250, fear * 0.4);
  let s = g.sat * (1 - fear * 0.35) * lerp(1, 0.55, sulkFactor) * (1 - hungry * 0.2) * (1 - silver * 0.35);
  const l = g.light + fear * 5 - sulkFactor * 4 - hungry * 3 + silver * 6;
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

const EMOTE_COLORS: Record<string, string> = { '♥': '#ff8fa3', '●': '#e05c6e', '✿': '#e8b4d0', '✦': '#8fd8e8', '♪': '#ffd97a' };

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
  const elder = elderOf(pip);
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

  // old age, worn proudly: a little silver bun behind the crown
  if (elder > 0.05) {
    ctx.globalAlpha = bodyAlpha * Math.min(1, elder * 2);
    const bx = x - pip.facing * R * 0.55;
    const by = headTopY + R * 0.18;
    ctx.fillStyle = '#cdd6de';
    ctx.beginPath();
    ctx.arc(bx, by, R * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#aeb9c4';
    ctx.beginPath();
    ctx.arc(bx, by, R * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.globalAlpha = bodyAlpha;
  }

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

  // the years, written gently: laugh lines first, reading glasses later
  if (elder > 0.05) {
    ctx.strokeStyle = `rgba(28, 39, 51, ${(0.4 * elder).toFixed(3)})`;
    ctx.lineWidth = 1.2;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + side * eyeGap, eyeY + 8, 3, 0.2 * Math.PI, 0.8 * Math.PI);
      ctx.stroke();
    }
  }
  if (elder > 0.35) {
    const clear = Math.min(1, (elder - 0.35) / 0.3);
    const glassR = lerp(4, 7, g.eyeSize) + 2.5;
    ctx.strokeStyle = `rgba(201, 212, 222, ${(0.85 * clear).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + side * eyeGap, eyeY, glassR, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(x - eyeGap + glassR, eyeY - 2);
    ctx.quadraticCurveTo(x, eyeY - 4, x + eyeGap - glassR, eyeY - 2);
    ctx.stroke();
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
let censusOpen = false;
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
// green, looks blue, color pink, diet ember-red — so the strand is read by
// meaning, not letter
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
  diet: 8,
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
  if (!selectedPip) {
    // an extinct dish still opens its ledger; there is just no one to read
    dnaTitle.textContent = '—';
    dnaShownStrand = '';
    dnaStrand.replaceChildren();
    return;
  }
  const pip = selectedPip;
  // digestion is the genome's most legible living output — it belongs on
  // the ledger's masthead. A tilde marks an enzyme still stirring below the
  // chase floor: visible to the watcher, not yet worth a walk to the pip
  // ('nothing yet' is a real state: a lineage can lose its enzymes, and the
  // fossil diet gene will not save it)
  const eats = BERRY_KINDS.filter((k) => pip.enzymes[k] >= ENZYME_TRACE_SHOW)
    .map((k) => `${pip.enzymes[k] < ENZYME_CHASE_FLOOR ? '~' : ''}${k} ${Math.round(pip.enzymes[k] * 100)}%`)
    .join(' · ');
  const pilus = pip.mobility >= MOB_FLOOR ? ' · pilus' : '';
  dnaTitle.textContent = `${pip.name} · ${pip.strand.length} bases · eats ${eats || 'nothing yet'}${pilus}`;
  if (dnaShownStrand === pip.strand) return;
  dnaShownStrand = pip.strand;
  dnaStrand.replaceChildren();
  for (const span of annotate(pip.strand)) {
    const bit = document.createElement('span');
    bit.className = SPAN_CLASS[span.kind];
    if (span.stat !== null) bit.style.setProperty('--h', String(STAT_HUES[span.stat]));
    bit.textContent = pip.strand.slice(span.from, span.to);
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
    // starvation reads as an emergency whatever the body is doing, except
    // mid-bite, when the rescue is already underway
    const stateLabel =
      pip.needs.food > 0 || pip.state === 'snack'
        ? MOOD_LABELS[pip.state]
        : pip.state === 'sleep'
          ? 'passed out — needs a berry'
          : 'famished — needs a berry';
    const silver = elderOf(pip) > 0.05 ? ' · elder' : '';
    (row.lastElementChild as HTMLElement).textContent =
      `${pip.name} · gen ${pip.generation} · ${natureLabel(pip.genes)}${temperSuffix(pip.disp, isHealing(pip.disp, happiness))}${silver} · ${meter(happiness)} · ${stateLabel}`;
    row.classList.toggle('selected', pip === selectedPip);
  }
}

// ------------------------------------------------------------------ dials

const dialsPanel = document.getElementById('dials') as HTMLDivElement;
const dialsButton = document.getElementById('dials-button') as HTMLButtonElement;
shieldFromWorld(dialsPanel);
shieldFromWorld(dialsButton);

// ratcheted alongside the specs: a new dial fails the build until it is named
const DIAL_LABELS: Record<keyof Dials, string> = {
  pace: 'pace',
  births: 'births',
  wildness: 'wildness',
  appetite: 'appetite',
  weariness: 'weariness',
  feeder: 'seed drift',
  longevity: 'longevity',
  strangeness: 'strangeness',
};

const dialValue = (field: keyof Dials): string =>
  DIAL_SPECS[field].whole
    ? `${dials[field]} gen`
    : `${dials[field].toFixed(2).replace(/\.?0+$/, '')}×`;

const dialNote = document.createElement('div');
dialNote.className = 'dial-note';
dialNote.textContent = 'an ordinary day is 1× on every dial';
dialsPanel.append(dialNote);

const dialSliders = {} as Record<keyof Dials, HTMLInputElement>;
const dialReadouts = {} as Record<keyof Dials, HTMLSpanElement>;
for (const field of DIAL_FIELDS) {
  const spec = DIAL_SPECS[field];
  const row = document.createElement('label');
  row.className = 'dial-row';
  const name = document.createElement('span');
  name.textContent = DIAL_LABELS[field];
  const slider = document.createElement('input');
  slider.type = 'range';
  // multiplier sliders glide in octaves, so ×0.5 and ×2 sit the same
  // distance from the ordinary day
  if (spec.log) {
    slider.min = String(Math.log2(spec.min));
    slider.max = String(Math.log2(spec.max));
    slider.step = '0.01';
  } else {
    slider.min = String(spec.min);
    slider.max = String(spec.max);
    slider.step = '1';
  }
  slider.setAttribute('aria-label', `${DIAL_LABELS[field]} dial`);
  const readout = document.createElement('span');
  readout.className = 'dial-value';
  slider.addEventListener('input', () => {
    let at = Number(slider.value);
    // a log slider snaps to the ordinary day when it brushes it — thumb too,
    // so the control never looks off-center while reading 1×
    if (spec.log && Math.abs(at) < 0.05) {
      at = 0;
      slider.value = '0';
    }
    dials[field] = spec.log ? 2 ** at : Math.round(at);
    readout.textContent = dialValue(field);
    storeDials(dials);
  });
  row.append(name, slider, readout);
  dialsPanel.append(row);
  dialSliders[field] = slider;
  dialReadouts[field] = readout;
}

function showDialPositions(): void {
  for (const field of DIAL_FIELDS) {
    const spec = DIAL_SPECS[field];
    dialSliders[field].value = String(spec.log ? Math.log2(dials[field]) : dials[field]);
    dialReadouts[field].textContent = dialValue(field);
  }
}
showDialPositions();

const dialActions = document.createElement('div');
dialActions.className = 'dial-actions';
function dialAction(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'dial-act';
  button.textContent = label;
  button.addEventListener('click', onClick);
  dialActions.append(button);
  return button;
}
dialAction('back to ordinary', () => {
  Object.assign(dials, freshDials());
  storeDials(dials);
  showDialPositions();
});
dialAction('welcome a wanderer', () => welcomeWanderers(1));
dialAction('welcome ten', () => welcomeWanderers(10));
dialsPanel.append(dialActions);

// beginning again erases every pip, so it asks twice — and the moment passes
const resetButton = document.createElement('button');
resetButton.className = 'dial-act begin-anew';
resetButton.textContent = 'begin a new terrarium…';
let resetArmedUntil = 0;
function disarmReset(): void {
  resetArmedUntil = 0;
  resetButton.textContent = 'begin a new terrarium…';
  resetButton.classList.remove('armed');
}
resetButton.addEventListener('click', () => {
  if (performance.now() < resetArmedUntil) {
    disarmReset();
    beginAnew();
    return;
  }
  resetArmedUntil = performance.now() + 3500;
  resetButton.textContent = 'really begin again?';
  resetButton.classList.add('armed');
  setTimeout(() => {
    if (resetArmedUntil > 0 && performance.now() >= resetArmedUntil) disarmReset();
  }, 3600);
});
dialsPanel.append(resetButton);

function beginAnew(): void {
  clearSave(SAVE_KEY);
  treats.length = 0;
  // a fresh dish is FRESH: the old world's ripening sprouts and wind clocks
  // must not leak into the new one
  sprouts.length = 0;
  for (const kind of BERRY_KINDS) windTimers[kind] = 0;
  pips.length = 0;
  const first = wanderIn(world.w / 2, world.h / 2);
  showEmote(first, '✧');
  pips.push(first);
  selectedPip = first;
  flockVersion++;
  sinceSave = 0;
  saveWorld();
}

let dialsOpen = false;
function setDialsOpen(open: boolean): void {
  dialsOpen = open;
  dialsPanel.hidden = !open;
  dialsButton.classList.toggle('active', open);
}
dialsButton.addEventListener('click', () => setDialsOpen(!dialsOpen));
// the meadow builds the same panel but never shows it: one code path, and
// not a single lever reachable in the real game
if (mode === 'meadow') dialsButton.hidden = true;

// ------------------------------------------------------------------ worlds

const title = document.getElementById('title') as HTMLDivElement;
const modeButton = document.getElementById('mode-button') as HTMLButtonElement;
const pickMeadow = document.getElementById('pick-meadow') as HTMLButtonElement;
const pickTerrarium = document.getElementById('pick-terrarium') as HTMLButtonElement;
shieldFromWorld(title);
shieldFromWorld(modeButton);

// choosing the world you are already in just closes the menu; choosing the
// other one reboots into it — the pagehide save has already tucked this
// world in, and each world wakes from its own slot
function pickMode(next: Mode): void {
  let stored = false;
  try {
    localStorage.setItem('pip-mode', next);
    stored = true;
  } catch {
    // storage unavailable — no world can be switched without it, and a
    // blind reload would just strand the player in a loop
  }
  if (next === mode || !stored) {
    title.hidden = true;
    return;
  }
  location.reload();
}
pickMeadow.addEventListener('click', () => pickMode('meadow'));
pickTerrarium.addEventListener('click', () => pickMode('terrarium'));
(mode === 'meadow' ? pickMeadow : pickTerrarium).classList.add('current');
modeButton.addEventListener('click', () => {
  title.hidden = false;
});
// the very first visit asks which world to enter; every later boot goes
// straight into the one you last played
if (storedMode === null) title.hidden = false;

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  // a focused slider owns the keyboard — its arrows must not also cycle pips
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'c' || e.key === 'C') {
    censusOpen = !censusOpen;
    return;
  }
  if ((e.key === 'd' || e.key === 'D') && mode === 'terrarium') {
    setDialsOpen(!dialsOpen);
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
  // ...and whenever any real control holds focus — a keyboard user must be
  // able to walk a panel's buttons without cycling pips instead
  if (e.key === 'Tab' && e.target instanceof HTMLElement && e.target !== document.body) return;
  e.preventDefault();
  const step = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
  if (pips.length === 0) return;
  const idx = selectedPip ? Math.max(0, pips.indexOf(selectedPip)) : 0;
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
  play: 'romping with a friend',
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
// births and goodbyes ask for a save; it flushes once per frame, so a fast
// day never stacks synchronous writes inside one paint
let saveQueued = false;
// the world's own clock, advanced by sim steps: motion phases (a flee's
// evasion wobble) must move with meadow time, not the wall clock
let worldT = 0;

// one step of meadow time: everything that happens in the world, no drawing
function simulate(dt: number, t: number): void {
  updateTreats(dt);

  if (fRainHeld || buttonRainHeld) {
    rainTimer -= dt;
    while (rainTimer <= 0) {
      rainTimer += RAIN_EVERY;
      if (fRainHeld && pointer.presence > 0) dropTreat(wp.x, wp.y);
      else if (buttonRainHeld) dropTreatInView();
    }
  } else {
    rainTimer = 0;
  }

  // the wind sows: a thin seed-rain from beyond the meadow keeps every
  // color alive somewhere, waiting for the lineage that can eat it. The
  // dial turns the wind, never the flock's own seed loop
  for (const kind of BERRY_KINDS) {
    windTimers[kind] -= dt;
    while (windTimers[kind] <= 0) {
      windTimers[kind] += 60 / (WIND_PER_MIN * dials.feeder);
      plantSprout(kind, 30 + Math.random() * (world.w - 60), 30 + Math.random() * (world.h - 60));
    }
  }

  sinceSave += dt;
  if (sinceSave >= 10) {
    sinceSave = 0;
    saveWorld();
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

    const decision = chooseState(pip.state, pip.moods, pip.needs, expressed, senses, laws.rescueFloor);
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

    // digestion sows the meadow: a seed drops wherever the pip stands
    for (let g = pip.gut.length - 1; g >= 0; g--) {
      pip.gut[g].dropIn -= dt;
      if (pip.gut[g].dropIn <= 0) {
        const seed = pip.gut.splice(g, 1)[0];
        plantSprout(seed.kind, pip.x, pip.y);
      }
    }

    updateTransferHead(pip, dt);

    pip.needs = tickNeeds(pip.needs, pip.state, Math.hypot(pip.vx, pip.vy), dt, expressed, dials.appetite, dials.weariness);
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
    // feeds it, it shrinks and poofs into sparkles. Any bite cancels a hunger
    // fade — but not old age, which no berry can feed — and both clocks run
    // on pure meadow time: no dial cuts a grace window short
    pip.age += dt;
    if (pip.needs.food <= 0) pip.starvingFor += dt;
    else pip.starvingFor = 0;
    if (pip.poofFor > 0 && pip.fading === 'hunger' && pip.needs.food > 0) {
      pip.poofFor = 0;
      pip.fading = null;
      showEmote(pip, '♥');
    } else if (pip.poofFor > 0) {
      pip.poofFor -= dt;
      if (pip.poofFor <= 0) leaving.push(pip);
    } else if (pip.age >= pip.lifespan * dials.longevity) {
      // a whole life, fully lived: this goodbye wears a flower
      pip.fading = 'age';
      pip.poofFor = POOF_S;
      showEmote(pip, '✿');
    } else if (pip.starvingFor >= STARVE_POOF_AT) {
      pip.fading = 'hunger';
      pip.poofFor = POOF_S;
      showEmote(pip, '✧');
    }

    // mitosis: a hazard rate, not a timer — settled, well-fed pips sometimes
    // just... double. Sleep COUNTS: a cell does not consult consciousness
    // before dividing, and the unattended meadow spends its whole food
    // surplus asleep — a pip may wake up beside its brand-new sister. Only
    // real alarm (flee, cower) interrupts the machinery
    pip.sinceSplit += dt;
    const settled = pip.state !== 'flee' && pip.state !== 'cower';
    if (pip.splitFor > 0) {
      if (!settled) {
        pip.splitFor = 0; // a scare aborts the division
        pip.swellComfort = [];
        reserved--;
      } else {
        // the copyist listens across the whole swell: what the body feels in
        // these seconds decides how faithfully the strand is copied
        pip.swellComfort.push(happiness);
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
      // division is paid for in energy, not mood: the belly's surplus sets
      // the rate, while the comfort of the swell shapes only the copies
      Math.random() < splitChance(pip.needs.food, pip.sinceSplit, dt, dials.births)
    ) {
      pip.splitFor = SPLIT_SWELL_S;
      pip.swellComfort = [];
      reserved++;
    }
  }

  if (leaving.length) {
    for (const pip of leaving) {
      spawnSparkles(pip);
      pips.splice(pips.indexOf(pip), 1);
    }
    // the meadow never stays empty: a new little one wanders in. The lab
    // keeps no such promise — an extinct terrarium stays extinct until its
    // keeper starts a fresh dish
    if (pips.length === 0 && laws.reseedOnEmpty) {
      const spot = randomSpot();
      const arrival = wanderIn(spot.x, spot.y);
      showEmote(arrival, '✧');
      pips.push(arrival);
    }
    if (!selectedPip || !pips.includes(selectedPip)) selectedPip = pips[0] ?? null;
    flockVersion++;
    saveQueued = true;
  }

  if (born.length) {
    pips.push(...born);
    flockVersion++;
    saveQueued = true;
  }
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000) || 0.016;
  last = now;
  if (paused) {
    requestAnimationFrame(frame);
    return;
  }
  const t = now / 1000;

  // hand senses stay real-time: how gently the watcher moves must read the
  // same at every pace, so pointer speed is real pixels per real second
  input.update(dt);
  {
    const w = toWorld(pointer.x, pointer.y);
    wp.x = w.x;
    wp.y = w.y;
  }

  // the pace dial stretches how much meadow time each real second carries;
  // substeps keep every step inside the physics clamp, so a fast day runs
  // more steps, never bigger ones
  let simLeft = dt * dials.pace;
  while (simLeft > 1e-9) {
    const step = Math.min(0.05, simLeft);
    simLeft -= step;
    worldT += step;
    simulate(step, worldT);
  }
  if (saveQueued) {
    saveQueued = false;
    sinceSave = 0;
    saveWorld();
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
