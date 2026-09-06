'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Creature, Food, Powerup } from '../src/module_bindings/types';
import { onFocusCreature } from './focus';

interface WorldCanvasProps {
  gridSize: number;
  creatures: readonly Creature[];
  food: readonly Food[];
  powerups: readonly Powerup[];
  terrainCells: string | undefined;
  tickIntervalMs: number;
  // Keyed by Identity.toHexString() -- the owning identity's latest
  // person.name, reduced to initials. See app/WorldView.tsx.
  ownerInitials: ReadonlyMap<string, string>;
  // The viewer's own identity hex -- used to find "my nearest creature" for
  // powerup targeting hints and the P-key claim.
  myOwnerKey?: string;
  onClaimPowerup?: (powerupId: bigint) => void;
  // When true, a tap on the canvas drops food at that cell (via onPlaceFood)
  // instead of doing nothing; a drag still pans. See app/WorldView.tsx.
  placeMode?: boolean;
  onPlaceFood?: (x: number, y: number) => void;
}

// Powerup colour per `kind` (see spacetimedb/src/index.ts POWERUP_LABELS):
// transmute / speed / energy / clone / hunger_zero. Brighter + larger than
// food so they read as special.
const POWERUP_COLORS = ['#c98bff', '#38e6ff', '#ffcf3f', '#5bffa3', '#5b9bff'];
const POWERUP_SHORT = ['Transmute', 'Speed', 'Energy', 'Clone', 'Hunger Zero'];
const POWERUP_NEAR_CELLS = 5; // within this range of your nearest creature -> label + P-key

// Desaturated, near-black base per biome index (0 bloom, 1 cold, 2 vent,
// 3 barren — matches spacetimedb/src/index.ts's BIOME_* constants). Kept
// dark and muted on purpose: creatures/food are the ONLY fully-saturated
// things on screen -- if biomes compete for saturation, creatures lose
// legibility.
const BIOME_BASE_RGB: [number, number, number][] = [
  [15, 46, 38], // nutrient bloom -- muted green, #0f2e26
  [13, 34, 50], // cold shelf -- muted blue, #0d2232
  [58, 36, 18], // thermal vent -- muted amber-brown, #3a2412
  [10, 16, 22], // barren -- near-black cool, #0a1016
];
// Food colour + relative size per `kind` (see spacetimedb/src/index.ts
// FOOD_KINDS): 0 plankton keeps the original mint so the common case looks
// unchanged; 1 spore is a small bloom-pink mote; 2 mineral -- the dense-energy
// "good" food -- is a bigger, brighter gold nugget that reads as worth chasing.
const FOOD_COLOR = '#9dffcf'; // kind 0, and the fallback for an unknown kind
const FOOD_COLORS = ['#9dffcf', '#ff77cf', '#ffc21f'];
const FOOD_SIZE_MULT = [1, 0.85, 1.5];
const VOID_COLOR = '#05070c'; // outside the dish, when panned past the edge

