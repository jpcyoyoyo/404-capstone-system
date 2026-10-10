/**
 * Growth stage on the Thresholds page: day count, the days each stage lasts, automatic or manual
 * stage change, and "start a new crop". The controller does the counting (stages.py) and changes the
 * stage on its own in automatic mode; administrators can always pick a stage by hand (the manual option).
 */
import React, { useEffect, useState } from 'react';
import { IonButton, IonSpinner, useIonAlert, useIonToast } from '@ionic/react';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { localDate, scheduleLine, shortDate } from '../providers/stageSchedule';

const CIRCUIT_COLOR: Record<string, string> = { fog: '#38bdf8', drip: '#22c55e', sprinkler: '#a78bfa' };

const StageScheduleCard: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const gh = useGreenhouse();
  const [toast] = useIonToast();
  const [confirm] = useIonAlert();
  const s = gh.stageSchedule;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState<Record<string, string>>({});
  const [started, setStarted] = useState('');
  const demo = gh.mode === 'demo' ? 'SIMULATED — ' : '';
  const stages = [...gh.meta.stages].sort((a, b) => a.sequence - b.sequence);
  const nameOf = (id: string) => gh.meta.stages.find(x => x.id === id)?.name ?? id;

  useEffect(() => {
    if (s && !editing) {
      setDays(Object.fromEntries(Object.entries(s.days).map(([k, v]) => [k, String(v)])));
      setStarted(s.started_on);
    }
  }, [s, editing]);

  if (!s) {
    return <div className="sg-card"><div className="sg-section-title">Growth stage</div><IonSpinner name="dots" /></div>;
  }

  const say = (message: string, ok = true) => toast({ message, duration: ok ? 3000 : 4500, color: ok ? 'success' : 'danger', position: 'top' });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); say(`${demo}${ok}`); setEditing(false); }
    catch (e) { say(e instanceof Error ? e.message : 'Could not save.', false); }
    finally { setBusy(false); }
  };

  const setMode = (mode: 'auto' | 'manual') => {
    if (mode === s.mode) return;
    confirm({
      header: mode === 'auto' ? 'Automatic stage change' : 'Manual stage change',
      message: mode === 'auto'
        ? `The controller moves to the next stage when the days are up${s.overdue && s.next_stage_id ? ' — the current stage is already past its days, so it changes right away' : ''}.`
        : 'The stage stays where it is until an administrator changes it. Days are still counted.',
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Switch', handler: () => { run(() => gh.setStageSchedule({ mode }), `Stage change is now ${mode === 'auto' ? 'automatic' : 'manual'}.`); } }],
    });
  };

  const saveEdit = () => {
    const parsed: Record<string, number> = {};
    for (const st of stages) {
      const v = Number(days[st.id]);
      if (!Number.isInteger(v) || v < 1 || v > 365) { say(`${st.name}: enter whole days from 1 to 365.`, false); return; }
      parsed[st.id] = v;
    }
    if (!started || started > localDate(Date.now())) { say('The start date cannot be in the future.', false); return; }
    run(() => gh.setStageSchedule({ days: parsed, started_on: started }), 'Schedule saved.');
  };

  const newCrop = () => {
    const first = stages[0];
    confirm({
      header: 'Start a new crop?',
      message: `The stage goes back to ${first.name}, day 1 from today, and irrigation switches to the ${first.irrigation_mode} circuit. Do this after harvesting and sowing.`,
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Start', handler: () => { run(() => gh.setActiveStage(first.id), `New crop started: ${first.name}, day 1.`); } }],
    });
  };

  const active = gh.meta.stages.find(x => x.id === s.stage_id);
  const pct = Math.min(100, (Math.min(s.day, s.stage_days) / s.stage_days) * 100);
  const total = stages.reduce((n, st) => n + (s.days[st.id] ?? 0), 0) || 1;
  const cropPct = Math.min(100, ((s.crop_day - 0.5) / total) * 100);
  const input: React.CSSProperties = {
    width: '100%', background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 6,
    padding: '6px 8px', fontSize: 14, fontWeight: 600, color: 'var(--sg-text)', fontFamily: 'inherit', outline: 'none',
  };

  return (
    <div className="sg-card" data-testid="stage-schedule">
      <div className="sg-row-between" style={{ marginBottom: 8 }}>
        <div className="sg-section-title" style={{ marginBottom: 0 }}>Growth stage</div>
        <span className={`sg-pill ${s.harvest_due ? 'sg-pill-warn' : s.mode === 'auto' ? 'sg-pill-auto' : 'sg-pill-idle'}`}>
          {s.harvest_due ? 'HARVEST DUE' : s.mode === 'auto' ? 'AUTO CHANGE' : 'MANUAL'}
        </span>
      </div>

      <div className="sg-row-between" style={{ alignItems: 'flex-end', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--sg-text)', lineHeight: 1.1 }}>{active?.name ?? s.stage_id}</div>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 2 }}>
            <span style={{ color: CIRCUIT_COLOR[active?.irrigation_mode ?? ''] ?? 'var(--sg-muted)', fontWeight: 700 }}>● {active?.irrigation_mode}</span> irrigation · began {shortDate(s.started_on)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--sg-text)', fontVariantNumeric: 'tabular-nums' }}>Day {s.day}<span style={{ fontSize: 13, color: 'var(--sg-muted)', fontWeight: 600 }}> / {s.stage_days}</span></div>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)' }}>crop day {s.crop_day} of {s.crop_days}</div>
        </div>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--sg-elevated)', overflow: 'hidden', marginBottom: 10 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: s.overdue ? '#f59e0b' : 'var(--ion-color-primary)' }} />
      </div>

      {/* the whole crop: one segment per stage, sized by its days */}
      <div style={{ position: 'relative', display: 'flex', gap: 3, marginBottom: 4 }}>
        {stages.map(st => {
          const d = s.days[st.id] ?? 0;
          const on = st.id === s.stage_id;
          return (
            <div key={st.id} style={{ flex: d, minWidth: 0 }}>
              <div style={{ height: 22, borderRadius: 5, background: on ? `${CIRCUIT_COLOR[st.irrigation_mode] ?? '#64748b'}40` : 'var(--sg-elevated)',
                border: `1px solid ${on ? CIRCUIT_COLOR[st.irrigation_mode] ?? '#64748b' : 'var(--sg-border)'}`, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 10, fontWeight: 700, color: on ? 'var(--sg-text)' : 'var(--sg-muted)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                {st.name} · {d} d
              </div>
            </div>
          );
        })}
        <div title="today" style={{ position: 'absolute', bottom: -9, left: `calc(${cropPct}% - 5px)`, width: 0, height: 0,
          borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: '7px solid var(--sg-text)' }} />
      </div>
      <div style={{ fontSize: 12, color: s.harvest_due || s.overdue ? '#f59e0b' : 'var(--sg-muted)', margin: '8px 0 10px' }}>
        {s.harvest_due ? `Harvest due — the ${active?.name} stage ended ${s.day - s.stage_days} day(s) ago. Harvest, then start a new crop.`
          : s.mode === 'manual' ? `${scheduleLine(s, nameOf)}. The stage changes only when an administrator picks one.`
          : s.next_stage_id ? `${nameOf(s.next_stage_id)} starts automatically on ${shortDate(s.next_change_on)} (in ${s.days_left + 1} day${s.days_left ? 's' : ''}).`
          : `Last stage: ends ${shortDate(s.ends_on)}. The controller then reports harvest due.`}
      </div>

      {canEdit && !editing && (
        <>
          <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginBottom: 4 }}>Stage change</div>
          <div className="sg-row sg-gap-8" style={{ marginBottom: 10 }}>
            {(['auto', 'manual'] as const).map(m => (
              <span key={m} className={`sg-filter-pill ${s.mode === m ? 'active' : ''}`} onClick={() => !busy && setMode(m)}>
                {m === 'auto' ? 'Automatic (by days)' : 'Manual'}
              </span>
            ))}
          </div>
          <div className="sg-row sg-gap-8" style={{ flexWrap: 'wrap' }}>
            <IonButton size="small" fill="outline" disabled={busy} onClick={() => setEditing(true)}>Edit days</IonButton>
            <IonButton size="small" fill={s.harvest_due ? 'solid' : 'outline'} color={s.harvest_due ? 'warning' : 'medium'} disabled={busy} onClick={newCrop}>Start new crop</IonButton>
            {busy && <IonSpinner name="dots" />}
          </div>
          <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 8 }}>
            To change the stage by hand, open its tab below and press Make active.
          </div>
        </>
      )}

      {canEdit && editing && (
        <div style={{ borderTop: '1px solid var(--sg-border)', paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--sg-text)', marginBottom: 6 }}>Days in each stage</div>
          <div className="sg-row sg-gap-8" style={{ marginBottom: 10 }}>
            {stages.map(st => (
              <div key={st.id} style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginBottom: 3 }}>{st.name}</div>
                <input aria-label={`${st.name} days`} type="number" inputMode="numeric" min={1} max={365} step={1} value={days[st.id] ?? ''} style={input}
                  onChange={e => setDays(d => ({ ...d, [st.id]: e.target.value }))} />
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginBottom: 3 }}>{active?.name} stage began on (day 1)</div>
          <input aria-label="Stage began on" type="date" value={started} max={localDate(Date.now())} style={{ ...input, marginBottom: 10 }}
            onChange={e => setStarted(e.target.value)} />
          <div className="sg-row sg-gap-8">
            <IonButton size="small" disabled={busy} onClick={saveEdit}>{busy ? 'Saving…' : 'Save'}</IonButton>
            <IonButton size="small" fill="clear" color="medium" disabled={busy} onClick={() => setEditing(false)}>Cancel</IonButton>
          </div>
        </div>
      )}
      {!canEdit && (
        <div style={{ fontSize: 11, color: 'var(--sg-dim)' }}>
          Stage change is {s.mode === 'auto' ? 'automatic' : 'manual'} · {stages.map(st => `${st.name} ${s.days[st.id]} d`).join(' · ')}
        </div>
      )}
    </div>
  );
};

export default StageScheduleCard;
