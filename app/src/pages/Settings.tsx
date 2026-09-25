import React, { useCallback, useEffect, useState } from 'react';
import { IonPage, IonContent, IonButton, IonSpinner, useIonToast } from '@ionic/react';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import { useConnection } from '../contexts/ConnectionContext';
import { useCommand } from '../components/useCommand';
import type { Quality, UserItem } from '../contract/types';
import { fmtDateTime, timeAgo, untilText } from '../components/format';

const TABS = [['users', 'Users'], ['overrides', 'Overrides'], ['diagnostics', 'Diagnostics'], ['data', 'Data']] as const;
type Tab = typeof TABS[number][0];

const input: React.CSSProperties = {
  width: '100%', background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 8,
  padding: '8px 10px', color: 'var(--sg-text)', fontSize: 13, fontFamily: 'inherit', outline: 'none', marginBottom: 8,
};

const Users: React.FC = () => {
  const gh = useGreenhouse();
  const { isAdmin, session } = useAuth();
  const [toast] = useIonToast();
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'viewer' as 'admin' | 'viewer' });
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    gh.data.users().then(setUsers).catch(e => toast({ message: e.message, duration: 3000, color: 'danger' })).finally(() => setLoading(false));
  }, [gh.data, toast]);
  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  if (!isAdmin) return <div className="sg-card" style={{ fontSize: 13, color: 'var(--sg-muted)' }}>Only administrators can manage accounts.</div>;

  const add = async () => {
    try {
      await gh.data.addUser(form);
      setForm({ email: '', name: '', password: '', role: 'viewer' });
      setAdding(false);
      toast({ message: `Account created for ${form.email}.`, duration: 2500, color: 'success', position: 'top' });
      load();
    } catch (e) { toast({ message: e instanceof Error ? e.message : 'Could not create the account.', duration: 3500, color: 'danger', position: 'top' }); }
  };
  const patch = async (u: UserItem, p: Partial<{ role: 'admin' | 'viewer'; active: boolean }>) => {
    try { await gh.data.patchUser(u.id, p); load(); }
    catch (e) { toast({ message: e instanceof Error ? e.message : 'Update failed.', duration: 3500, color: 'danger', position: 'top' }); }
  };

  const valid = /.+@.+/.test(form.email) && form.name.trim() && form.password.length >= 8;
  return (
    <>
      <div className="sg-card" style={{ padding: 0 }}>
        {loading && <div style={{ padding: 12 }}><IonSpinner name="dots" /></div>}
        {users.map((u, i) => (
          <div key={u.id} style={{ padding: '12px 14px', borderBottom: i < users.length - 1 ? '1px solid var(--sg-border)' : 'none', opacity: u.active ? 1 : 0.5 }}>
            <div className="sg-row-between">
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--sg-text)' }}>{u.name}{u.email === session?.user.email ? ' (you)' : ''}</div>
                <div style={{ fontSize: 11, color: 'var(--sg-muted)' }}>{u.email} · last sign-in {u.last_login_at ? timeAgo(u.last_login_at) : 'never'}</div>
              </div>
              <span className={`sg-pill ${u.role === 'admin' ? 'sg-pill-ok' : 'sg-pill-info'}`}>{u.role}</span>
            </div>
            {u.email !== session?.user.email && (
              <div className="sg-row sg-gap-8" style={{ marginTop: 8 }}>
                <IonButton size="small" fill="outline" onClick={() => patch(u, { role: u.role === 'admin' ? 'viewer' : 'admin' })}>
                  Make {u.role === 'admin' ? 'viewer' : 'admin'}
                </IonButton>
                <IonButton size="small" fill="outline" color={u.active ? 'danger' : 'success'} onClick={() => patch(u, { active: !u.active })}>
                  {u.active ? 'Disable' : 'Enable'}
                </IonButton>
              </div>
            )}
          </div>
        ))}
      </div>
      {adding ? (
        <div className="sg-card">
          <div className="sg-section-title">New account</div>
          <input style={input} placeholder="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          <input style={input} placeholder="Full name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input style={input} placeholder="Temporary password (8+ characters)" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          <div className="sg-row sg-gap-8" style={{ marginBottom: 10 }}>
            {(['viewer', 'admin'] as const).map(r => (
              <span key={r} className={`sg-filter-pill ${form.role === r ? 'active' : ''}`} onClick={() => setForm({ ...form, role: r })}>
                {r === 'admin' ? 'Administrator (can control)' : 'Viewer (read only)'}
              </span>
            ))}
          </div>
          <div className="sg-row sg-gap-8">
            <IonButton size="small" disabled={!valid} onClick={add}>Create</IonButton>
            <IonButton size="small" fill="clear" color="medium" onClick={() => setAdding(false)}>Cancel</IonButton>
          </div>
        </div>
      ) : <IonButton expand="block" fill="outline" onClick={() => setAdding(true)}>+ Add account</IonButton>}
    </>
  );
};

