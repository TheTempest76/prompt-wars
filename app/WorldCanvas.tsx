'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Creature, Food } from '../src/module_bindings/types';

interface WorldCanvasProps {
  gridSize: number;
  creatures: readonly Creature[];
  food: readonly Food[];
  terrainCells: string | undefined;
}

// Dim, desaturated base colour per biome index (0 bloom, 1 cold, 2 vent,
// 3 barren — matches spacetimedb/src/index.ts's BIOME_* constants). Kept
// dark on purpose: creatures/food are the only saturated things on screen.
const BIOME_BASE_RGB: [number, number, number][] = [
  [30, 92, 58], // nutrient bloom -- dim green
  [38, 66, 108], // cold shelf -- dim blue
  [118, 58, 32], // thermal vent -- dim orange
  [50, 46, 42], // barren -- dim neutral
];
const FOOD_COLOR = '#9dffcf';
const VOID_COLOR = '#05070c'; // outside the dish, when panned past the edge

// Cheap deterministic per-cell hash for a little brightness jitter texture
// on the terrain — not real noise, just enough grain to avoid flat blobs.
function hashCell(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296; // [0, 1)
}

// One pixel per world cell. The blurred, soft-field look isn't a blur
// filter — it's this tiny texture drawn hugely upscaled with the canvas's
// own bilinear image smoothing, which turns hard per-cell boundaries into
// smooth gradients for free.
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
      const jitter = 1 + (hashCell(x, y) - 0.5) * 0.35;
      const p = idx * 4;
      img.data[p] = Math.min(255, r * jitter);
      img.data[p + 1] = Math.min(255, g * jitter);
      img.data[p + 2] = Math.min(255, b * jitter);
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

// Matches CLAUDE.md's pinned 2s tick — creature positions lerp over this
// window instead of teleporting on every tick.
const TICK_INTERVAL_MS = 2000;
const MIN_ZOOM_ABS = 2;
const MAX_ZOOM = 48;
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
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  return (el as HTMLElement).isContentEditable === true;
}

