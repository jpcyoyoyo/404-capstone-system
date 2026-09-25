/**
 * Sign-in. In live mode the controller checks the password and issues tokens
 * (access + refresh); in demo mode any non-empty credentials open a clearly
 * labelled demo session that never reaches hardware.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { ApiClient, ApiError } from '../api/client';
import type { MqttInfo, SessionUser, TokenResponse } from '../contract/types';
import { useConnection } from './ConnectionContext';

export type { SessionUser };

export interface Session {
  mode: 'live' | 'demo';
  token: string;
  refreshToken: string | null;
  user: SessionUser;
  issuedAt: string;
  base: string | null;
  mqtt: MqttInfo | null;
}

export type LoginResult = { ok: true } | { ok: false; error: string };

interface AuthApi {
  session: Session | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  /** REST client for the active controller path; null in demo mode or while offline. */
  api: ApiClient | null;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => void;
  changePassword: (current: string, next: string) => Promise<LoginResult>;
}

const STORAGE_KEY = 'sg-session';

function loadInitial(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.mode && s.user) return s;
    }
  } catch { /* ignore corrupt storage */ }
  return null;
}

function newToken(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fromTokens(t: TokenResponse, base: string): Session {
  const u = t.user!;
  return {
    mode: 'live', token: t.access_token, refreshToken: t.refresh_token ?? null,
    user: { id: String(u.id), email: u.email, name: u.name, role: u.role },
    issuedAt: new Date().toISOString(), base, mqtt: t.mqtt,
  };
}

const Ctx = createContext<AuthApi>({
  session: null, isAuthenticated: false, isAdmin: false, api: null,
  login: async () => ({ ok: false, error: 'Auth not ready' }), logout: () => {},
  changePassword: async () => ({ ok: false, error: 'Auth not ready' }),
});

export const useAuth = () => useContext(Ctx);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const conn = useConnection();
  const [session, setSession] = useState<Session | null>(loadInitial);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    try {
      if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* storage unavailable */ }
  }, [session]);

  // Switching between demo and live invalidates the other mode's session.
  useEffect(() => {
    if (session && session.mode !== conn.mode) setSession(null);
  }, [conn.mode, session]);

  const refreshing = useRef<Promise<string | null> | null>(null);

  const api = useMemo(() => {
    if (conn.mode === 'demo' || !conn.activeBase) return null;
    const base = conn.activeBase;
    return new ApiClient(base, {
      access: () => sessionRef.current?.token ?? null,
      refresh: async () => {
        const s = sessionRef.current;
        if (!s?.refreshToken) return null;
        if (!refreshing.current) {
          refreshing.current = (async () => {
            try {
              const t = await new ApiClient(base, { access: () => null, refresh: async () => null }).refreshToken(s.refreshToken!);
              const next = fromTokens(t, base);
              setSession(next);
              sessionRef.current = next;
              return next.token;
            } catch {
              setSession(null);
              return null;
            } finally {
              refreshing.current = null;
            }
          })();
        }
        return refreshing.current;
      },
    });
  }, [conn.mode, conn.activeBase]);

  const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
    if (!email.trim() || !password.trim()) return { ok: false, error: 'Enter both an email and a password.' };
    if (conn.mode === 'demo') {
      await new Promise(r => setTimeout(r, 300));
      setSession({
        mode: 'demo', token: newToken(), refreshToken: null, issuedAt: new Date().toISOString(), base: null, mqtt: null,
        user: { id: 'demo-admin', name: email.split('@')[0] || 'Demo Administrator', email: email.trim(), role: 'admin' },
      });
      return { ok: true };
    }
    let base = conn.activeBase;
    if (!base) base = (await conn.resolve()).base;
    if (!base) {
      return { ok: false, error: 'Cannot reach the controller. Check you are on the greenhouse Wi-Fi and the address in Connection settings, or use Demo mode.' };
    }
    try {
      const t = await new ApiClient(base, { access: () => null, refresh: async () => null }).login(email, password);
      setSession(fromTokens(t, base));
      return { ok: true };
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 401 ? 'Wrong email or password.' : e instanceof Error ? e.message : 'Sign-in failed.';
      return { ok: false, error: msg };
    }
  }, [conn]);

  const logout = useCallback(() => {
    const s = sessionRef.current;
    if (s?.mode === 'live' && api) api.logout().catch(() => { /* offline: the token simply expires */ });
    setSession(null);
  }, [api]);

  const changePassword = useCallback(async (current: string, next: string): Promise<LoginResult> => {
    if (next.length < 8) return { ok: false, error: 'Use at least 8 characters.' };
    const s = sessionRef.current;
    if (!s) return { ok: false, error: 'Not signed in.' };
    if (s.mode === 'demo') { await new Promise(r => setTimeout(r, 300)); return { ok: true }; }
    if (!api) return { ok: false, error: 'Not connected to the controller.' };
    try {
      const t = await api.changePassword(current, next);
      setSession(fromTokens(t, api.base));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not change the password.' };
    }
  }, [api]);

  const value: AuthApi = {
    session, isAuthenticated: !!session && session.mode === conn.mode,
    isAdmin: session?.user.role === 'admin', api, login, logout, changePassword,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
