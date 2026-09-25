import React, { useState } from 'react';
import { IonPage, IonContent, IonButton, IonIcon } from '@ionic/react';
import { useHistory } from 'react-router-dom';
import { eyeOutline, eyeOffOutline } from 'ionicons/icons';
import { useAuth } from '../contexts/AuthContext';
import { useConnection } from '../contexts/ConnectionContext';
import ConnectionEditor from '../components/ConnectionEditor';

export const SETUP_DONE_KEY = 'sg-setup-done';

const Login: React.FC = () => {
  const history = useHistory();
  const { login, isAuthenticated } = useAuth();
  const conn = useConnection();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConn, setShowConn] = useState(false);

  const next = () => {
    let done = false;
    try { done = localStorage.getItem(SETUP_DONE_KEY) === '1'; } catch { /* ignore */ }
    history.replace(done ? '/tabs/dashboard' : '/quick-setup');
  };

  const handleSignIn = async () => {
    if (pending) return;
    setError(null);
    setPending(true);
    const result = await login(email, password);
    setPending(false);
    if (result.ok) next();
    else setError(result.error);
  };

  const fieldInput: React.CSSProperties = {
    background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)',
    borderRadius: 8, padding: '10px 12px', width: '100%',
    color: 'var(--sg-text)', fontSize: 14, fontFamily: 'inherit', outline: 'none',
  };
  const fieldLabel: React.CSSProperties = { fontSize: 12, color: 'var(--sg-muted)', marginBottom: 4 };
  const demo = conn.mode === 'demo';

  return (
    <IonPage>
      <IonContent style={{ '--background': 'var(--sg-bg)' }}>
        <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 20px 32px' }}>

          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{
              width: 64, height: 64, background: 'rgba(34,197,94,0.15)',
              border: '2px solid rgba(34,197,94,0.4)', borderRadius: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 12px', fontSize: 30,
            }}>🌿</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--sg-text)' }}>SmartGreenhouse</div>
            <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginTop: 4 }}>MAgSO greenhouse · monitoring and control</div>
          </div>

          {/* Live / Demo */}
          <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 390, marginBottom: 10 }}>
            {(['live', 'demo'] as const).map(m => (
              <div key={m} className={`sg-select-card ${conn.mode === m ? 'active' : ''}`} style={{ flex: 1, textAlign: 'center', cursor: 'pointer', padding: '10px 0' }}
                onClick={() => { conn.setMode(m); setError(null); }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: conn.mode === m ? '#22c55e' : 'var(--sg-text)' }}>{m === 'live' ? 'Greenhouse' : 'Demo'}</div>
                <div style={{ fontSize: 10, color: 'var(--sg-muted)' }}>{m === 'live' ? 'Real controller' : 'Simulated, no hardware'}</div>
              </div>
            ))}
          </div>

          <div className="sg-card" style={{ width: '100%', maxWidth: 390, padding: '20px 20px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--sg-text)', marginBottom: 6 }}>Sign in</div>
            {demo && <div className="sg-banner-warn" style={{ marginBottom: 12 }}>Demo mode: any email and password work. Nothing you do reaches the greenhouse.</div>}

            <div style={{ marginBottom: 12, marginTop: 10 }}>
              <div style={fieldLabel}>Email</div>
              <input type="email" id="login-email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)}
                placeholder={demo ? 'demo@example.com' : 'admin@greenhouse.local'} style={fieldInput} />
            </div>

            <div style={{ marginBottom: 8 }}>
              <div style={fieldLabel}>Password</div>
              <div style={{ ...fieldInput, display: 'flex', alignItems: 'center', padding: '0 12px' }}>
                <input type={showPassword ? 'text' : 'password'} id="login-password" autoComplete="current-password"
                  value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"
                  style={{ ...fieldInput, background: 'transparent', border: 'none', padding: '10px 0', flex: 1 }}
                  onKeyDown={e => { if (e.key === 'Enter') handleSignIn(); }} />
                <IonIcon icon={showPassword ? eyeOffOutline : eyeOutline} style={{ fontSize: 16, color: 'var(--sg-muted)', cursor: 'pointer' }}
                  onClick={() => setShowPassword(v => !v)} />
              </div>
            </div>

            {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 8 }}>{error}</div>}

            <IonButton expand="block" disabled={pending || (!demo && conn.checking && !conn.activeBase)}
              style={{ '--background': '#22c55e', '--color': '#000', '--border-radius': '10px', marginBottom: 8, fontWeight: 700 }}
              onClick={handleSignIn}>
              {pending ? 'Signing in…' : demo ? 'Open demo' : 'Sign in'}
            </IonButton>
            {isAuthenticated && (
              <IonButton expand="block" fill="clear" size="small" onClick={next}>Continue as signed-in user</IonButton>
            )}
            {!demo && (
              <div style={{ fontSize: 11, color: 'var(--sg-muted)', textAlign: 'center', lineHeight: 1.5 }}>
                Accounts are created by the greenhouse administrator. Forgot your password? Ask them to reset it.
              </div>
            )}
          </div>

          {!demo && (
            <div className="sg-card" style={{ width: '100%', maxWidth: 390, marginTop: 4 }}>
              <div className="sg-row-between" style={{ cursor: 'pointer' }} onClick={() => setShowConn(v => !v)}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--sg-text)' }}>Controller connection</div>
                <span style={{ fontSize: 12, color: '#3b82f6' }}>{showConn ? 'Hide' : 'Edit'}</span>
              </div>
              <div style={{ marginTop: 10 }}><ConnectionEditor compact={!showConn} /></div>
            </div>
          )}

          <div style={{ marginTop: 16, fontSize: 11, color: 'var(--sg-muted)', textAlign: 'center', maxWidth: 360 }}>
            Readings and control actions are stored on the greenhouse controller for the study period.
          </div>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default Login;