export function WorldCanvas({ gridSize, creatures, food, terrainCells }: WorldCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Camera lives in React state per spec; a ref mirror lets the RAF loop
  // (and pointer/keyboard handlers) always read the latest value without
  // being recreated every time it changes.
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 8 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const gridSizeRef = useRef(gridSize);
  gridSizeRef.current = gridSize;
  const foodRef = useRef(food);
  foodRef.current = food;
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
  const hasFitRef = useRef(false);
  const interpRef = useRef(new Map<string, InterpEntry>());
  const heldKeysRef = useRef(new Set<string>());
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);

  const clampCamera = useCallback((cam: Camera, size: number): Camera => {
    const { cssWidth, cssHeight } = viewportRef.current;
    const zoom = Math.max(minZoomRef.current, Math.min(MAX_ZOOM, cam.zoom));
    const halfW = cssWidth / 2 / zoom;
    const halfH = cssHeight / 2 / zoom;
    // The viewport center must stay within the world's bounds (plus a
    // little breathing room) -- since the center is always on screen, this
    // guarantees the world can never be panned entirely off screen.
    const margin = Math.max(halfW, halfH) * 0.5;
    return {
      x: Math.max(-margin, Math.min(size + margin, cam.x)),
      y: Math.max(-margin, Math.min(size + margin, cam.y)),
      zoom,
    };
  }, []);

  const fitCamera = useCallback((size: number) => {
    const { cssWidth, cssHeight } = viewportRef.current;
    if (cssWidth === 0 || cssHeight === 0 || size <= 0) return;
    const fitZoom = Math.max(MIN_ZOOM_ABS, Math.min(cssWidth / size, cssHeight / size));
    minZoomRef.current = fitZoom * 0.4;
    setCamera({ x: size / 2, y: size / 2, zoom: fitZoom });
  }, []);

  const applyLayout = useCallback(() => {
    const size = gridSizeRef.current;
    const { cssWidth, cssHeight } = viewportRef.current;
    if (size <= 0 || cssWidth === 0 || cssHeight === 0) return;
    if (!hasFitRef.current) {
      hasFitRef.current = true;
      fitCamera(size);
    } else {
      setCamera(cam => clampCamera(cam, size));
    }
  }, [fitCamera, clampCamera]);

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
      if (!existing) {
        map.set(key, {
          prevX: c.x, prevY: c.y, currX: c.x, currY: c.y,
          changedAt: now, size: c.size, color: c.color,
        });
      } else if (existing.currX !== c.x || existing.currY !== c.y) {
        map.set(key, {
          prevX: existing.currX, prevY: existing.currY, currX: c.x, currY: c.y,
          changedAt: now, size: c.size, color: c.color,
        });
      } else {
        // Position unchanged (e.g. only energy/size changed this tick) --
        // refresh cosmetic fields without resetting the lerp in progress.
        existing.size = c.size;
        existing.color = c.color;
      }
    }
    for (const key of [...map.keys()]) {
      if (!seen.has(key)) map.delete(key); // died
    }
  }, [creatures]);

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

    if (size > 0) {
      const topLeft = worldToScreen(0, 0);
      const bottomRight = worldToScreen(size, size);
      const w = bottomRight.x - topLeft.x;
      const h = bottomRight.y - topLeft.y;

      // The dish itself: a tiny (gridSize x gridSize) texture drawn hugely
      // upscaled. Bilinear image smoothing does the soft-field blur for
      // free -- no blur filter, no per-frame cost beyond one drawImage.
      const terrainCanvas = terrainCanvasRef.current;
      if (terrainCanvas) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(terrainCanvas, topLeft.x, topLeft.y, w, h);
      }

      // Dish rim.
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(topLeft.x, topLeft.y, w, h);
    }

    // Food: small bright particles with a faint bloom -- the only other
    // saturated thing on screen besides creatures.
    for (const f of foodRef.current) {
      const p = worldToScreen(f.x + 0.5, f.y + 0.5);
      const r = Math.max(1.5, cam.zoom * 0.1);

      const bloom = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
      bloom.addColorStop(0, FOOD_COLOR);
      bloom.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = FOOD_COLOR;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Creatures: glowing organisms. A firm dark outline keeps lineage
    // colour reading clearly against every biome, not just the ones it
    // happens to contrast with by luck.
    for (const entry of interpRef.current.values()) {
      const t = Math.min(1, (now - entry.changedAt) / TICK_INTERVAL_MS);
      const wx = entry.prevX + (entry.currX - entry.prevX) * t + 0.5;
      const wy = entry.prevY + (entry.currY - entry.prevY) * t + 0.5;
      const p = worldToScreen(wx, wy);
      const radius = Math.max(3, entry.size * cam.zoom * 0.5);

      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 1.8);
      glow.addColorStop(0, entry.color);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = entry.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = Math.max(1, radius * 0.18);
      ctx.stroke();
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

  // ---- Keyboard: arrows/WASD pan, +/- zoom, 0 fits -- never while typing ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;
      const key = e.key.toLowerCase();
      if (key === '0') {
        e.preventDefault();
        fitCamera(gridSizeRef.current);
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
  }, [fitCamera]);

  // ---- Pointer events: one finger pans, two pinch-zoom around the midpoint ----
  const screenToWorld = useCallback((sx: number, sy: number, cam: Camera) => {
    const { cssWidth, cssHeight } = viewportRef.current;
    return { x: cam.x + (sx - cssWidth / 2) / cam.zoom, y: cam.y + (sy - cssHeight / 2) / cam.zoom };
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    pointersRef.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (pointersRef.current.size === 2) {
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
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      setCamera(cam => clampCamera({ ...cam, x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom }, size));
    } else if (pointersRef.current.size === 2 && pinchRef.current) {
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
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        aspectRatio: '1',
        maxHeight: '75vh',
        background: VOID_COLOR,
        borderRadius: 8,
        overflow: 'hidden',
        touchAction: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none', outline: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
      />
    </div>
  );
}
