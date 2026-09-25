/**
 * Which backend the app talks to, and over which path (Integration Plan §9.5):
 * local controller first, then the cloud replica, else offline. Demo mode is a
 * separate, always-labelled choice that never touches a backend.
 *
 * One saved controller address per network mode (MAgSO Wi-Fi, dedicated router,
 * Pi hotspot) — they are tried in order until one answers.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { normaliseBase, probe } from '../api/client';
import type { Link } from '../providers/types';

export type DataMode = 'live' | 'demo';

export interface ControllerAddress { label: string; url: string }

export interface ConnectionSettings {
  mode: DataMode;
  controllers: ControllerAddress[];
  cloudUrl: string;
}

interface ConnectionApi extends ConnectionSettings {
  link: Link;
  activeBase: string | null;
  checking: boolean;
  lastCheckedAt: string | null;
  setMode: (m: DataMode) => void;
  setControllers: (c: ControllerAddress[]) => void;
  setCloudUrl: (u: string) => void;
  resolve: () => Promise<{ link: Link; base: string | null }>;
  /** Probe one address without saving it (for the pairing screen). */
  test: (url: string) => Promise<{ ok: boolean; role?: string; controllerOnline?: boolean; base: string }>;
}

const STORAGE_KEY = 'sg-connection';

function defaultControllers(): ControllerAddress[] {
  if (typeof window === 'undefined') return [];
  if (Capacitor.isNativePlatform()) return [
    { label: 'Pi hotspot', url: 'http://10.42.0.1:8000' },
  ];
  const { hostname, port, origin } = window.location;
  // Vite / Ionic dev servers: the API runs separately on :8000.
  if (['5173', '8100', '3000', '4173'].includes(port)) return [{ label: 'Dev controller', url: `http://${hostname || 'localhost'}:8000` }];
  // Otherwise the page was served by the controller (or the cloud replica) itself.
  return [{ label: 'This server', url: origin }];
}

function load(): ConnectionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return { mode: s.mode === 'demo' ? 'demo' : 'live', controllers: Array.isArray(s.controllers) ? s.controllers : defaultControllers(), cloudUrl: s.cloudUrl ?? '' };
    }
  } catch { /* ignore corrupt storage */ }
  return { mode: 'live', controllers: defaultControllers(), cloudUrl: '' };
}

const Ctx = createContext<ConnectionApi | null>(null);

export const useConnection = (): ConnectionApi => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useConnection() must be used within ConnectionProvider');
  return c;
};

export const ConnectionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<ConnectionSettings>(load);
  const [link, setLink] = useState<Link>(settings.mode === 'demo' ? 'demo' : 'offline');
  const [activeBase, setActiveBase] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const inflight = useRef<Promise<{ link: Link; base: string | null }> | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
  }, [settings]);

  const resolve = useCallback(async (): Promise<{ link: Link; base: string | null }> => {
    if (settings.mode === 'demo') {
      setLink('demo'); setActiveBase(null);
      return { link: 'demo', base: null };
    }
    if (inflight.current) return inflight.current;
    const run = (async (): Promise<{ link: Link; base: string | null }> => {
      setChecking(true);
      try {
        const bases = settings.controllers.map(c => normaliseBase(c.url));
        const results = await Promise.all(bases.map(b => probe(b)));
        const i = results.findIndex(r => r.ok && r.role !== 'cloud');
        if (i >= 0) { setActiveBase(bases[i]); setLink('local'); return { link: 'local', base: bases[i] }; }
        const c = results.findIndex(r => r.ok && r.role === 'cloud');
        if (c >= 0) { setActiveBase(bases[c]); setLink('remote'); return { link: 'remote', base: bases[c] }; }
        if (settings.cloudUrl) {
          const cb = normaliseBase(settings.cloudUrl);
          const r = await probe(cb, 5000);
          if (r.ok) { setActiveBase(cb); setLink('remote'); return { link: 'remote', base: cb }; }
        }
        setLink('offline');
        return { link: 'offline', base: null };
      } finally {
        setChecking(false);
        setLastCheckedAt(new Date().toISOString());
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }, [settings]);

  // Re-resolve when settings change, when the app comes back to the foreground, and periodically while not local.
  useEffect(() => { resolve(); }, [resolve]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') resolve(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [resolve]);
  useEffect(() => {
    if (settings.mode === 'demo' || link === 'local') return;
    const id = setInterval(() => { resolve(); }, link === 'offline' ? 15_000 : 60_000);
    return () => clearInterval(id);
  }, [settings.mode, link, resolve]);

  const api = useMemo<ConnectionApi>(() => ({
    ...settings, link, activeBase, checking, lastCheckedAt, resolve,
    setMode: (mode) => setSettings(s => ({ ...s, mode })),
    setControllers: (controllers) => setSettings(s => ({ ...s, controllers })),
    setCloudUrl: (cloudUrl) => setSettings(s => ({ ...s, cloudUrl })),
    test: async (url) => { const base = normaliseBase(url); return { ...(await probe(base, 4000)), base }; },
  }), [settings, link, activeBase, checking, lastCheckedAt, resolve]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
};
