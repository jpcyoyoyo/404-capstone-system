import React, { useEffect, useState } from 'react';
import { IonPage, IonContent, IonButton, IonIcon, IonHeader, IonToolbar, IonTitle } from '@ionic/react';
import { useHistory } from 'react-router-dom';
import { hardwareChipOutline, checkmarkCircle, waterOutline, leafOutline, rainyOutline } from 'ionicons/icons';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import ConnectionEditor from '../components/ConnectionEditor';
import { DEFAULT_THRESHOLDS } from '../contract/registry.generated';
import type { Threshold } from '../contract/types';
import { SETUP_DONE_KEY } from './Login';

const STAGE_ICON: Record<string, string> = { fog: rainyOutline, drip: waterOutline, sprinkler: leafOutline };

const Step: React.FC<{ n: number; title: string }> = ({ n, title }) => (
  <div className="sg-row sg-gap-8" style={{ marginBottom: 10, marginTop: 6 }}>
    <span className="sg-pill sg-pill-ok" style={{ fontSize: 10 }}>{n}</span>
    <span style={{ fontSize: 11, color: 'var(--sg-muted)', textTransform: 'uppercase', letterSpacing: 0.6 }}>{title}</span>
  </div>
);

const QuickSetup: React.FC = () => {
  const history = useHistory();
  const gh = useGreenhouse();
  const { isAdmin, isAuthenticated } = useAuth();
  const [bands, setBands] = useState<Record<string, Threshold[]>>(DEFAULT_THRESHOLDS);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) history.replace('/login');
  }, [isAuthenticated, history]);

  useEffect(() => {
    let alive = true;
    Promise.all(gh.meta.stages.map(s => gh.data.thresholds(s.id).then(t => [s.id, t] as const)))
      .then(list => { if (alive) setBands(Object.fromEntries(list)); })
      .catch(() => { /* keep registry defaults */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gh.data, gh.ready]);

  const pick = async (id: string) => {
    if (id === gh.activeStageId) return;
    setBusy(true); setMsg(null);
    try { await gh.setActiveStage(id); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Could not change the stage.'); }
    finally { setBusy(false); }
  };

  const finish = () => {
    try { localStorage.setItem(SETUP_DONE_KEY, '1'); } catch { /* ignore */ }
    history.replace('/tabs/dashboard');
  };

  const installed = gh.meta.sensors.filter(s => s.installed);
  const nodes = gh.meta.nodes;
  const band = (stage: string, p: string) => bands[stage]?.find(t => t.parameter === p);
  const connected = gh.mode === 'demo' || (gh.link !== 'offline' && gh.ready);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Quick setup</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">

        <Step n={1} title="Controller" />
        <div className="sg-card">
          <div className="sg-row-between" style={{ marginBottom: 10 }}>
            <div className="sg-row sg-gap-8">
              <IonIcon icon={hardwareChipOutline} style={{ color: connected ? '#22c55e' : 'var(--sg-muted)' }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>{gh.meta.name}</span>
            </div>
            <span className={`sg-pill ${gh.mode === 'demo' ? 'sg-pill-warn' : connected ? 'sg-pill-ok' : 'sg-pill-crit'}`} style={{ fontSize: 10 }}>
              {gh.mode === 'demo' ? 'Demo' : connected ? (gh.link === 'remote' ? 'Cloud' : 'Connected') : 'Not reachable'}
            </span>
          </div>
          <div className="sg-elevated" style={{ padding: 10, marginBottom: 10 }}>
            <div className="sg-row-between" style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--sg-muted)' }}>Controller</span>
              <span style={{ fontSize: 11, color: 'var(--sg-text)' }}>Raspberry Pi 5 · {gh.meta.id}{gh.meta.network_mode ? ` · ${gh.meta.network_mode}` : ''}</span>
            </div>
            {nodes.map(n => (
              <div key={n.id} className="sg-row-between" style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--sg-muted)' }}>{n.id.replace('_', ' ').toUpperCase()} ({n.board.toUpperCase()}, zone {n.zone})</span>
                <span style={{ fontSize: 11, color: gh.nodes[n.id] ? '#22c55e' : 'var(--sg-dim)' }}>{gh.nodes[n.id] ? 'online' : 'no data yet'}</span>
              </div>
            ))}
            <div className="sg-row-between">
              <span style={{ fontSize: 11, color: 'var(--sg-muted)' }}>Sensors installed</span>
              <span style={{ fontSize: 11, color: 'var(--sg-text)' }}>{installed.length} of {gh.meta.sensors.length}</span>
            </div>
          </div>
          {gh.mode === 'live' && <ConnectionEditor compact={connected} />}
        </div>

        <Step n={2} title="Growth stage" />
        <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginBottom: 8 }}>
          The stage decides the thresholds and which irrigation circuit runs. {isAdmin ? '' : 'Only an administrator can change it.'}
        </div>
        <div className="sg-row sg-gap-8" style={{ marginBottom: 8, alignItems: 'stretch' }}>
          {gh.meta.stages.map(s => {
            const active = gh.activeStageId === s.id;
            const soil = band(s.id, 'soil_moisture');
            const temp = band(s.id, 'temperature');
            return (
              <div key={s.id} className={`sg-select-card ${active ? 'active' : ''}`} onClick={() => isAdmin && !busy && pick(s.id)}
                style={{ position: 'relative', flex: 1, opacity: busy && !active ? 0.6 : 1, cursor: isAdmin ? 'pointer' : 'default' }}>
                {active && <IonIcon icon={checkmarkCircle} style={{ position: 'absolute', top: 6, right: 6, color: '#22c55e', fontSize: 14 }} />}
                <IonIcon icon={STAGE_ICON[s.irrigation_mode] ?? leafOutline} style={{ fontSize: 18, color: active ? '#22c55e' : 'var(--sg-muted)' }} />
                <div style={{ fontSize: 13, fontWeight: 700, color: active ? '#22c55e' : 'var(--sg-text)', marginTop: 6 }}>{s.name}</div>
                <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginTop: 4, minHeight: 28 }}>{s.description}</div>
                <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 4 }}>
                  Soil {soil ? `${soil.min}–${soil.max}%` : '—'}<br />{temp ? `${temp.min}–${temp.max}°C` : '—'}
                </div>
              </div>
            );
          })}
        </div>
        {msg && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 8 }}>{msg}</div>}

        <div className="sg-card" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', marginTop: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#22c55e' }}>Works without internet</div>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 2, lineHeight: 1.5 }}>
            The controller runs the thresholds on its own. The app talks to it directly on the greenhouse network;
            the cloud address is only for viewing from elsewhere.
          </div>
        </div>

        <IonButton expand="block" disabled={!connected}
          style={{ '--background': connected ? '#22c55e' : 'rgba(148,163,184,0.15)', '--color': connected ? '#06210f' : 'var(--sg-dim)', '--border-radius': '12px', fontWeight: 700, marginTop: 16 }}
          onClick={finish}>
          {connected ? 'Continue to dashboard' : 'Connect to the controller to continue'}
        </IonButton>
        {!connected && <IonButton expand="block" fill="clear" size="small" onClick={finish}>Skip for now</IonButton>}
      </IonContent>
    </IonPage>
  );
};

export default QuickSetup;