// One pixel per world cell, flat per-biome colour -- no per-cell jitter.
// (An earlier version added per-pixel brightness noise here; it read as
// grainy static layered on the regions instead of soft fields, so it's
// gone. All of the "soft field" look comes from upscaling below.)
// The blurred, soft-field look isn't a blur filter — it's this tiny
// texture drawn hugely upscaled with the canvas's own bilinear image
// smoothing, which turns hard per-cell boundaries into smooth gradients
// for free.
function buildTerrainTexture(cells: string, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const biome = Number(cells[idx]);
      const [r, g, b] = BIOME_BASE_RGB[biome] ?? BIOME_BASE_RGB[0];
      const p = idx * 4;
      img.data[p] = r;
      img.data[p + 1] = g;
      img.data[p + 2] = b;
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

interface Camera {
  x: number; // world cell-space, center of viewport
  y: number;
  zoom: number; // screen CSS pixels per world cell
}

const MIN_ZOOM_ABS = 2;
const MAX_ZOOM = 48;
const FIT_MARGIN = 0.94; // whole-world zoom-out floor sits slightly looser than exact edge-to-edge
// The world is big on purpose (see spacetimedb/src/index.ts's GRID_SIZE
// comment) -- the default/starting view is zoomed into a fraction of it,
// not fit-to-whole-world. More world is revealed by panning outward; "0"
// (or first load) returns to this same starting view, not a full overview.
// Zooming all the way out (mouse/pinch/keyboard) still reaches the whole
// world -- that's MIN_ZOOM, computed separately, not this.
const INITIAL_VIEW_FRACTION = 0.18;
const PAN_SPEED = 18; // world cells / second, keyboard
const ZOOM_SPEED = 1.6; // multiplicative / second, keyboard

interface InterpEntry {
  prevX: number;
  prevY: number;
  currX: number;
  currY: number;
  changedAt: number;
  size: number;
  color: string;
  glyph: string;
  isPredator: boolean;
  ownerKey: string | undefined;
}

// World-spawned, never player-authored -- deliberately reads as a threat
// with zero explanation: sharp edges and a fixed red/white marker, not the
// soft round glow every other entity gets.
const PREDATOR_FILL = '#ff3f3f';
const PREDATOR_STROKE = '#ffffff';

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  return (el as HTMLElement).isContentEditable === true;
}

