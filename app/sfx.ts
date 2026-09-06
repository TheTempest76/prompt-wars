'use client';

// Synthesised sound effects — no audio files, no asset manifest (same reasoning
// as the canvas visuals). One short WebAudio "blip" when a creature eats food.
//
// Browsers block audio until a user gesture, so `unlockSfx()` must run from
// inside a real click/tap handler once (WorldView unlocks on first gesture).
// Mute state persists in localStorage so it survives reloads.

const MUTE_KEY = 'prompt-wars-sfx-muted';

let ctx: AudioContext | null = null;
let muted = false;

// A burst of same-tick eats would otherwise machine-gun; cap how often a blip
// actually fires and how many can overlap.
let lastPlay = 0;
const MIN_GAP_MS = 45;

if (typeof window !== 'undefined') {
  try {
    muted = localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    // localStorage unavailable — default to unmuted, not worth a fallback.
  }
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

// Call from inside a user-gesture handler once, to satisfy autoplay policy.
export function unlockSfx(): void {
  const c = ensureCtx();
  if (c && c.state === 'suspended') void c.resume();
}

export function isSfxMuted(): boolean {
  return muted;
}

export function setSfxMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(MUTE_KEY, next ? '1' : '0');
  } catch {
    // ignore — in-memory mute still applies for this session.
  }
}

// Per-kind base pitch (Hz) so plankton / spore / mineral each sound distinct.
// Index matches FOOD_KINDS in spacetimedb/src/index.ts.
const FOOD_PITCH = [520, 700, 380];

// Short plucked blip: a triangle tone that snaps up in pitch and decays fast.
export function playFoodPickup(kind = 0): void {
  if (muted) return;
  const c = ensureCtx();
  if (!c || c.state !== 'running') return;

  const now = performance.now();
  if (now - lastPlay < MIN_GAP_MS) return;
  lastPlay = now;

  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();

  // A little pitch variety so repeated eats don't sound robotic.
  const base = (FOOD_PITCH[kind] ?? FOOD_PITCH[0]) + Math.random() * 90;
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(base, t);
  osc.frequency.exponentialRampToValueAtTime(base * 1.9, t + 0.06);

  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.14, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.18);
}
