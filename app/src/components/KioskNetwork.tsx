/**
 * Network panel on the greenhouse display (/kiosk). The display has no touch input in its
 * enclosure, so this is used with a USB keyboard and mouse plugged into the controller:
 * press N (or click the network chip) to open, Esc to close.
 *
 * Anyone at the display can see the connection status. Changing the Wi-Fi or the cloud server
 * needs an administrator to sign in on the panel; that session lives only in this page's memory
 * and ends after 5 minutes without input or when the panel closes.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IonButton, IonSpinner } from '@ionic/react';
import { ApiClient } from '../api/client';
import type { NetworkStatus, WifiNetwork } from '../contract/types';
import CloudSetup, { type CloudFns } from './CloudSetup';

const MODE_TEXT: Record<string, string> = {
  magso: 'MAgSO Wi-Fi', router: 'Team router', hotspot: 'Own hotspot (no internet)', ethernet: 'Cable (Ethernet)',
  none: 'Not connected', unknown: 'Unknown', dev: 'Development PC',
};
const IDLE_MS = 5 * 60_000;

const bars = (sig: number) => (sig >= 70 ? '▂▄▆█' : sig >= 50 ? '▂▄▆' : sig >= 30 ? '▂▄' : '▂');

interface Props { base: string | null; kioskApi: ApiClient | null; onClose: () => void }

const KioskNetwork: React.FC<Props> = ({ base, kioskApi, onClose }) => {
  const [net, setNet] = useState<NetworkStatus | null>(null);
  const [netErr, setNetErr] = useState<string | null>(null);
  const [admin, setAdmin] = useState<{ api: ApiClient; name: string } | null>(null);
  const [login, setLogin] = useState({ email: '', password: '' });
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'wifi' | 'cloud'>('wifi');
  const [scan, setScan] = useState<WifiNetwork[] | null>(null);
  const [form, setForm] = useState({ ssid: '', password: '', profile: 'magso' as 'magso' | 'router' });
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lastInput = useRef(Date.now());

  const reader = admin?.api ?? kioskApi;
  const loadNet = useCallback(() => {
    if (!reader) return;
    reader.network().then(n => { setNet(n); setNetErr(null); }).catch(e => setNetErr(e instanceof Error ? e.message : 'Cannot read the network status.'));
  }, [reader]);
  useEffect(() => { loadNet(); const id = setInterval(loadNet, 10_000); return () => clearInterval(id); }, [loadNet]);

  // Keyboard: Esc closes. Any input keeps the admin session alive; 5 min idle signs out.
  useEffect(() => {
    const touch = () => { lastInput.current = Date.now(); };
    const key = (e: KeyboardEvent) => { touch(); if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key); window.addEventListener('mousemove', touch); window.addEventListener('mousedown', touch);
    const idle = setInterval(() => { if (Date.now() - lastInput.current > IDLE_MS) { setAdmin(null); onClose(); } }, 15_000);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousemove', touch); window.removeEventListener('mousedown', touch); clearInterval(idle); };
  }, [onClose]);

  const signIn = async () => {
    if (!base) return;
    setBusy('login'); setLoginErr(null);
    try {
      const t = await new ApiClient(base, { access: () => null, refresh: async () => null }).login(login.email.trim(), login.password);
      if (t.user?.role !== 'admin') { setLoginErr('Only an administrator can change the network.'); return; }
      const token = t.access_token;
      setAdmin({ api: new ApiClient(base, { access: () => token, refresh: async () => null }), name: t.user.name });
      setLogin({ email: '', password: '' });
    } catch (e) { setLoginErr(e instanceof Error ? e.message : 'Sign-in failed.'); }
    finally { setBusy(null); }
  };

  const doScan = useCallback(async () => {
    if (!admin) return;
    setBusy('scan');
    try { setScan(await admin.api.wifiScan()); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Scan failed.' }); }
    finally { setBusy(null); }
  }, [admin]);
  useEffect(() => { if (admin && tab === 'wifi' && scan === null) doScan(); }, [admin, tab, scan, doScan]);

  const act = async (what: string, fn: () => Promise<{ ok: boolean; connected?: boolean; message: string }>) => {
    setBusy(what); setMsg(null);
    try { const r = await fn(); setMsg({ ok: r.connected !== false, text: r.message }); setForm(f => ({ ...f, password: '' })); loadNet(); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed.' }); }
    finally { setBusy(null); }
  };

  const cloudFns = useMemo<CloudFns | null>(() => {
    const a = admin?.api ?? kioskApi;
    if (!a) return null;
    return { load: () => a.cloud(), test: p => a.cloudTest(p), setup: p => a.cloudSetup(p) };
  }, [admin, kioskApi]);

  const fs = (n: number) => `clamp(${n}px, ${(n / 10.24).toFixed(2)}vw, ${Math.round(n * 1.8)}px)`;
  const input: React.CSSProperties = {
    width: '100%', background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 8, padding: '8px 10px',
    color: 'var(--sg-text)', fontSize: fs(14), fontFamily: 'inherit', outline: 'none', marginBottom: 8,
  };
  const row = (k: string, v: React.ReactNode) => (
    <div key={k} className="sg-row-between" style={{ padding: '5px 0', borderBottom: '1px solid var(--sg-border)', gap: 10 }}>
      <span style={{ fontSize: fs(12), color: 'var(--sg-muted)', flexShrink: 0 }}>{k}</span>
      <span style={{ fontSize: fs(12), color: 'var(--sg-text)', textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );

  return (
    <div role="dialog" aria-label="Network and cloud" data-testid="kiosk-network"
      style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, cursor: 'default' }}>
      <div style={{ width: 'min(96vw, 1180px)', maxHeight: '94vh', overflow: 'auto', background: 'var(--sg-bg)', border: '1px solid var(--sg-border)', borderRadius: 14, padding: '1.6vh 1.8vw' }}>
        <div className="sg-row-between" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: fs(20), fontWeight: 800, color: 'var(--sg-text)' }}>Network and cloud</div>
          <div className="sg-row sg-gap-8">
            {admin && <span style={{ fontSize: fs(12), color: 'var(--sg-muted)' }}>Signed in: {admin.name}</span>}
            {admin && <IonButton size="small" fill="outline" color="medium" onClick={() => setAdmin(null)}>Sign out</IonButton>}
            <IonButton size="small" onClick={onClose}>Close (Esc)</IonButton>
          </div>
        </div>

        {!base && <div style={{ fontSize: fs(14), color: '#f59e0b' }}>Demo display — network settings work only on the controller.</div>}

        {base && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.25fr', gap: '1.6vw' }}>
            {/* status: visible to anyone at the display */}
            <div className="sg-card" style={{ margin: 0 }}>
              <div className="sg-section-title">Connection now</div>
              {netErr && <div style={{ fontSize: fs(12), color: '#ef4444' }}>{netErr}</div>}
              {!net && !netErr && <IonSpinner name="dots" />}
              {net && (
                <>
                  {row('Mode', <b>{MODE_TEXT[net.mode] ?? net.mode}</b>)}
                  {row('Wi-Fi', net.wifi ? <>{net.wifi.ssid} <span style={{ color: '#22c55e', letterSpacing: -1 }}>{bars(net.wifi.signal)}</span> {net.wifi.signal}%</> : 'not connected')}
                  {row('Address', Object.entries(net.addresses).map(([k, v]) => `${v} (${k})`).join(', ') || '—')}
                  {row('Internet', net.internet ? <span style={{ color: '#22c55e', fontWeight: 700 }}>yes</span> : <span style={{ color: '#ef4444', fontWeight: 700 }}>no</span>)}
                  {row('Open the app at', net.app_urls.slice(0, 2).join('  ·  '))}
                  <div className="sg-section-title" style={{ marginTop: 12 }}>Saved networks (tried in this order)</div>
                  {row('1. MAgSO Wi-Fi', net.profiles.magso ?? <span style={{ color: 'var(--sg-dim)' }}>not set</span>)}
                  {row('2. Team router', net.profiles.router ?? <span style={{ color: 'var(--sg-dim)' }}>not set</span>)}
                  {row('3. Own hotspot', `${net.hotspot.ssid ?? '—'} · ${net.hotspot.address}`)}
                  {net.simulated && <div style={{ fontSize: fs(11), color: '#f59e0b', marginTop: 6 }}>Simulated network (development) — nothing is changed on this machine.</div>}
                </>
              )}
            </div>

            <div className="sg-card" style={{ margin: 0 }}>
              {!admin ? (
                <>
                  <div className="sg-section-title">Change settings</div>
                  <div style={{ fontSize: fs(12), color: 'var(--sg-muted)', marginBottom: 10 }}>
                    Changing the Wi-Fi or the cloud server needs an administrator account. The sign-in lasts until the panel closes
                    or 5 minutes without typing.
                  </div>
                  <input aria-label="Email" style={input} placeholder="Administrator email" autoComplete="off" value={login.email}
                    onChange={e => setLogin(l => ({ ...l, email: e.target.value }))} />
                  <input aria-label="Password" style={input} placeholder="Password" type="password" autoComplete="off" value={login.password}
                    onChange={e => setLogin(l => ({ ...l, password: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') signIn(); }} />
                  {loginErr && <div style={{ fontSize: fs(12), color: '#ef4444', marginBottom: 8 }}>{loginErr}</div>}
                  <IonButton disabled={busy === 'login' || !login.email || !login.password} onClick={signIn}>{busy === 'login' ? 'Signing in…' : 'Sign in'}</IonButton>
                  <div className="sg-section-title" style={{ marginTop: 16 }}>Cloud server</div>
                  {cloudFns && <CloudSetup fns={cloudFns} canEdit={false} />}
                </>
              ) : (
                <>
                  <div className="sg-row sg-gap-8" style={{ marginBottom: 12 }}>
                    {(['wifi', 'cloud'] as const).map(t => (
                      <span key={t} className={`sg-filter-pill ${tab === t ? 'active' : ''}`} style={{ fontSize: fs(13) }} onClick={() => { setTab(t); setMsg(null); }}>
                        {t === 'wifi' ? 'Wi-Fi' : 'Cloud server'}
                      </span>
                    ))}
                  </div>

                  {tab === 'wifi' && (
                    <>
                      <div className="sg-row-between" style={{ marginBottom: 6 }}>
                        <span style={{ fontSize: fs(12), color: 'var(--sg-muted)' }}>Networks in range — click one to fill in its name</span>
                        <IonButton size="small" fill="clear" disabled={!!busy} onClick={doScan}>{busy === 'scan' ? 'Scanning…' : 'Scan again'}</IonButton>
                      </div>
                      <div style={{ maxHeight: '22vh', overflow: 'auto', border: '1px solid var(--sg-border)', borderRadius: 8, marginBottom: 10 }}>
                        {scan === null && <div style={{ padding: 8 }}><IonSpinner name="dots" /></div>}
                        {scan?.map(n => (
                          <div key={n.ssid} onClick={() => setForm(f => ({ ...f, ssid: n.ssid }))} className="sg-row-between"
                            style={{ padding: '6px 10px', cursor: 'pointer', background: form.ssid === n.ssid ? 'rgba(34,197,94,0.12)' : undefined, borderBottom: '1px solid var(--sg-border)' }}>
                            <span style={{ fontSize: fs(13), color: 'var(--sg-text)', fontWeight: n.in_use ? 700 : 500 }}>{n.ssid}{n.in_use ? ' · connected' : ''}</span>
                            <span style={{ fontSize: fs(12), color: 'var(--sg-muted)' }}>{n.security === 'open' ? 'open' : '🔒'} <span style={{ color: '#22c55e' }}>{bars(n.signal)}</span></span>
                          </div>
                        ))}
                      </div>
                      <input aria-label="Network name" style={input} placeholder="Network name (SSID)" value={form.ssid} onChange={e => setForm(f => ({ ...f, ssid: e.target.value }))} />
                      <div style={{ position: 'relative' }}>
                        <input aria-label="Wi-Fi password" style={{ ...input, paddingRight: 60 }} placeholder="Wi-Fi password (empty for an open network)" type={showPw ? 'text' : 'password'}
                          autoComplete="off" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
                        <span onClick={() => setShowPw(x => !x)} style={{ position: 'absolute', right: 10, top: 9, fontSize: fs(11), color: 'var(--sg-muted)', cursor: 'pointer' }}>{showPw ? 'hide' : 'show'}</span>
                      </div>
                      <div style={{ fontSize: fs(12), color: 'var(--sg-muted)', marginBottom: 4 }}>Save as</div>
                      <div className="sg-row sg-gap-8" style={{ marginBottom: 10 }}>
                        {(['magso', 'router'] as const).map(p => (
                          <span key={p} className={`sg-filter-pill ${form.profile === p ? 'active' : ''}`} style={{ fontSize: fs(12) }} onClick={() => setForm(f => ({ ...f, profile: p }))}>
                            {p === 'magso' ? '1. MAgSO Wi-Fi (first choice)' : '2. Team router'}
                          </span>
                        ))}
                      </div>
                      <div className="sg-row sg-gap-8" style={{ flexWrap: 'wrap' }}>
                        <IonButton disabled={!!busy || !form.ssid.trim()} onClick={() => act('set', () => admin.api.wifiSet({ profile: form.profile, ssid: form.ssid.trim(), password: form.password }))}>
                          {busy === 'set' ? 'Connecting… (up to a minute)' : 'Save and connect'}
                        </IonButton>
                        <IonButton fill="outline" color="medium" disabled={!!busy} onClick={() => act('hotspot', () => admin.api.hotspot())}>Start hotspot</IonButton>
                        {net?.profiles[form.profile] && (
                          <IonButton fill="clear" color="danger" disabled={!!busy} onClick={() => act('forget', () => admin.api.wifiForget(form.profile))}>
                            Forget {form.profile === 'magso' ? 'MAgSO Wi-Fi' : 'router'}
                          </IonButton>
                        )}
                      </div>
                      <div style={{ fontSize: fs(11), color: 'var(--sg-dim)', marginTop: 8 }}>
                        If the controller cannot join, it starts its own hotspot within a minute so the app still works. The password is stored on the controller only and never shown again.
                      </div>
                    </>
                  )}

                  {tab === 'cloud' && cloudFns && <CloudSetup fns={cloudFns} canEdit large />}

                  {msg && (
                    <div style={{ marginTop: 10, padding: 10, borderRadius: 8, fontSize: fs(13), color: 'var(--sg-text)',
                      background: msg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${msg.ok ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'}` }}>
                      {msg.text}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        <div style={{ fontSize: fs(11), color: 'var(--sg-dim)', marginTop: 10 }}>
          Keyboard: N opens this panel · Esc closes it · Tab moves between fields · Enter signs in.
        </div>
      </div>
    </div>
  );
};

export default KioskNetwork;
