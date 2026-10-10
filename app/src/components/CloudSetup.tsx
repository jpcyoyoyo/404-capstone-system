/**
 * Cloud server connection (required): status, and set-up for administrators on the greenhouse network.
 * Used by Settings → Cloud in the app and by the Network panel on the greenhouse display, so it takes
 * its data functions as props instead of reading a provider.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { IonButton, IonSpinner } from '@ionic/react';
import type { CloudState, CloudTest } from '../contract/types';
import { ApiError } from '../api/client';
import { timeAgo } from './format';

export interface CloudFns {
  load(): Promise<CloudState>;
  test(p: { url?: string; token?: string }): Promise<CloudTest>;
  setup(p: { url: string; token: string; force?: boolean }): Promise<CloudState & { test: CloudTest }>;
}

const CLOUD_WORDS: Record<CloudState['health'], { t: string; c: string }> = {
  ok: { t: 'Connected', c: '#22c55e' },
  waiting: { t: 'Set up — waiting for the first upload', c: '#3b82f6' },
  error: { t: 'Cannot reach the cloud server', c: '#ef4444' },
  not_configured: { t: 'Not set up — required', c: '#f59e0b' },
};

const CloudSetup: React.FC<{ fns: CloudFns; canEdit: boolean; large?: boolean; note?: string }> = ({ fns, canEdit, large, note }) => {
  const [st, setSt] = useState<CloudState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<{ test: CloudTest; saved: boolean } | null>(null);
  const fs = large ? 1.25 : 1;

  const load = useCallback(() => {
    fns.load().then(s => { setSt(s); setErr(null); if (s.url) setUrl(u => u || s.url!); })
      .catch(e => setErr(e instanceof Error ? e.message : 'Could not read the cloud status.'));
  }, [fns]);
  useEffect(() => { load(); const id = setInterval(load, 15_000); return () => clearInterval(id); }, [load]);
  useEffect(() => { if (st && !st.configured && canEdit) setOpen(true); }, [st, canEdit]);

  const doTest = async () => {
    setBusy('test'); setResult(null);
    try { setResult({ test: await fns.test({ url, token: token || undefined }), saved: false }); }
    catch (e) { setResult({ test: { ok: false, steps: [{ step: 'test', ok: false, detail: e instanceof Error ? e.message : 'failed' }] }, saved: false }); }
    finally { setBusy(null); }
  };
  const doSave = async (force = false) => {
    setBusy('save'); setResult(null);
    try {
      const r = await fns.setup({ url, token, force });
      setResult({ test: r.test, saved: true }); setSt(r); setToken(''); setOpen(false);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { test?: CloudTest } | undefined) : undefined;
      setResult({ test: body?.test ?? { ok: false, steps: [{ step: 'save', ok: false, detail: e instanceof Error ? e.message : 'failed' }] }, saved: false });
    } finally { setBusy(null); }
  };

  const input: React.CSSProperties = {
    width: '100%', background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 8,
    padding: `${8 * fs}px 10px`, color: 'var(--sg-text)', fontSize: 13 * fs, fontFamily: 'inherit', outline: 'none', marginBottom: 8,
  };
  const w = st ? CLOUD_WORDS[st.health] : null;
  const rows: [string, string][] = st ? [
    ['Server', st.url ?? '—'],
    ['Settings from', st.source === 'app' ? 'saved on the controller' : st.source === 'env' ? 'greenhouse.env' : '—'],
    ['Last upload', st.last_ok_at ? `${timeAgo(st.last_ok_at)}${st.last_rows != null ? ` · ${st.last_rows} rows` : ''}` : 'never'],
    ...(st.last_error && st.health !== 'ok' ? [['Last problem', st.last_error] as [string, string]] : []),
    ...(st.total_rows ? [['Uploaded so far', `${st.total_rows.toLocaleString()} rows`] as [string, string]] : []),
  ] : [];

  return (
    <div data-testid="cloud-setup">
      {err && <div style={{ fontSize: 12 * fs, color: 'var(--sg-muted)' }}>{err}</div>}
      {!st && !err && <IonSpinner name="dots" />}
      {st && w && (
        <>
          <div className="sg-row sg-gap-8" style={{ marginBottom: 8, alignItems: 'center' }}>
            <span style={{ width: 10 * fs, height: 10 * fs, borderRadius: '50%', background: w.c, boxShadow: `0 0 0 3px ${w.c}33`, flexShrink: 0 }} />
            <span style={{ fontSize: 15 * fs, fontWeight: 700, color: 'var(--sg-text)' }}>{w.t}</span>
          </div>
          {rows.map(([k, v]) => (
            <div key={k} className="sg-row-between" style={{ padding: `${5 * fs}px 0`, borderBottom: '1px solid var(--sg-border)', gap: 10 }}>
              <span style={{ fontSize: 12 * fs, color: 'var(--sg-muted)', flexShrink: 0 }}>{k}</span>
              <span style={{ fontSize: 12 * fs, color: 'var(--sg-text)', textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
            </div>
          ))}
          <div style={{ fontSize: 11 * fs, color: 'var(--sg-dim)', margin: '8px 0' }}>
            {note ?? 'The cloud server keeps a copy of the records for viewing away from the greenhouse. The controller keeps working without it, and uploads catch up when the connection returns.'}
          </div>
        </>
      )}

      {canEdit && st && !open && (
        <IonButton size={large ? 'default' : 'small'} fill="outline" onClick={() => setOpen(true)}>{st.configured ? 'Change server' : 'Set up the cloud server'}</IonButton>
      )}
      {!canEdit && st && !st.configured && (
        <div style={{ fontSize: 12 * fs, color: '#f59e0b' }}>An administrator must set up the cloud server.</div>
      )}

      {canEdit && open && (
        <div style={{ borderTop: '1px solid var(--sg-border)', paddingTop: 10, marginTop: 4 }}>
          <div style={{ fontSize: 11 * fs, color: 'var(--sg-muted)', marginBottom: 3 }}>Server address</div>
          <input aria-label="Server address" style={input} placeholder="https://greenhouse.example.com" value={url} autoCapitalize="off" autoCorrect="off"
            onChange={e => setUrl(e.target.value)} />
          <div style={{ fontSize: 11 * fs, color: 'var(--sg-muted)', marginBottom: 3 }}>Sync token (GH_SYNC_TOKEN in the server's cloud.env)</div>
          <div style={{ position: 'relative' }}>
            <input aria-label="Sync token" style={{ ...input, paddingRight: 56 }} type={show ? 'text' : 'password'} autoComplete="off" value={token}
              placeholder={st?.token_set ? 'saved — type a new one to replace it' : ''} onChange={e => setToken(e.target.value)} />
            <span onClick={() => setShow(x => !x)} style={{ position: 'absolute', right: 10, top: 8 * fs, fontSize: 11 * fs, color: 'var(--sg-muted)', cursor: 'pointer' }}>{show ? 'hide' : 'show'}</span>
          </div>
          <div className="sg-row sg-gap-8" style={{ flexWrap: 'wrap' }}>
            <IonButton size={large ? 'default' : 'small'} fill="outline" disabled={!!busy || !url || (!token && !st?.token_set)} onClick={doTest}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </IonButton>
            <IonButton size={large ? 'default' : 'small'} disabled={!!busy || !url || token.length < 16} onClick={() => doSave(false)}>
              {busy === 'save' ? 'Saving…' : 'Save and connect'}
            </IonButton>
            {st?.configured && <IonButton size={large ? 'default' : 'small'} fill="clear" color="medium" disabled={!!busy} onClick={() => { setOpen(false); setResult(null); }}>Cancel</IonButton>}
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: result.test.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
          border: `1px solid ${result.test.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
          {result.test.steps.map(s => (
            <div key={s.step} style={{ fontSize: 12 * fs, color: 'var(--sg-text)', padding: '2px 0' }}>
              <span style={{ color: s.ok ? '#22c55e' : '#ef4444', fontWeight: 800 }}>{s.ok ? '✓' : '✗'}</span> {s.detail}
            </div>
          ))}
          <div style={{ fontSize: 12 * fs, fontWeight: 600, color: result.test.ok ? '#22c55e' : '#ef4444', marginTop: 4 }}>
            {result.saved ? 'Saved. Uploads start within a minute.' : result.test.ok ? 'The test passed — press Save and connect.' : 'Nothing was saved.'}
          </div>
          {!result.saved && !result.test.ok && token.length >= 16 && (
            <IonButton size="small" fill="clear" color="medium" onClick={() => doSave(true)}>Save anyway (server not online yet)</IonButton>
          )}
        </div>
      )}
    </div>
  );
};

export default CloudSetup;