export function WorldCanvas({ gridSize, creatures, food, powerups, terrainCells, tickIntervalMs, ownerInitials, myOwnerKey, onClaimPowerup, placeMode = false, onPlaceFood }: WorldCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Camera lives in React state per spec; a ref mirror lets the RAF loop
  // (and pointer/keyboard handlers) always read the latest value without
  // being recreated every time it changes.
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 8 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  // iOS Safari has no Fullscreen API for non-<video> elements, so
  // requestFullscreen() is simply absent there. `pseudoFs` is the fallback:
  // a fixed, viewport-filling overlay toggled purely with CSS.
  const [pseudoFs, setPseudoFs] = useState(false);
  const expanded = isFullscreen || pseudoFs;
  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);
  // Lock page scroll behind the pseudo-fullscreen overlay.
  useEffect(() => {
    if (!pseudoFs) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [pseudoFs]);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const gridSizeRef = useRef(gridSize);
  gridSizeRef.current = gridSize;
  const foodRef = useRef(food);
  foodRef.current = food;
  const powerupsRef = useRef(powerups);
  powerupsRef.current = powerups;
  const creaturesRef = useRef(creatures);
  creaturesRef.current = creatures;
  const myOwnerKeyRef = useRef(myOwnerKey);
  myOwnerKeyRef.current = myOwnerKey;
  const onClaimPowerupRef = useRef(onClaimPowerup);
  onClaimPowerupRef.current = onClaimPowerup;
  const tickIntervalMsRef = useRef(tickIntervalMs);
  tickIntervalMsRef.current = tickIntervalMs;
  const ownerInitialsRef = useRef(ownerInitials);
  ownerInitialsRef.current = ownerInitials;
  const placeModeRef = useRef(placeMode);
  placeModeRef.current = placeMode;
  const onPlaceFoodRef = useRef(onPlaceFood);
  onPlaceFoodRef.current = onPlaceFood;
  // Tracks a single-pointer gesture so endPointer can tell a tap (place food)
  // from a drag (pan). Null whenever there isn't exactly one active pointer.
  const tapRef = useRef<{ sx: number; sy: number; moved: boolean } | null>(null);
  const terrainCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Terrain never changes after generation, so this texture is built once
  // per (terrainCells, gridSize) pair, not per frame.
  useEffect(() => {
    if (terrainCells && gridSize > 0 && terrainCells.length === gridSize * gridSize) {
      terrainCanvasRef.current = buildTerrainTexture(terrainCells, gridSize);
    }
  }, [terrainCells, gridSize]);

  const viewportRef = useRef({ cssWidth: 0, cssHeight: 0 });
  const minZoomRef = useRef(MIN_ZOOM_ABS);
  // Re-fit on every layout change (resize, orientation change, gridSize
  // arriving/changing) until the user actually touches the camera -- NOT a
  // one-shot latch. A one-shot fit that runs before the container's CSS
  // aspect-ratio has settled to its final square box (or before gridSize
  // has arrived) locks in a wrong zoom forever, since every later resize
  // only clamped instead of refitting. This was the actual
  // "grid doesn't fill the canvas" bug.
  const userAdjustedRef = useRef(false);
  const interpRef = useRef(new Map<string, InterpEntry>());
  const heldKeysRef = useRef(new Set<string>());
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);

  const clampCamera = useCallback((cam: Camera, size: number): Camera => {
    const zoom = Math.max(minZoomRef.current, Math.min(MAX_ZOOM, cam.zoom));
    // The world is a torus -- the camera centre wraps modulo the grid instead
    // of clamping at an edge, and the renderer tiles the world to match, so
    // panning never runs out of world. Only zoom is bounded.
    if (size <= 0) return { x: cam.x, y: cam.y, zoom };
    return {
      x: ((cam.x % size) + size) % size,
      y: ((cam.y % size) + size) % size,
      zoom,
    };
  }, []);

  const fitCamera = useCallback((size: number) => {
    const { cssWidth, cssHeight } = viewportRef.current;
    if (cssWidth === 0 || cssHeight === 0 || size <= 0) return;

    // The zoom-out floor: fitting the WHOLE world, with a small margin --
    // this is what "zoom all the way out" reaches, independent of the
    // default starting view below.
    const wholeWorldZoom = Math.max(MIN_ZOOM_ABS, Math.min(cssWidth / size, cssHeight / size) * FIT_MARGIN);
    minZoomRef.current = wholeWorldZoom;

    // The default/starting view: zoomed into INITIAL_VIEW_FRACTION of the
    // world, not the whole thing -- more is revealed by panning outward.
    const visibleSpan = size * INITIAL_VIEW_FRACTION;
    const startZoom = Math.max(
      minZoomRef.current,
      Math.min(MAX_ZOOM, Math.min(cssWidth / visibleSpan, cssHeight / visibleSpan))
    );
    setCamera({ x: size / 2, y: size / 2, zoom: startZoom });
  }, []);

  const applyLayout = useCallback(() => {
    const size = gridSizeRef.current;
    const { cssWidth, cssHeight } = viewportRef.current;
    if (size <= 0 || cssWidth === 0 || cssHeight === 0) return;
    if (!userAdjustedRef.current) {
      fitCamera(size); // keep re-fitting -- self-corrects through any transient measurement timing
    } else {
      setCamera(cam => clampCamera(cam, size));
    }
  }, [fitCamera, clampCamera]);

  // "Focus my new creature": SpawnCreature fires an id the moment the spawn
  // procedure returns; the row itself is usually a beat behind over the
  // subscription. `focusReq` is state (not a ref) so setting it actually
  // re-runs the effect below, which then retries on every `creatures` update
  // until the row lands or the 8s window lapses.
  const [focusReq, setFocusReq] = useState<bigint | null>(null);
  const focusDeadlineRef = useRef(0);
  useEffect(
    () =>
      onFocusCreature(id => {
        focusDeadlineRef.current = performance.now() + 8000;
        setFocusReq(id);
      }),
    []
  );
  useEffect(() => {
    if (focusReq === null) return;
    if (performance.now() > focusDeadlineRef.current) {
      setFocusReq(null);
      return;
    }
    const target = creatures.find(c => c.id === focusReq);
    if (!target) return; // not in the subscription yet -- retry next update
    const size = gridSizeRef.current;
    const { cssWidth, cssHeight } = viewportRef.current;
    if (size <= 0 || cssWidth === 0 || cssHeight === 0) return;
    const FOCUS_SPAN_CELLS = 45; // roughly how much world to frame around it
    const focusZoom = Math.max(
      minZoomRef.current,
      Math.min(MAX_ZOOM, Math.min(cssWidth, cssHeight) / FOCUS_SPAN_CELLS)
    );
    userAdjustedRef.current = true; // don't let the layout pass re-fit over this
    setCamera(clampCamera({ x: target.x + 0.5, y: target.y + 0.5, zoom: focusZoom }, size));
    setFocusReq(null);
  }, [focusReq, creatures, clampCamera]);

  // ---- Canvas sizing: ResizeObserver + devicePixelRatio, not window resize ----
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = Math.max(1, Math.round(rect.width));
      const cssHeight = Math.max(1, Math.round(rect.height));
      viewportRef.current = { cssWidth, cssHeight };

      // CSS size and backing-store (attribute) size are set separately --
      // otherwise every phone renders this blurry.
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);

      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      applyLayout();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    return () => observer.disconnect();
  }, [applyLayout]);

  // gridSize arrives asynchronously (0 until world_config's subscription
  // applies) -- fit as soon as it's known, or re-clamp if it changes later
  // (e.g. someone calls set_grid_size).
  useEffect(() => {
    applyLayout();
  }, [gridSize, applyLayout]);

  // ---- Interpolation bookkeeping: runs whenever subscribed creature rows change ----
  useEffect(() => {
    const map = interpRef.current;
    const now = performance.now();
    const seen = new Set<string>();
    for (const c of creatures) {
      const key = c.id.toString();
      seen.add(key);
      const existing = map.get(key);
      const ownerKey = c.owner ? c.owner.toHexString() : undefined;
      if (!existing) {
        map.set(key, {
          prevX: c.x, prevY: c.y, currX: c.x, currY: c.y,
          changedAt: now, size: c.size, color: c.color, glyph: c.glyph, isPredator: c.isPredator, ownerKey,
        });
      } else if (existing.currX !== c.x || existing.currY !== c.y) {
        // The world is a torus: a creature stepping off one edge reappears on
        // the opposite one. Lerping across that whole span would look like a
        // teleport streak, so on a big jump we snap (prev = curr) instead.
        const half = gridSize / 2;
        const wrapped = Math.abs(c.x - existing.currX) > half || Math.abs(c.y - existing.currY) > half;
        map.set(key, {
          prevX: wrapped ? c.x : existing.currX,
          prevY: wrapped ? c.y : existing.currY,
          currX: c.x, currY: c.y,
          changedAt: now, size: c.size, color: c.color, glyph: c.glyph, isPredator: c.isPredator, ownerKey,
        });
      } else {
        // Position unchanged (e.g. only energy/size changed this tick) --
        // refresh cosmetic fields (including size, so growth from a meal is
        // visible immediately) without resetting the lerp in progress.
        existing.size = c.size;
        existing.color = c.color;
        existing.glyph = c.glyph;
        existing.isPredator = c.isPredator;
        existing.ownerKey = ownerKey;
      }
    }
    for (const key of [...map.keys()]) {
      if (!seen.has(key)) map.delete(key); // died
    }
  }, [creatures, gridSize]);

  // ---- Drawing: reads everything from refs, so it never needs recreating ----
  const draw = useCallback((now: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { cssWidth, cssHeight } = viewportRef.current;
    const cam = cameraRef.current;
    const size = gridSizeRef.current;

    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = VOID_COLOR; // outside the dish, visible once panned past the edge
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    // One helper, all drawing goes through it -- no scattered offset math.
    const worldToScreen = (wx: number, wy: number) => ({
      x: (wx - cam.x) * cam.zoom + cssWidth / 2,
      y: (wy - cam.y) * cam.zoom + cssHeight / 2,
    });

    // The world is a torus: figure out which integer copies of the grid touch
    // the viewport, then tile every layer across them so panning never hits an
    // edge. Usually 1 copy on each axis, up to 2-3 near a seam.
    const tilesX: number[] = [];
    const tilesY: number[] = [];
    if (size > 0) {
      const halfW = cssWidth / 2 / cam.zoom;
      const halfH = cssHeight / 2 / cam.zoom;
      const kxMin = Math.floor((cam.x - halfW) / size);
      const kxMax = Math.min(Math.floor((cam.x + halfW) / size), kxMin + 3);
      const kyMin = Math.floor((cam.y - halfH) / size);
      const kyMax = Math.min(Math.floor((cam.y + halfH) / size), kyMin + 3);
      for (let k = kxMin; k <= kxMax; k++) tilesX.push(k * size);
      for (let k = kyMin; k <= kyMax; k++) tilesY.push(k * size);
    } else {
      tilesX.push(0);
      tilesY.push(0);
    }

    const onScreen = (px: number, py: number, pad: number) =>
      px >= -pad && px <= cssWidth + pad && py >= -pad && py <= cssHeight + pad;
    const wrappedDist = (a: number, b: number) => {
      const d = Math.abs(a - b);
      return size > 0 ? Math.min(d, size - d) : d;
    };

    // Terrain: one tiny (gridSize x gridSize) texture drawn hugely upscaled,
    // once per visible world-copy. Bilinear smoothing gives the soft-field
    // blur for free.
    if (size > 0) {
      const terrainCanvas = terrainCanvasRef.current;
      if (terrainCanvas) {
        ctx.imageSmoothingEnabled = true;
        for (const ox of tilesX) {
          for (const oy of tilesY) {
            const tl = worldToScreen(ox, oy);
            const br = worldToScreen(ox + size, oy + size);
            ctx.drawImage(terrainCanvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
          }
        }
      }
    }

    // Food: small bright particles with a faint bloom -- the only other
    // saturated thing on screen besides creatures. Tiled across world copies.
    for (const ox of tilesX) {
      for (const oy of tilesY) {
        for (const f of foodRef.current) {
          const p = worldToScreen(f.x + 0.5 + ox, f.y + 0.5 + oy);
          if (!onScreen(p.x, p.y, 20)) continue;
          const r = Math.max(1.5, cam.zoom * 0.1) * (FOOD_SIZE_MULT[f.kind] ?? 1);
          const color = FOOD_COLORS[f.kind] ?? FOOD_COLOR;

          const bloom = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
          bloom.addColorStop(0, color);
          bloom.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = bloom;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Powerups: bigger, brighter 4-point sparkles, one colour per kind. When
    // one is within POWERUP_NEAR_CELLS of the viewer's nearest creature it
    // gets a pulsing ring and a name label ("Speed · press P").
    const myKey = myOwnerKeyRef.current;
    const myCreatures = myKey
      ? creaturesRef.current.filter(c => !c.isPredator && c.owner?.toHexString() === myKey)
      : [];
    const spin = (now / 2600) % (Math.PI * 2);
    for (const ox of tilesX) {
      for (const oy of tilesY) {
        for (const pu of powerupsRef.current) {
          const p = worldToScreen(pu.x + 0.5 + ox, pu.y + 0.5 + oy);
          if (!onScreen(p.x, p.y, 60)) continue;
          const color = POWERUP_COLORS[pu.kind] ?? '#ffffff';
          const rr = Math.max(3, cam.zoom * 0.32);

          const bloom = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr * 3.2);
          bloom.addColorStop(0, color);
          bloom.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = bloom;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 3.2, 0, Math.PI * 2);
          ctx.fill();

          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(spin);
          ctx.fillStyle = color;
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2;
            ctx.lineTo(Math.cos(a) * rr * 1.9, Math.sin(a) * rr * 1.9);
            const b = a + Math.PI / 4;
            ctx.lineTo(Math.cos(b) * rr * 0.7, Math.sin(b) * rr * 0.7);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();

          let nearMine = Infinity;
          for (const c of myCreatures) {
            nearMine = Math.min(nearMine, wrappedDist(c.x, pu.x) + wrappedDist(c.y, pu.y));
          }
          if (nearMine <= POWERUP_NEAR_CELLS) {
            const pulse = 1 + 0.18 * Math.sin(now / 220);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.arc(p.x, p.y, rr * 3.2 * pulse, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;

            const label = `${POWERUP_SHORT[pu.kind] ?? 'Powerup'} · press P`;
            ctx.font = '600 12px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(5,7,12,0.75)';
            ctx.fillRect(p.x - tw / 2 - 5, p.y - rr * 3.2 - 20, tw + 10, 16);
            ctx.fillStyle = color;
            ctx.fillText(label, p.x, p.y - rr * 3.2 - 6);
          }
        }
      }
    }

    // Creatures: glowing organisms, tiled across visible world copies so one
    // near a seam shows on both sides. A firm dark outline keeps lineage
    // colour reading clearly against every biome. Predators break the rules
    // on purpose -- sharp diamond, fixed red/white, no glow.
    for (const ox of tilesX) {
      for (const oy of tilesY) {
        for (const entry of interpRef.current.values()) {
          const t = Math.min(1, (now - entry.changedAt) / tickIntervalMsRef.current);
          const wx = entry.prevX + (entry.currX - entry.prevX) * t + 0.5 + ox;
          const wy = entry.prevY + (entry.currY - entry.prevY) * t + 0.5 + oy;
          const p = worldToScreen(wx, wy);
          const radius = Math.max(3, entry.size * cam.zoom * 0.5);
          if (!onScreen(p.x, p.y, radius * 2 + 12)) continue;

          if (entry.isPredator) {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.beginPath();
            ctx.moveTo(0, -radius);
            ctx.lineTo(radius, 0);
            ctx.lineTo(0, radius);
            ctx.lineTo(-radius, 0);
            ctx.closePath();
            ctx.fillStyle = PREDATOR_FILL;
            ctx.fill();
            ctx.strokeStyle = PREDATOR_STROKE;
            ctx.lineWidth = Math.max(1.5, radius * 0.25);
            ctx.stroke();
            ctx.restore();
            continue;
          }

          const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 1.8);
          glow.addColorStop(0, entry.color);
          glow.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(p.x, p.y, radius * 1.8, 0, Math.PI * 2);
          ctx.fill();

          // The LLM-assigned emoji, sized directly off `radius` so growth
          // from meals reads as a visibly bigger glyph. Font size, not a
          // transform, so it stays crisp at any zoom.
          ctx.font = `${radius * 2}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(entry.glyph, p.x, p.y);

          const label = entry.ownerKey ? ownerInitialsRef.current.get(entry.ownerKey) : undefined;
          if (label) {
            ctx.font = `${Math.max(9, radius * 0.7)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, p.x, p.y - radius - 2);
          }
        }
      }
    }
  }, []);

  // ---- One RAF loop: keyboard-driven camera movement + draw, every frame ----
  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - lastTime) / 1000); // clamp after tab-hidden gaps
      lastTime = now;

      const keys = heldKeysRef.current;
      if (keys.size > 0) {
        let dx = 0, dy = 0, zoomMul = 1;
        if (keys.has('arrowup') || keys.has('w')) dy -= 1;
        if (keys.has('arrowdown') || keys.has('s')) dy += 1;
        if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
        if (keys.has('arrowright') || keys.has('d')) dx += 1;
        if (keys.has('+') || keys.has('=')) zoomMul *= 1 + ZOOM_SPEED * dt;
        if (keys.has('-') || keys.has('_')) zoomMul /= 1 + ZOOM_SPEED * dt;
        if (dx !== 0 || dy !== 0 || zoomMul !== 1) {
          userAdjustedRef.current = true;
          const len = Math.hypot(dx, dy) || 1;
          setCamera(cam => clampCamera({
            x: cam.x + (dx / len) * PAN_SPEED * dt,
            y: cam.y + (dy / len) * PAN_SPEED * dt,
            zoom: cam.zoom * zoomMul,
          }, gridSizeRef.current));
        }
      }

      draw(now);
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [draw, clampCamera]);

  // P key: claim the powerup closest to any of the viewer's own creatures,
  // as long as it's within POWERUP_NEAR_CELLS. Reads only refs, so [] deps.
  const claimPowerupWithKey = useCallback(() => {
    const claim = onClaimPowerupRef.current;
    const myKey = myOwnerKeyRef.current;
    if (!claim || !myKey) return;
    const mine = creaturesRef.current.filter(
      c => !c.isPredator && c.owner?.toHexString() === myKey
    );
    if (mine.length === 0) return;
    let best: { id: bigint; d: number } | null = null;
    for (const pu of powerupsRef.current) {
      let d = Infinity;
      for (const c of mine) d = Math.min(d, Math.abs(c.x - pu.x) + Math.abs(c.y - pu.y));
      if (d <= POWERUP_NEAR_CELLS && (!best || d < best.d)) best = { id: pu.id, d };
    }
    if (best) claim(best.id);
  }, []);

  // ---- Keyboard: arrows/WASD pan, +/- zoom, 0 fits -- never while typing ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;
      const key = e.key.toLowerCase();
      if (key === '0') {
        e.preventDefault();
        userAdjustedRef.current = false; // explicit reset -- keep auto-fitting again after this
        fitCamera(gridSizeRef.current);
        return;
      }
      if (key === 'p') {
        e.preventDefault();
        claimPowerupWithKey();
        return;
      }
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', '+', '=', '-', '_'].includes(key)) {
        e.preventDefault();
        heldKeysRef.current.add(key);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      heldKeysRef.current.delete(e.key.toLowerCase());
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [fitCamera, claimPowerupWithKey]);

  // ---- Pointer events: one finger pans, two pinch-zoom around the midpoint ----
  const screenToWorld = useCallback((sx: number, sy: number, cam: Camera) => {
    const { cssWidth, cssHeight } = viewportRef.current;
    return { x: cam.x + (sx - cssWidth / 2) / cam.zoom, y: cam.y + (sy - cssHeight / 2) / cam.zoom };
  }, []);

  // Powerup under a world point, within `radiusCells` (tap-to-claim). The tap
  // point can land outside [0,size) because the camera wraps, so distance is
  // measured on the torus.
  const powerupNear = useCallback((wx: number, wy: number, radiusCells: number): bigint | null => {
    const size = gridSizeRef.current;
    const axis = (a: number, b: number) => {
      const d = Math.abs(a - b);
      return size > 0 ? Math.min(d, size - d) : d;
    };
    let best: { id: bigint; d: number } | null = null;
    for (const pu of powerupsRef.current) {
      const d = Math.hypot(axis(pu.x + 0.5, wx), axis(pu.y + 0.5, wy));
      if (d <= radiusCells && (!best || d < best.d)) best = { id: pu.id, d };
    }
    return best?.id ?? null;
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pointersRef.current.set(e.pointerId, pt);
    if (pointersRef.current.size === 1) {
      tapRef.current = { sx: pt.x, sy: pt.y, moved: false };
    } else if (pointersRef.current.size === 2) {
      tapRef.current = null; // a second finger -> this is a pinch, not a tap
      const [p0, p1] = [...pointersRef.current.values()];
      pinchRef.current = {
        dist: Math.hypot(p0.x - p1.x, p0.y - p1.y),
        midX: (p0.x + p1.x) / 2,
        midY: (p0.y + p1.y) / 2,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const prev = pointersRef.current.get(e.pointerId)!;
    const curr = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pointersRef.current.set(e.pointerId, curr);
    const size = gridSizeRef.current;

    if (pointersRef.current.size === 1) {
      const tap = tapRef.current;
      if (tap && !tap.moved && Math.hypot(curr.x - tap.sx, curr.y - tap.sy) > 6) {
        tap.moved = true; // travelled too far to count as a tap
      }
      userAdjustedRef.current = true;
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      setCamera(cam => clampCamera({ ...cam, x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom }, size));
    } else if (pointersRef.current.size === 2 && pinchRef.current) {
      userAdjustedRef.current = true;
      const [p0, p1] = [...pointersRef.current.values()];
      const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      const midX = (p0.x + p1.x) / 2;
      const midY = (p0.y + p1.y) / 2;
      const prevPinch = pinchRef.current;

      setCamera(cam => {
        const worldUnderMid = screenToWorld(prevPinch.midX, prevPinch.midY, cam);
        const newZoom = Math.max(minZoomRef.current, Math.min(MAX_ZOOM, cam.zoom * (dist / prevPinch.dist)));
        const { cssWidth, cssHeight } = viewportRef.current;
        return clampCamera({
          x: worldUnderMid.x - (midX - cssWidth / 2) / newZoom,
          y: worldUnderMid.y - (midY - cssHeight / 2) / newZoom,
          zoom: newZoom,
        }, size);
      });

      pinchRef.current = { dist, midX, midY };
    }
  };

  const endPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;

    const tap = tapRef.current;
    if (tap && !tap.moved && pointersRef.current.size === 0) {
      const w = screenToWorld(tap.sx, tap.sy, cameraRef.current);
      const size = gridSizeRef.current;
      // A tap on (or very near) a powerup claims it -- takes priority over
      // dropping food.
      const hitPowerup = onClaimPowerupRef.current
        ? powerupNear(w.x, w.y, Math.max(1.5, 14 / cameraRef.current.zoom))
        : null;
      if (hitPowerup !== null) {
        onClaimPowerupRef.current!(hitPowerup);
      } else if (placeModeRef.current && onPlaceFoodRef.current && size > 0) {
        // The camera wraps, so a tap can resolve outside [0,size) -- fold it
        // back onto the torus before dropping food.
        const cx = ((Math.floor(w.x) % size) + size) % size;
        const cy = ((Math.floor(w.y) % size) + size) % size;
        onPlaceFoodRef.current(cx, cy);
      }
    }
    if (pointersRef.current.size === 0) tapRef.current = null;
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (pseudoFs) {
      setPseudoFs(false);
      return;
    }
    const el = containerRef.current;
    const req = el?.requestFullscreen?.bind(el);
    if (req) {
      // If the browser has the API but rejects (some in-app webviews),
      // fall back to the CSS overlay rather than doing nothing.
      Promise.resolve(req()).catch(() => setPseudoFs(true));
    } else {
      setPseudoFs(true); // iOS Safari — no Fullscreen API at all
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        aspectRatio: expanded ? undefined : '1',
        height: expanded ? '100%' : undefined,
        maxHeight: expanded ? undefined : '75vh',
        background: VOID_COLOR,
        borderRadius: expanded ? 0 : 8,
        overflow: 'hidden',
        touchAction: 'none',
        // pseudo-fullscreen: fill the viewport ourselves (iOS Safari path)
        position: pseudoFs ? 'fixed' : 'relative',
        inset: pseudoFs ? 0 : undefined,
        zIndex: pseudoFs ? 2000 : undefined,
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          touchAction: 'none',
          outline: 'none',
          cursor: placeMode ? 'crosshair' : 'default',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
      />
      <button
        type="button"
        onClick={toggleFullscreen}
        aria-label={expanded ? 'Exit fullscreen' : 'Enter fullscreen'}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 44,
          height: 44,
          borderRadius: 6,
          border: 'none',
          background: 'rgba(5, 7, 12, 0.6)',
          color: '#9dffcf',
          fontSize: 20,
          lineHeight: 1,
          cursor: 'pointer',
          zIndex: 1,
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {expanded ? '⤡' : '⤢'}
      </button>
    </div>
  );
}
