/**
 * App Settings → Notifications: phone notifications through Web Push from the cloud server
 * (components/push.ts here, controller/greenhouse/push.py on the server). Offered only where they
 * can work; elsewhere it says where to turn them on instead.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { IonButton, IonToggle } from '@ionic/react';
import { useAuth } from '../contexts/AuthContext';
import { useConnection } from '../contexts/ConnectionContext';
import { SettingRow, ChipGroup } from './SettingRow';
import {
  PushError, PushLevel, disablePush, enablePush, permission, pushBlocker, pushStatus,
} from './push';

const LEVEL_LABELS: Record<PushLevel, string> = { all: 'All alerts', urgent: 'Urgent only' };

const Note: React.FC<{ children: React.ReactNode; tone?: 'muted' | 'warn' | 'ok' }> = ({ children, tone = 'muted' }) => (
  <div style={{
    fontSize: 12, lineHeight: 1.5, marginTop: 8,
    color: tone === 'warn' ? '#f59e0b' : tone === 'ok' ? '#22c55e' : 'var(--sg-muted)',
  }}>{children}</div>
);

function where(cloudUrl: string): string {
  return cloudUrl ? cloudUrl.replace(/^https?:\/\//, '') : 'the cloud server\'s address';
}

const PushSettings: React.FC = () => {
  const { api, session } = useAuth();
  const conn = useConnection();
  const blocker = pushBlocker();
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState<PushLevel>('all');
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = session?.mode === 'live' && !!api;

  const load = useCallback(async () => {
    if (!api || blocker) return;
    setLoading(true);
    try {
      const cfg = await api.pushConfig();
      setAvailable(cfg.available);
      setReason(cfg.reason);
      setDevices(cfg.devices);
      if (cfg.available) {
        const st = await pushStatus(api);
        setOn(st.on);
        if (st.level) setLevel(st.level);
      }
    } catch (e) {
      setAvailable(false);
      setReason(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [api, blocker]);

  useEffect(() => { if (live) load(); }, [live, load]);

  const turnOn = async (lvl: PushLevel) => {
    if (!api) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await enablePush(api, lvl);
      setOn(true);
      setLevel(lvl);
      setDevices((await api.pushConfig()).devices);
    } catch (e) {
      setOn(false);
      setError(e instanceof PushError || e instanceof Error ? e.message : 'Notifications could not be turned on.');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true); setError(null); setNotice(null);
    await disablePush(api);
    setOn(false);
    try { if (api) setDevices((await api.pushConfig()).devices); } catch { /* keep the old count */ }
    setBusy(false);
  };

  const test = async () => {
    if (!api) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.pushTest();
      setNotice(r.sent
        ? `Test sent to ${r.sent} device${r.sent === 1 ? '' : 's'} on your account; it should appear within a few seconds.`
        : 'No device took the test. Turn notifications off and on again on this device.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The test could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const intro = 'Alerts reach this device even when the app is closed or the screen is off. They come from the cloud server, about a minute after the greenhouse raises them, and also when the greenhouse controller stops reporting (power or internet down).';

  if (!live) {
    return <Note>{intro} Sign in with a live account (not demo mode) to turn them on.</Note>;
  }
  if (blocker === 'native') {
    return <Note>{intro} This Android app cannot receive them. On this phone, open <b>{where(conn.cloudUrl)}</b> in Chrome, install it (menu → <i>Install app</i> or <i>Add to Home screen</i>), sign in, and turn notifications on there.</Note>;
  }
  if (blocker === 'insecure') {
    return <Note>{intro} They need the cloud server's secure address: open <b>{where(conn.cloudUrl)}</b> in Chrome, sign in, and turn them on there.</Note>;
  }
  if (blocker === 'ios-home-screen') {
    return <Note>{intro} On an iPhone or iPad, first tap <i>Share → Add to Home Screen</i>, open the app from the Home Screen, sign in, and turn them on there.</Note>;
  }
  if (blocker === 'unsupported') {
    return <Note>{intro} This browser cannot receive them; use Chrome, Edge, Firefox or Safari.</Note>;
  }
  if (loading && available === null) return <Note>Checking…</Note>;
  if (available === false) {
    return <Note>{intro} {reason || 'This server does not send notifications.'}</Note>;
  }

  const denied = permission() === 'denied';
  return (
    <div>
      <SettingRow label="Notifications on this device" sub={on ? `On · ${devices} device${devices === 1 ? '' : 's'} on your account` : 'Off'}>
        <IonToggle checked={on} disabled={busy || (denied && !on)} aria-label="Notifications on this device"
          onIonChange={e => { if (e.detail.checked) turnOn(level); else turnOff(); }} />
      </SettingRow>
      <SettingRow wide label="Which alerts" sub="Urgent only: high and critical alerts, and the controller going quiet">
        <ChipGroup<PushLevel> options={['all', 'urgent']} value={level} labels={LEVEL_LABELS} disabled={busy}
          onChange={l => { setLevel(l); if (on) turnOn(l); }} />
      </SettingRow>
      {on && (
        <div style={{ paddingTop: 10 }}>
          <IonButton fill="outline" size="small" disabled={busy} onClick={test}
            style={{ '--border-color': 'var(--sg-border)', '--color': 'var(--sg-text)', '--border-radius': '8px' }}>
            Send a test
          </IonButton>
        </div>
      )}
      {denied && !on && <Note tone="warn">Notifications are blocked for this site. Allow them in the browser's site settings (the icon left of the address, or the app's info page), then turn this on.</Note>}
      {error && <Note tone="warn">{error}</Note>}
      {notice && <Note tone="ok">{notice}</Note>}
      <Note>{intro} Signing out turns them off on this device.</Note>
    </div>
  );
};

export default PushSettings;
