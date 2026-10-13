'use client';
import { useSyncExternalStore } from 'react';
import type { AnimeDisplayMode } from '../components/anime-collection';

const storageKey = 'guoman:anime-display-mode';
const changeEvent = 'guoman:anime-display-change';
let currentMode: AnimeDisplayMode | null = null;
let initialized = false;

function parseMode(value: string | null): AnimeDisplayMode | null {
  return value === 'list' || value === 'grid' ? value : null;
}

function snapshot(): AnimeDisplayMode | null {
  if (!initialized) {
    try { currentMode = parseMode(window.localStorage.getItem(storageKey)); } catch { /* 使用会话内偏好。 */ }
    initialized = true;
  }
  return currentMode;
}
function subscribe(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    try { if (event.storageArea !== window.localStorage) return; } catch { return; }
    currentMode = parseMode(event.newValue);
    initialized = true;
    notify();
  };
  window.addEventListener(changeEvent, notify);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(changeEvent, notify); window.removeEventListener('storage', onStorage); };
}
function selectMode(mode: AnimeDisplayMode) {
  currentMode = mode;
  initialized = true;
  try { window.localStorage.setItem(storageKey, mode); } catch { /* 存储不可用时，本次页面会话仍可切换。 */ }
  window.dispatchEvent(new Event(changeEvent));
}

/** useAnimeDisplayMode（展示偏好）：跨页面和标签页同步选择；服务端使用原页面默认形式，避免水合不一致。 */
export function useAnimeDisplayMode(defaultMode: AnimeDisplayMode) {
  const mode = useSyncExternalStore(subscribe, snapshot, () => null);
  return [mode ?? defaultMode, selectMode] as const;
}
