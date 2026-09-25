/**
 * Read-only wall display for the greenhouse screen (browser kiosk on the Pi or any browser on
 * the network). No sign-in: the controller issues a display-only token to requests from the Pi
 * itself, or to anyone who knows GH_KIOSK_TOKEN (/kiosk?token=...). /kiosk?demo=1 shows the
 * simulation instead, for previews and as a defence fallback.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { IonPage, IonContent, IonIcon } from '@ionic/react';
import { useLocation } from 'react-router-dom';
import { ApiClient, normaliseBase } from '../api/client';
import type { MqttInfo } from '../contract/types';
import { useConnection } from '../contexts/ConnectionContext';
import { LiveProvider } from '../providers/LiveProvider';
import { DemoProvider } from '../providers/DemoProvider';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { formatMetric, METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import { METRIC_ICON, ACTUATOR_ICON, statusColor } from '../components/display';
import { alertTitle } from '../contract/codes';
import { timeAgo, untilText } from '../components/format';

const TILES: MetricKey[] = ['temperature', 'humidity', 'soil_moisture', 'light', 'co2', 'ph', 'water_level', 'hopper_weight'];
const DEVICES = ['irrigation', 'lights', 'auger', 'fan_exhaust'];

const KioskView: React.FC = () => {
  const gh = useGreenhouse();
  const [now, setNow] = useState(new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const stage = gh.meta.stages.find(s => s.id === gh.activeStageId);
  const stale = gh.lastUpdate ? Date.now() - Date.parse(gh.lastUpdate) > 120_000 : true;
  const status = gh.mode === 'demo' ? { t: 'DEMO — SIMULATED DATA', c: '#f59e0b' }
    : !gh.ready ? { t: 'CONNECTING…', c: '#94a3b8' }
    : !gh.controllerOnline || stale ? { t: 'CONTROLLER NOT REPORTING', c: '#ef4444' }
    : { t: gh.streaming ? 'LIVE' : 'UPDATING', c: '#22c55e' };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--sg-bg)', color: 'var(--sg-text)', padding: '2vh 2.5vw', display: 'flex', flexDirection: 'column', gap: '2vh', cursor: 'none' }}>
      <div className="sg-row-between">
        <div>
          <div style={{ fontSize: 'clamp(20px, 3vw, 44px)', fontWeight: 800 }}>🌿 {gh.meta.name}</div>
          <div style={{ fontSize: 'clamp(12px, 1.4vw, 22px)', color: 'var(--sg-muted)' }}>
            {stage?.name} stage · {stage?.irrigation_mode} irrigation · updated {timeAgo(gh.lastUpdate)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 'clamp(24px, 4vw, 60px)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          <div style={{ fontSize: 'clamp(12px, 1.3vw, 20px)', fontWeight: 700, color: status.c }}>● {status.t}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1.5vw', flex: 1 }}>
        {TILES.map(k => {
          const m = gh.metrics[k];
          const c = statusColor(m.status);
          return (
            <div key={k} className="sg-card" style={{ margin: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderTop: `4px solid ${c}`, opacity: m.installed ? 1 : 0.4 }}>
              <div className="sg-row sg-gap-8" style={{ fontSize: 'clamp(12px, 1.4vw, 22px)', color: 'var(--sg-muted)' }}>
                <IonIcon icon={METRIC_ICON[k]} style={{ color: c }} /> {METRIC_INFO[k].label}
              </div>
              <div style={{ fontSize: 'clamp(28px, 5vw, 84px)', fontWeight: 800, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
                {k === 'hopper_weight' && m.value !== null ? (m.value / 1000).toFixed(2) : formatMetric(k, m.value)}
                <span style={{ fontSize: '0.35em', fontWeight: 500, color: 'var(--sg-muted)', marginLeft: 6 }}>{m.value !== null ? (k === 'hopper_weight' ? 'kg' : m.unit) : ''}</span>
              </div>
              <div style={{ fontSize: 'clamp(11px, 1.2vw, 18px)', color: m.note ? c : 'var(--sg-dim)' }}>
                {m.note ?? (m.band ? `target ${m.band.min}–${m.band.max}` : '')}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5vw' }}>
        <div className="sg-card" style={{ margin: 0 }}>
          <div style={{ fontSize: 'clamp(12px, 1.3vw, 20px)', color: 'var(--sg-muted)', marginBottom: 8 }}>Devices</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {DEVICES.map(id => {
              const def = gh.meta.actuators.find(a => a.id === id);
              const st = gh.actuators[id];
              if (!def) return null;
              return (
                <div key={id} className="sg-row sg-gap-8" style={{ fontSize: 'clamp(13px, 1.5vw, 24px)', opacity: def.installed ? 1 : 0.4 }}>
                  <IonIcon icon={ACTUATOR_ICON[id]} style={{ color: st?.on ? '#22c55e' : 'var(--sg-dim)' }} />
                  <span style={{ fontWeight: 600 }}>{def.name}</span>
                  <span style={{ color: st?.on ? '#22c55e' : 'var(--sg-dim)', fontWeight: 700 }}>
                    {!def.installed ? 'n/a' : st?.lockout ? st.lockout.replace('_', ' ') : st?.on ? `ON${st.circuit ? ` · ${st.circuit}` : ''}` : 'OFF'}
                  </span>
                  {st?.mode === 'MANUAL' && <span style={{ color: '#f59e0b', fontSize: '0.75em' }}>manual {untilText(st.manual_until)}</span>}
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 'clamp(11px, 1.1vw, 16px)', color: 'var(--sg-dim)', marginTop: 8 }}>
            Nodes: {gh.meta.nodes.map(n => `${n.id.replace('_', ' ')} ${gh.nodes[n.id] ? 'online' : 'OFFLINE'}`).join(' · ')}
          </div>
        </div>
        <div className="sg-card" style={{ margin: 0 }}>
          <div style={{ fontSize: 'clamp(12px, 1.3vw, 20px)', color: 'var(--sg-muted)', marginBottom: 8 }}>
            Open alerts ({gh.openAlerts.length})
          </div>
          {gh.openAlerts.length === 0 && <div style={{ fontSize: 'clamp(13px, 1.5vw, 24px)', color: '#22c55e', fontWeight: 600 }}>✓ No open alerts</div>}
          {gh.openAlerts.slice(0, 4).map(a => (
            <div key={a.id} style={{ fontSize: 'clamp(12px, 1.4vw, 22px)', marginBottom: 6 }}>
              <span style={{ color: a.severity === 'critical' || a.severity === 'high' ? '#ef4444' : '#f59e0b', fontWeight: 700 }}>{alertTitle(a.code)}</span>
              <span style={{ color: 'var(--sg-muted)' }}> · {a.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const Kiosk: React.FC = () => {
  const loc = useLocation();
  const conn = useConnection();
  const q = useMemo(() => new URLSearchParams(loc.search), [loc.search]);
  const demo = q.get('demo') === '1';
  const base = useMemo(() => {
    if (q.get('api')) return normaliseBase(q.get('api')!);
    if (window.location.port === '8000') return window.location.origin;
    return conn.activeBase ?? normaliseBase(`${window.location.hostname}:8000`);
  }, [q, conn.activeBase]);
  const [auth, setAuth] = useState<{ token: string; mqtt: MqttInfo | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (demo) return;
    let alive = true;
    const get = () => new ApiClient(base, { access: () => null, refresh: async () => null }).kioskToken(q.get('token') ?? undefined)
      .then(t => { if (alive) { setAuth({ token: t.access_token, mqtt: t.mqtt }); setErr(null); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : 'Cannot reach the controller.'); });
    get();
    const retry = setInterval(() => { if (!alive) return; get(); }, 6 * 3600_000);
    return () => { alive = false; clearInterval(retry); };
  }, [base, demo, q]);

  // Retry quickly while there is no token yet (controller still booting).
  useEffect(() => {
    if (demo || auth) return;
    const again = setInterval(() => {
      new ApiClient(base, { access: () => null, refresh: async () => null }).kioskToken(q.get('token') ?? undefined)
        .then(t => setAuth({ token: t.access_token, mqtt: t.mqtt })).catch(() => { /* keep waiting */ });
    }, 10_000);
    return () => clearInterval(again);
  }, [auth, base, demo, q]);

  const api = useMemo(() => auth ? new ApiClient(base, {
    access: () => auth.token,
    refresh: async () => {
      try { const t = await new ApiClient(base, { access: () => null, refresh: async () => null }).kioskToken(q.get('token') ?? undefined); setAuth({ token: t.access_token, mqtt: t.mqtt }); return t.access_token; }
      catch { return null; }
    },
  }) : null, [auth, base, q]);

  return (
    <IonPage>
      <IonContent>
        {demo ? <DemoProvider><KioskView /></DemoProvider>
          : api ? <LiveProvider override={{ api, mqtt: auth?.mqtt ?? null }}><KioskView /></LiveProvider>
          : (
            <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, background: 'var(--sg-bg)' }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--sg-text)' }}>🌿 Smart Greenhouse</div>
              <div style={{ fontSize: 16, color: 'var(--sg-muted)' }}>{err ? `Waiting for the controller at ${base} — ${err}` : 'Connecting…'}</div>
            </div>
          )}
      </IonContent>
    </IonPage>
  );
};

export default Kiosk;
