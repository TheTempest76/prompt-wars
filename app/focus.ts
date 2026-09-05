'use client';

// Tiny pub-sub so SpawnCreature can tell WorldCanvas "center the camera on
// this newly-spawned creature" -- the two are siblings in the tree with no
// shared parent state, and threading a ref through page.tsx (a server
// component) would be heavier than this.

type Listener = (creatureId: bigint) => void;

const listeners = new Set<Listener>();

export function requestFocusCreature(creatureId: bigint): void {
  for (const listener of listeners) listener(creatureId);
}

export function onFocusCreature(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
