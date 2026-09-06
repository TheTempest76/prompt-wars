'use client';

// Transient corner notifications. A module-level pub-sub because the things
// that raise toasts (a creature dying in WorldView's subscription, a powerup
// claim resolving in WorldCanvas) are scattered across the tree.

export type ToastTone = 'info' | 'good' | 'bad';
export type Toast = { id: number; text: string; tone: ToastTone };

type Listener = (toast: Toast) => void;

const listeners = new Set<Listener>();
let nextId = 1;

export function pushToast(text: string, tone: ToastTone = 'info'): void {
  const toast: Toast = { id: nextId++, text, tone };
  for (const listener of listeners) listener(toast);
}

export function onToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
