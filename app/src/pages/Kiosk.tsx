/**
 * Read-only wall display for the greenhouse screen (browser kiosk on the Pi or any browser on
 * the network). No sign-in: the controller issues a display-only token to requests from the Pi
 * itself, or to anyone who knows GH_KIOSK_TOKEN (/kiosk?token=...). /kiosk?demo=1 shows the
 * simulation instead, for previews and as a defence fallback.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IonPage, IonContent, IonIcon } from '@ionic/react';
import { useLocation } from 'react-router-dom';
import { checkmarkCircle, wifiOutline, cloudDoneOutline, cloudOfflineOutline } from 'ionicons/icons';
import { ApiClient, normaliseBase } from '../api/client';
import type { AlertItem, MqttInfo, NetworkStatus } from '../contract/types';
import { useConnection } from '../contexts/ConnectionContext';
import { LiveProvider } from '../providers/LiveProvider';
import { DemoProvider } from '../providers/DemoProvider';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { formatMetric, METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import { METRIC_ICON, ACTUATOR_ICON, statusColor } from '../components/display';
import { alertTitle, reasonText } from '../contract/codes';
import { fmtTime, timeAgo, untilText } from '../components/format';
import { scheduleLine } from '../providers/stageSchedule';
import KioskNetwork from '../components/KioskNetwork';

const TILES: MetricKey[] = ['temperature', 'humidity', 'soil_moisture', 'light', 'co2', 'ph', 'water_level', 'stock_weight'];
const DEVICES = ['irrigation', 'lights', 'doser', 'fan_exhaust'];
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEV_COLOR: Record<string, string> = { critical: '#dc2626', high: '#ef4444', medium: '#f59e0b', low: '#3b82f6' };
const NET_MODE: Record<string, string> = { magso: 'MAgSO Wi-Fi', router: 'Router', hotspot: 'Hotspot', ethernet: 'Ethernet', none: 'No network', dev: 'Dev PC' };

/** Font size that scales with the screen: n px on the 1024-px display, larger on a TV. */
const fz = (n: number) => `clamp(${Math.round(n * 0.8)}px, ${(n / 10.24).toFixed(2)}vw, ${Math.round(n * 2)}px)`;

