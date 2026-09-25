import React, { useState } from 'react';
import { IonPage, IonContent, IonButton } from '@ionic/react';
import { useHistory } from 'react-router-dom';
import PersistentHeader from '../components/PersistentHeader';
import { useAuth } from '../contexts/AuthContext';
import { useConnection } from '../contexts/ConnectionContext';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { fmtDateTime, initials } from '../components/format';

const input: React.CSSProperties = {
  width: '100%', background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 8,
  padding: '9px 10px', color: 'var(--sg-text)', fontSize: 14, fontFamily: 'inherit', outline: 'none', marginBottom: 8,
};

const Profile: React.FC = () => {
  const history = useHistory();
  const { session, logout, changePassword } = useAuth();
  const conn = useConnection();
  const gh = useGreenhouse();
  const [confirm, setConfirm] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', again: '' });
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const user = session?.user;

  const signOut = () => {
    if (!confirm) { setConfirm(true); return; }
    logout();
    history.replace('/login');
  };

  const savePw = async () => {
    if (pw.next !== pw.again) { setPwMsg({ ok: false, text: 'The new passwords do not match.' }); return; }
    setSaving(true);
    const r = await changePassword(pw.current, pw.next);
    setSaving(false);
    setPwMsg(r.ok ? { ok: true, text: 'Password changed. Your other devices were signed out.' } : { ok: false, text: r.error });
    if (r.ok) setPw({ current: '', next: '', again: '' });
  };

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/dashboard" />
      <IonContent className="ion-padding">
        <div style={{ textAlign: 'center', marginBottom: 24, paddingTop: 8 }}>
          <div style={{
            width: 80, height: 80, borderRadius: '50%', background: 'linear-gradient(135deg, #22c55e 0%, #15803d 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 800, color: '#fff',
            margin: '0 auto 12px', border: '3px solid rgba(34,197,94,0.4)', boxShadow: '0 0 24px rgba(34,197,94,0.2)',
          }}>{initials(user?.name)}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--sg-text)' }}>{user?.name ?? '—'}</div>
          <div style={{ fontSize: 13, color: 'var(--sg-muted)', marginTop: 3 }}>{user?.email}</div>
          <div className="sg-row" style={{ justifyContent: 'center', gap: 8, marginTop: 8 }}>
            <span className={`sg-pill ${user?.role === 'admin' ? 'sg-pill-ok' : 'sg-pill-info'}`}>{user?.role === 'admin' ? 'Administrator' : 'Viewer'}</span>
            <span className="sg-pill sg-pill-info">{gh.meta.name}</span>
            {session?.mode === 'demo' && <span className="sg-pill sg-pill-warn">Demo</span>}
          </div>
        </div>

        <div className="sg-card">
          <div className="sg-section-title">This session</div>
          {[
            ['Signed in', fmtDateTime(session?.issuedAt)],
            ['Connected via', session?.mode === 'demo' ? 'demo simulation' : `${conn.link}${conn.activeBase ? ` · ${conn.activeBase}` : ''}`],
            ['Permissions', user?.role === 'admin' ? 'view, control, change thresholds, manage accounts' : 'view only'],
          ].map(([k, v]) => (
            <div key={k} className="sg-row-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--sg-border)', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--sg-muted)' }}>{k}</span>
              <span style={{ fontSize: 12, color: 'var(--sg-text)', textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
            </div>
          ))}
        </div>

        {session?.mode === 'live' && (
          <div className="sg-card">
            <div className="sg-section-title">Change password</div>
            <input style={input} type="password" autoComplete="current-password" placeholder="Current password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} />
            <input style={input} type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} />
            <input style={input} type="password" autoComplete="new-password" placeholder="New password again" value={pw.again} onChange={e => setPw({ ...pw, again: e.target.value })} />
            {pwMsg && <div style={{ fontSize: 12, color: pwMsg.ok ? '#22c55e' : '#ef4444', marginBottom: 8 }}>{pwMsg.text}</div>}
            <IonButton size="small" disabled={saving || !pw.current || pw.next.length < 8} onClick={savePw}>{saving ? 'Saving…' : 'Change password'}</IonButton>
          </div>
        )}

        <IonButton expand="block" onClick={signOut}
          style={{ '--background': confirm ? '#ef4444' : 'rgba(239,68,68,0.12)', '--color': confirm ? '#fff' : '#ef4444', '--border-radius': '12px', fontWeight: 700, marginTop: 8 }}>
          {confirm ? 'Tap again to sign out' : 'Sign out'}
        </IonButton>
        {session?.mode === 'live' && <div style={{ fontSize: 11, color: 'var(--sg-dim)', textAlign: 'center', marginTop: 6 }}>Signing out ends your sessions on all devices.</div>}
      </IonContent>
    </IonPage>
  );
};

export default Profile;