const Overrides: React.FC = () => {
  const gh = useGreenhouse();
  const { send, busy, blocked } = useCommand();
  const manual = Object.values(gh.actuators).filter(a => a.mode === 'MANUAL');
  return (
    <div className="sg-card">
      <div className="sg-section-title">Devices under manual control</div>
      {manual.length === 0 && <div style={{ fontSize: 13, color: 'var(--sg-muted)' }}>None — everything is automatic.</div>}
      {manual.map(a => (
        <div key={a.actuator_id} className="sg-row-between" style={{ padding: '8px 0', borderTop: '1px solid var(--sg-border)' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--sg-text)' }}>{gh.meta.actuators.find(d => d.id === a.actuator_id)?.name ?? a.actuator_id} · {a.on ? 'ON' : 'OFF'}</div>
            <div style={{ fontSize: 11, color: 'var(--sg-muted)' }}>{a.manual_until ? untilText(a.manual_until) : 'held'}{a.reason ? ` · ${a.reason}` : ''}</div>
          </div>
          <IonButton size="small" disabled={!!blocked || busy !== null} onClick={() => send({ actuator_id: a.actuator_id, action: 'AUTO' })}>Auto</IonButton>
        </div>
      ))}
    </div>
  );
};

const Diagnostics: React.FC = () => {
  const gh = useGreenhouse();
  const conn = useConnection();
  const counts: Record<Quality | 'MISSING', number> = { VALID: 0, WARMING: 0, STALE: 0, INVALID: 0, UNCALIBRATED: 0, MISSING: 0 };
  const installed = gh.meta.sensors.filter(s => s.installed);
  for (const s of installed) {
    const r = gh.readings[s.id];
    counts[r ? r.quality : 'MISSING'] += 1;
  }
  const bad = installed.filter(s => gh.readings[s.id]?.quality !== 'VALID');
  const rows: [string, string][] = [
    ['Data source', gh.mode === 'demo' ? 'Demo simulation' : `${gh.link}${conn.activeBase ? ` · ${conn.activeBase}` : ''}`],
    ['Control service', gh.controllerOnline ? 'running' : 'not reporting'],
    ['Live updates', gh.streaming ? 'MQTT (WebSocket)' : 'polling every 5 s'],
    ['Last update', `${fmtDateTime(gh.lastUpdate)} (${timeAgo(gh.lastUpdate)})`],
    ['Network mode', gh.meta.network_mode ?? '—'],
    ...gh.meta.nodes.map(n => [`${n.id} (${n.board})`, gh.nodes[n.id] ? 'online' : 'offline'] as [string, string]),
  ];
  return (
    <>
      <div className="sg-card">
        {rows.map(([k, v]) => (
          <div key={k} className="sg-row-between" style={{ padding: '6px 0', borderBottom: '1px solid var(--sg-border)', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--sg-muted)' }}>{k}</span>
            <span style={{ fontSize: 12, color: 'var(--sg-text)', textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
          </div>
        ))}
      </div>
      <div className="sg-card">
        <div className="sg-section-title">Sensor quality ({installed.length} installed)</div>
        <div className="sg-row sg-gap-8" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          {Object.entries(counts).filter(([, n]) => n > 0).map(([q, n]) => (
            <span key={q} className={`sg-pill ${q === 'VALID' ? 'sg-pill-ok' : q === 'WARMING' ? 'sg-pill-info' : 'sg-pill-warn'}`}>{q} {n}</span>
          ))}
        </div>
        {bad.map(s => (
          <div key={s.id} style={{ fontSize: 12, color: 'var(--sg-muted)', padding: '3px 0' }}>
            <span style={{ fontFamily: 'monospace', color: 'var(--sg-text)' }}>{s.id}</span> · {gh.readings[s.id]?.quality ?? 'no reading yet'}
          </div>
        ))}
      </div>
    </>
  );
};

const DataTab: React.FC = () => (
  <div className="sg-card">
    {[
      ['Raw readings', 'kept 7 days on the controller (pH 30 days)'],
      ['15-minute averages', 'kept for the whole study'],
      ['Commands, device events, audit log', 'kept for the whole study'],
      ['Backups', 'nightly database dump on the controller'],
      ['Cloud copy', 'readings and logs are copied to the cloud replica when internet is available'],
      ['Export', 'Records → Export CSV'],
    ].map(([k, v]) => (
      <div key={k} style={{ padding: '8px 0', borderBottom: '1px solid var(--sg-border)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--sg-text)' }}>{k}</div>
        <div style={{ fontSize: 12, color: 'var(--sg-muted)' }}>{v}</div>
      </div>
    ))}
  </div>
);

const Settings: React.FC = () => {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/more" />
      <IonContent className="ion-padding">
        <StatusBanner />
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--sg-text)', marginBottom: 14 }}>Settings</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {TABS.map(([v, l]) => (
            <span key={v} className={`sg-filter-pill ${tab === v ? 'active' : ''}`} onClick={() => setTab(v)}>{l}</span>
          ))}
        </div>
        {tab === 'users' && <Users />}
        {tab === 'overrides' && <Overrides />}
        {tab === 'diagnostics' && <Diagnostics />}
        {tab === 'data' && <DataTab />}
      </IonContent>
    </IonPage>
  );
};

export default Settings;