const DeviceTile: React.FC<{ id: string }> = ({ id }) => {
  const gh = useGreenhouse();
  const def = gh.meta.actuators.find(a => a.id === id);
  const st = gh.actuators[id];
  if (!def) return null;
  const locked = def.installed && !!st?.lockout && st.lockout !== 'NOT_INSTALLED';
  const on = !!st?.on && def.installed;
  const color = !def.installed ? '#64748b' : locked ? '#ef4444' : on ? '#22c55e' : '#94a3b8';
  const badge = !def.installed ? 'N/A' : locked ? 'LOCKED' : on ? 'ON' : 'OFF';
  const detail = !def.installed ? 'Not installed'
    : locked ? reasonText(st?.lockout, st?.lockout ?? '')
    : st?.mode === 'MANUAL' ? `Manual · ${st.manual_until ? untilText(st.manual_until) : 'held'}`
    : `Automatic${st?.since ? ` · since ${fmtTime(st.since)}` : ''}`;
  const circuit = id === 'irrigation' ? (on ? st?.circuit : st?.stage_circuit) : null;
  return (
    <div data-testid={`kiosk-device-${id}`} style={{ display: 'flex', alignItems: 'center', gap: '0.9vw', padding: '0.9vh 0.8vw', borderRadius: 10,
      background: on ? 'rgba(34,197,94,0.10)' : 'var(--sg-elevated)', border: `1px solid ${on ? 'rgba(34,197,94,0.45)' : locked ? 'rgba(239,68,68,0.45)' : 'var(--sg-border)'}`,
      opacity: def.installed ? 1 : 0.55, minWidth: 0 }}>
      <div style={{ width: fz(38), height: fz(38), borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `${color}26`, color, fontSize: fz(20) }}>
        <IonIcon icon={ACTUATOR_ICON[id]} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sg-row-between" style={{ gap: 6 }}>
          <span style={{ fontSize: fz(15), fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.name}</span>
          <span style={{ fontSize: fz(12), fontWeight: 800, letterSpacing: 0.5, padding: '1px 8px', borderRadius: 999, flexShrink: 0,
            background: on ? '#22c55e' : 'transparent', color: on ? '#04210f' : color, border: `1.5px solid ${color}` }}>{badge}</span>
        </div>
        <div style={{ fontSize: fz(11.5), color: st?.mode === 'MANUAL' ? '#f59e0b' : locked ? '#ef4444' : 'var(--sg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {detail}{circuit ? ` · ${circuit} circuit` : ''}
        </div>
      </div>
    </div>
  );
};

const AlertRow: React.FC<{ a: AlertItem }> = ({ a }) => {
  const c = SEV_COLOR[a.severity] ?? '#94a3b8';
  return (
    <div style={{ display: 'flex', gap: '0.8vw', alignItems: 'stretch', padding: '0.6vh 0', borderBottom: '1px solid var(--sg-border)' }}>
      <div style={{ width: 4, borderRadius: 2, background: c, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sg-row-between" style={{ gap: 8 }}>
          <span style={{ fontSize: fz(14), fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ fontSize: fz(10), fontWeight: 800, color: c, border: `1px solid ${c}`, borderRadius: 4, padding: '0 5px', marginRight: 6, verticalAlign: 'middle' }}>
              {a.severity.toUpperCase()}
            </span>
            {alertTitle(a.code)}
          </span>
          <span style={{ fontSize: fz(11), color: 'var(--sg-dim)', flexShrink: 0 }}>{timeAgo(a.raised_at)}{a.acknowledged_at ? ' · seen' : ''}</span>
        </div>
        <div style={{ fontSize: fz(11.5), color: 'var(--sg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.message}</div>
      </div>
    </div>
  );
};

const KioskView: React.FC<{ base: string | null; kioskApi: ApiClient | null }> = ({ base, kioskApi }) => {
  const gh = useGreenhouse();
  const [now, setNow] = useState(new Date());
  const [panel, setPanel] = useState(false);
  const [cursor, setCursor] = useState(false);
  const [net, setNet] = useState<NetworkStatus | null>(null);
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);

  // A mouse may be plugged in for the Network panel: show the pointer while it moves, hide it when idle.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const move = () => { setCursor(true); clearTimeout(t); t = setTimeout(() => setCursor(false), 4000); };
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mousemove', move); clearTimeout(t); };
  }, []);
  // N opens the Network panel (keyboard plugged into the controller).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (!panel && (e.key === 'n' || e.key === 'N') && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); setPanel(true); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [panel]);
  useEffect(() => {
    if (!kioskApi) return;
    const load = () => kioskApi.network().then(setNet).catch(() => setNet(null));
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [kioskApi, panel]);
  const closePanel = useCallback(() => setPanel(false), []);

  const stage = gh.meta.stages.find(s => s.id === gh.activeStageId);
  const sched = gh.stageSchedule;
  const stale = gh.lastUpdate ? Date.now() - Date.parse(gh.lastUpdate) > 120_000 : true;
  const status = gh.mode === 'demo' ? { t: 'DEMO — SIMULATED DATA', c: '#f59e0b' }
    : !gh.ready ? { t: 'CONNECTING…', c: '#94a3b8' }
    : !gh.controllerOnline || stale ? { t: 'CONTROLLER NOT REPORTING', c: '#ef4444' }
    : { t: gh.streaming ? 'LIVE' : 'UPDATING', c: '#22c55e' };

  const alerts = [...gh.openAlerts].sort((x, y) => (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9) || Date.parse(y.raised_at) - Date.parse(x.raised_at));
  const sevCount = alerts.reduce<Record<string, number>>((m, a) => ({ ...m, [a.severity]: (m[a.severity] ?? 0) + 1 }), {});
  const SHOW = 3;
  const onCount = DEVICES.filter(id => gh.actuators[id]?.on).length;
  const manualCount = DEVICES.filter(id => gh.actuators[id]?.mode === 'MANUAL').length;
  const cloudOk = net?.cloud.health === 'ok';

  return (
    <div style={{ minHeight: '100vh', background: 'var(--sg-bg)', color: 'var(--sg-text)', padding: '2vh 2.5vw', display: 'flex', flexDirection: 'column', gap: '1.8vh',
      cursor: cursor || panel ? 'default' : 'none' }}>
      <div className="sg-row-between">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'clamp(20px, 3vw, 44px)', fontWeight: 800 }}>🌿 {gh.meta.name}</div>
          <div style={{ fontSize: 'clamp(12px, 1.4vw, 22px)', color: 'var(--sg-muted)' }}>
            {gh.activePreset ? `${gh.activePreset.name} · ` : ''}<b style={{ color: 'var(--sg-text)' }}>{stage?.name} stage</b>
            {sched ? ` · ${scheduleLine(sched, id => gh.meta.stages.find(s => s.id === id)?.name ?? id)}` : ''} · {stage?.irrigation_mode} irrigation · updated {timeAgo(gh.lastUpdate)}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 'clamp(24px, 4vw, 60px)', fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          <div style={{ fontSize: 'clamp(12px, 1.3vw, 20px)', fontWeight: 700, color: status.c }}>● {status.t}</div>
          <div role="button" tabIndex={0} title="Network and cloud (press N)" data-testid="kiosk-net-chip" onClick={() => setPanel(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4, padding: '2px 10px', borderRadius: 999, cursor: 'pointer',
              border: '1px solid var(--sg-border)', background: 'var(--sg-elevated)', fontSize: fz(12), color: 'var(--sg-muted)' }}>
            <IonIcon icon={wifiOutline} /> {gh.mode === 'demo' ? 'Demo' : net ? (net.wifi?.ssid ?? NET_MODE[net.mode] ?? net.mode) : (NET_MODE[gh.meta.network_mode ?? ''] ?? 'Network')}
            {net && <><span style={{ opacity: 0.4 }}>|</span><IonIcon icon={cloudOk ? cloudDoneOutline : cloudOfflineOutline} style={{ color: cloudOk ? '#22c55e' : '#f59e0b' }} /> {cloudOk ? 'Cloud' : 'Cloud!'}</>}
            <span style={{ opacity: 0.6, fontSize: '0.85em', border: '1px solid var(--sg-border)', borderRadius: 3, padding: '0 4px' }}>N</span>
          </div>
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
                {k === 'stock_weight' && m.value !== null ? (m.value / 1000).toFixed(2) : formatMetric(k, m.value)}
                <span style={{ fontSize: '0.35em', fontWeight: 500, color: 'var(--sg-muted)', marginLeft: 6 }}>{m.value !== null ? (k === 'stock_weight' ? 'kg' : m.unit) : ''}</span>
              </div>
              <div style={{ fontSize: 'clamp(11px, 1.2vw, 18px)', color: m.note ? c : 'var(--sg-dim)' }}>
                {m.note ?? (m.band ? `target ${m.band.min}–${m.band.max}` : '')}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: '1.5vw' }}>
        <div className="sg-card" style={{ margin: 0 }} data-testid="kiosk-devices">
          <div className="sg-row-between" style={{ marginBottom: '1vh' }}>
            <span style={{ fontSize: fz(14), fontWeight: 700, color: 'var(--sg-muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>Devices</span>
            <span style={{ fontSize: fz(12), color: 'var(--sg-muted)' }}>
              <b style={{ color: onCount ? '#22c55e' : 'var(--sg-muted)' }}>{onCount} on</b>{manualCount ? <> · <b style={{ color: '#f59e0b' }}>{manualCount} manual</b></> : ''}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8vw' }}>
            {DEVICES.map(id => <DeviceTile key={id} id={id} />)}
          </div>
          <div className="sg-row" style={{ gap: '0.6vw', marginTop: '1vh', flexWrap: 'wrap' }}>
            {[{ id: 'controller', label: 'Controller', ok: gh.controllerOnline && !stale }, ...gh.meta.nodes.map(n => ({ id: n.id, label: n.id.replace('node_', 'Node ').toUpperCase().replace('NODE ', 'Node '), ok: !!gh.nodes[n.id] }))].map(n => (
              <span key={n.id} style={{ fontSize: fz(11.5), padding: '2px 9px', borderRadius: 999, border: `1px solid ${n.ok ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.5)'}`,
                color: n.ok ? 'var(--sg-text)' : '#ef4444', background: n.ok ? 'transparent' : 'rgba(239,68,68,0.08)' }}>
                <span style={{ color: n.ok ? '#22c55e' : '#ef4444' }}>●</span> {n.label} {n.ok ? 'online' : 'OFFLINE'}
              </span>
            ))}
          </div>
        </div>

        <div className="sg-card" style={{ margin: 0, display: 'flex', flexDirection: 'column' }} data-testid="kiosk-alerts">
          <div className="sg-row-between" style={{ marginBottom: '0.6vh' }}>
            <span style={{ fontSize: fz(14), fontWeight: 700, color: 'var(--sg-muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
              Open alerts {alerts.length > 0 && <span style={{ marginLeft: 6, padding: '0 8px', borderRadius: 999, background: SEV_COLOR[alerts[0].severity], color: '#fff', fontSize: fz(12) }}>{alerts.length}</span>}
            </span>
            <span className="sg-row" style={{ gap: 6 }}>
              {(['critical', 'high', 'medium', 'low'] as const).filter(sv => sevCount[sv]).map(sv => (
                <span key={sv} style={{ fontSize: fz(11), color: SEV_COLOR[sv], border: `1px solid ${SEV_COLOR[sv]}`, borderRadius: 999, padding: '0 7px' }}>{sevCount[sv]} {sv}</span>
              ))}
            </span>
          </div>
          {alerts.length === 0 ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1vw', minHeight: '9vh' }}>
              <IonIcon icon={checkmarkCircle} style={{ color: '#22c55e', fontSize: fz(40) }} />
              <div>
                <div style={{ fontSize: fz(18), fontWeight: 800, color: '#22c55e' }}>All clear</div>
                <div style={{ fontSize: fz(12), color: 'var(--sg-muted)' }}>No open alerts</div>
              </div>
            </div>
          ) : (
            <>
              {alerts.slice(0, SHOW).map(a => <AlertRow key={a.id} a={a} />)}
              {alerts.length > SHOW && (
                <div style={{ fontSize: fz(11.5), color: 'var(--sg-muted)', marginTop: '0.6vh' }}>+ {alerts.length - SHOW} more — open Alerts in the app</div>
              )}
            </>
          )}
        </div>
      </div>
      {panel && <KioskNetwork base={base} kioskApi={kioskApi} onClose={closePanel} />}
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
        {demo ? <DemoProvider><KioskView base={null} kioskApi={null} /></DemoProvider>
          : api ? <LiveProvider override={{ api, mqtt: auth?.mqtt ?? null }}><KioskView base={base} kioskApi={api} /></LiveProvider>
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
