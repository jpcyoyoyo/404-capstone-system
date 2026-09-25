import React, { useState } from 'react';
import { IonButton } from '@ionic/react';
import { useConnection, ControllerAddress } from '../contexts/ConnectionContext';
import { fmtTime } from './format';

const PRESETS: ControllerAddress[] = [
  { label: 'MAgSO Wi-Fi', url: 'http://greenhouse.local:8000' },
  { label: 'Dedicated router', url: 'http://192.168.50.10:8000' },
  { label: 'Pi hotspot', url: 'http://10.42.0.1:8000' },
];

const LINK_TEXT: Record<string, string> = {
  local: 'Connected to the controller', remote: 'Connected through the cloud',
  offline: 'Controller not reachable', demo: 'Demo mode — no controller',
};

const input: React.CSSProperties = {
  background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 8,
  padding: '8px 10px', color: 'var(--sg-text)', fontSize: 13, fontFamily: 'inherit', outline: 'none', minWidth: 0,
};

/**
 * Where the app looks for the controller: one address per network mode (the Pi is on the
 * MAgSO Wi-Fi, on the team's own router, or runs its own hotspot). All are tried in order;
 * the cloud address is the fallback for remote viewing.
 */
const ConnectionEditor: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const conn = useConnection();
  const [rows, setRows] = useState<ControllerAddress[]>(conn.controllers);
  const [cloud, setCloud] = useState(conn.cloudUrl);
  const [results, setResults] = useState<Record<number, string>>({});
  const dirty = JSON.stringify(rows) !== JSON.stringify(conn.controllers) || cloud !== conn.cloudUrl;

  const test = async (i: number) => {
    setResults(r => ({ ...r, [i]: 'Testing…' }));
    const res = await conn.test(rows[i].url);
    setResults(r => ({
      ...r,
      [i]: res.ok ? `✓ Reachable${res.role === 'cloud' ? ' (cloud)' : ''}${res.controllerOnline === false ? ' · control service down' : ''}` : '✗ No answer',
    }));
  };

  const save = () => {
    conn.setControllers(rows.filter(r => r.url.trim()));
    conn.setCloudUrl(cloud.trim());
  };

  return (
    <div>
      <div className="sg-row-between" style={{ marginBottom: 10 }}>
        <div className="sg-row sg-gap-8">
          <span className={`sg-pill ${conn.link === 'local' ? 'sg-pill-ok' : conn.link === 'remote' ? 'sg-pill-info' : conn.link === 'demo' ? 'sg-pill-warn' : 'sg-pill-crit'}`}>
            {conn.link.toUpperCase()}
          </span>
          <span style={{ fontSize: 12, color: 'var(--sg-muted)' }}>{conn.checking ? 'Checking…' : LINK_TEXT[conn.link]}</span>
        </div>
        {conn.mode === 'live' && (
          <IonButton size="small" fill="clear" onClick={() => conn.resolve()} disabled={conn.checking}>Retry</IonButton>
        )}
      </div>
      {conn.activeBase && <div style={{ fontSize: 11, color: 'var(--sg-dim)', marginBottom: 8 }}>Using {conn.activeBase} · checked {fmtTime(conn.lastCheckedAt, true)}</div>}

      {conn.mode === 'live' && !compact && (
        <>
          <div style={{ fontSize: 12, color: 'var(--sg-muted)', margin: '6px 0' }}>Controller addresses (tried in order)</div>
          {rows.map((r, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div className="sg-row sg-gap-8">
                <input style={{ ...input, width: 110 }} value={r.label} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
                <input style={{ ...input, flex: 1 }} value={r.url} placeholder="http://10.42.0.1:8000" inputMode="url"
                  onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} />
                <IonButton size="small" fill="outline" onClick={() => test(i)}>Test</IonButton>
                <IonButton size="small" fill="clear" color="medium" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</IonButton>
              </div>
              {results[i] && <div style={{ fontSize: 11, color: results[i].startsWith('✓') ? '#22c55e' : 'var(--sg-muted)', marginTop: 2 }}>{results[i]}</div>}
            </div>
          ))}
          <div className="sg-row sg-gap-8" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
            {PRESETS.filter(p => !rows.some(r => r.url === p.url)).map(p => (
              <span key={p.label} className="sg-filter-pill" onClick={() => setRows(rs => [...rs, p])}>+ {p.label}</span>
            ))}
            <span className="sg-filter-pill" onClick={() => setRows(rs => [...rs, { label: 'Custom', url: '' }])}>+ Custom</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--sg-muted)', margin: '6px 0' }}>Cloud address (remote viewing, optional)</div>
          <input style={{ ...input, width: '100%' }} value={cloud} placeholder="https://greenhouse.example.com" inputMode="url" onChange={e => setCloud(e.target.value)} />
          <IonButton expand="block" size="small" disabled={!dirty} style={{ marginTop: 10 }} onClick={save}>Save addresses</IonButton>
        </>
      )}
    </div>
  );
};

export default ConnectionEditor;
