/**
 * Plant presets on the Thresholds page: a named set of bands for all three growth stages.
 * Applying one rewrites every stage's thresholds at once (controller: POST /threshold-presets/{id}/apply).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IonButton, IonSpinner, useIonAlert, useIonToast } from '@ionic/react';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import type { Band, PresetBands, ThresholdPreset } from '../contract/types';
import { presetDiff } from '../providers/presets';

interface Props {
  /** Admin on the greenhouse network (or demo). Viewers and the cloud path only see the list. */
  canEdit: boolean;
  /** The page has unsaved band edits: saving "current" would not include them. */
  hasUnsaved: boolean;
  /** Called after anything that changes the live thresholds, so the page reloads its table. */
  onChanged: () => void;
}

type Mode = { kind: 'idle' } | { kind: 'list' } | { kind: 'preview'; preset: ThresholdPreset }
  | { kind: 'save' } | { kind: 'edit'; preset: ThresholdPreset };

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString() : String(v));
const bandText = (b: Band | undefined) => (b ? `${fmt(b.min)}–${fmt(b.max)} (±${fmt(b.deadband)})` : '—');
const label = (p: string) => METRIC_INFO[p as MetricKey]?.label ?? p;

const PresetCard: React.FC<Props> = ({ canEdit, hasUnsaved, onChanged }) => {
  const gh = useGreenhouse();
  const [toast] = useIonToast();
  const [confirm] = useIonAlert();
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [presets, setPresets] = useState<ThresholdPreset[]>([]);
  const [current, setCurrent] = useState<PresetBands>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name: '', note: '' });
  const active = gh.activePreset;
  const demo = gh.mode === 'demo' ? 'SIMULATED — ' : '';

  const say = (message: string, ok = true) =>
    toast({ message, duration: ok ? 3000 : 4500, color: ok ? 'success' : 'danger', position: 'top' });
  const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, ...stages] = await Promise.all([
        gh.data.presets(),
        ...gh.meta.stages.map(s => gh.data.thresholds(s.id)),
      ]);
      setPresets(list.presets);
      const cur: PresetBands = {};
      gh.meta.stages.forEach((s, i) => {
        cur[s.id] = Object.fromEntries(stages[i].map(t => [t.parameter, { min: t.min, max: t.max, deadband: t.deadband }]));
      });
      setCurrent(cur);
    } catch (e) {
      say(errText(e, 'Could not load presets.'), false);
    } finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gh.data, gh.meta.stages]);

  useEffect(() => { if (mode.kind === 'list') load(); }, [mode.kind, load]);

  const stageName = useCallback((id: string) => gh.meta.stages.find(s => s.id === id)?.name ?? id, [gh.meta.stages]);
  const diff = useMemo(() => (mode.kind === 'preview' ? presetDiff(current, mode.preset.bands) : []), [mode, current]);

  const apply = (p: ThresholdPreset) => {
    confirm({
      header: `Apply ${p.name}?`,
      message: diff.length
        ? `${diff.length} band${diff.length > 1 ? 's' : ''} will change (all three stages are set from this preset). The controller uses them from its next cycle.`
        : 'The thresholds already match this preset; it will just be marked as the active plant.',
      buttons: [{ text: 'Cancel', role: 'cancel' }, {
        text: 'Apply', handler: () => {
          setBusy(true);
          gh.data.applyPreset(p.id)
            .then(r => { say(`${demo}${p.name} applied (${r.changed} band${r.changed === 1 ? '' : 's'} changed).`); setMode({ kind: 'idle' }); onChanged(); })
            .catch(e => say(errText(e, 'Could not apply the preset.'), false))
            .finally(() => setBusy(false));
        },
      }],
    });
  };

  const saveNew = async () => {
    setBusy(true);
    try {
      const p = await gh.data.createPreset({ name: form.name.trim(), note: form.note.trim() });
      say(`${demo}Saved "${p.name}" with the thresholds of all ${gh.meta.stages.length} stages.`);
      setForm({ name: '', note: '' });
      setMode({ kind: 'list' });
      onChanged();
    } catch (e) { say(errText(e, 'Could not save the preset.'), false); }
    finally { setBusy(false); }
  };

  const saveEdit = async (p: ThresholdPreset) => {
    setBusy(true);
    try {
      await gh.data.editPreset(p.id, { name: form.name.trim(), note: form.note.trim() });
      say(`${demo}Preset updated.`);
      setMode({ kind: 'list' });
    } catch (e) { say(errText(e, 'Could not update the preset.'), false); }
    finally { setBusy(false); }
  };

  const updateActiveFromCurrent = () => {
    if (!active) return;
    confirm({
      header: `Update ${active.name}?`,
      message: 'The preset will be overwritten with the thresholds now in force for all three stages.',
      buttons: [{ text: 'Cancel', role: 'cancel' }, {
        text: 'Update', handler: () => {
          setBusy(true);
          Promise.all(gh.meta.stages.map(s => gh.data.thresholds(s.id)))
            .then(lists => {
              const bands: PresetBands = {};
              gh.meta.stages.forEach((s, i) => {
                bands[s.id] = Object.fromEntries(lists[i].map(t => [t.parameter, { min: t.min, max: t.max, deadband: t.deadband }]));
              });
              return gh.data.editPreset(active.id, { bands });
            })
            .then(() => { say(`${demo}${active.name} now matches the current thresholds.`); onChanged(); })
            .catch(e => say(errText(e, 'Could not update the preset.'), false))
            .finally(() => setBusy(false));
        },
      }],
    });
  };

  const remove = (p: ThresholdPreset) => {
    confirm({
      header: `Delete ${p.name}?`,
      message: active?.id === p.id
        ? 'This is the active preset. The thresholds stay as they are; they just will not have a preset name.'
        : 'The preset is removed. Thresholds in force are not changed.',
      buttons: [{ text: 'Cancel', role: 'cancel' }, {
        text: 'Delete', role: 'destructive', handler: () => {
          gh.data.deletePreset(p.id)
            .then(() => { say(`${demo}Deleted "${p.name}".`); load(); })
            .catch(e => say(errText(e, 'Could not delete the preset.'), false));
        },
      }],
    });
  };

  const input: React.CSSProperties = {
    width: '100%', background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 6,
    padding: '8px 10px', fontSize: 14, color: 'var(--sg-text)', fontFamily: 'inherit', outline: 'none', marginBottom: 8,
  };
  const small: React.CSSProperties = { fontSize: 11, color: 'var(--sg-dim)' };
  const nameOk = form.name.trim().length > 0 && form.name.trim().length <= 60;
  // The built-in preset comes from the registry and cannot be overwritten.
  const canUpdateActive = canEdit && !!active?.modified && !hasUnsaved && active.id !== 'petchay';

  return (
    <div className="sg-card" data-testid="preset-card">
      <div className="sg-row-between" style={{ gap: 8 }}>
        <div className="sg-section-title" style={{ marginBottom: 0 }}>Plant preset</div>
        {(loading || busy) && <IonSpinner name="dots" />}
      </div>

      <div className="sg-row-between" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--sg-text)' }}>{active ? active.name : 'Custom thresholds'}</div>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 2 }}>
            {active
              ? (active.modified ? 'Edited since it was applied' : 'All three stages match this preset')
              : 'Not saved as a preset'}
          </div>
        </div>
        {active?.modified && <span className="sg-pill sg-pill-warn">Edited</span>}
      </div>

      {mode.kind === 'idle' && (
        <div className="sg-row sg-gap-8" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <IonButton size="small" onClick={() => setMode({ kind: 'list' })}>{canEdit ? 'Change plant…' : 'View presets'}</IonButton>
          {canEdit && (
            <IonButton size="small" fill="outline" disabled={hasUnsaved}
              onClick={() => { setForm({ name: '', note: '' }); setMode({ kind: 'save' }); }}>Save as preset…</IonButton>
          )}
          {canUpdateActive && <IonButton size="small" fill="clear" disabled={busy} onClick={updateActiveFromCurrent}>Update {active?.name}</IonButton>}
          {canEdit && hasUnsaved && <div style={{ ...small, width: '100%' }}>Save or discard your band changes before saving a preset.</div>}
        </div>
      )}

      {mode.kind === 'list' && (
        <div style={{ marginTop: 10 }}>
          {presets.map(p => (
            <div key={p.id} style={{ borderTop: '1px solid var(--sg-border)', padding: '9px 0' }}>
              <div className="sg-row-between" style={{ gap: 8 }}>
                <button onClick={() => setMode({ kind: 'preview', preset: p })} data-testid={`preset-${p.id}`}
                  style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', minWidth: 0, flex: 1, fontFamily: 'inherit' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--sg-text)' }}>
                    {p.name}{active?.id === p.id && <span className="sg-pill sg-pill-ok" style={{ marginLeft: 6 }}>Active</span>}
                    {p.builtin && <span className="sg-pill sg-pill-idle" style={{ marginLeft: 6 }}>Built-in</span>}
                  </div>
                  {p.note && <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 2 }}>{p.note}</div>}
                </button>
                {canEdit && !p.builtin && (
                  <div className="sg-row" style={{ flexShrink: 0 }}>
                    <IonButton size="small" fill="clear" onClick={() => { setForm({ name: p.name, note: p.note }); setMode({ kind: 'edit', preset: p }); }}>Edit</IonButton>
                    <IonButton size="small" fill="clear" color="danger" onClick={() => remove(p)}>Delete</IonButton>
                  </div>
                )}
              </div>
            </div>
          ))}
          {!loading && presets.length === 0 && <div style={small}>No presets.</div>}
          <div className="sg-row sg-gap-8" style={{ marginTop: 6 }}>
            <IonButton size="small" fill="clear" color="medium" onClick={() => setMode({ kind: 'idle' })}>Close</IonButton>
          </div>
        </div>
      )}

      {mode.kind === 'preview' && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--sg-text)', marginBottom: 4 }}>{mode.preset.name}</div>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginBottom: 8 }}>
            {diff.length ? `What changes if you apply it (${diff.length} band${diff.length > 1 ? 's' : ''}):` : 'Matches the thresholds in force — nothing would change.'}
          </div>
          {gh.meta.stages.map(s => {
            const rows = diff.filter(d => d.stage === s.id);
            if (!rows.length) return null;
            return (
              <div key={s.id} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--sg-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{stageName(s.id)}</div>
                {rows.map(r => (
                  <div key={r.param} className="sg-row-between" style={{ fontSize: 12, padding: '3px 0', gap: 8 }}>
                    <span style={{ color: 'var(--sg-muted)' }}>{label(r.param)}</span>
                    <span style={{ color: 'var(--sg-text)', textAlign: 'right' }}>
                      <span style={{ color: 'var(--sg-dim)' }}>{bandText(r.from)}</span> → {bandText(r.to)}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
          <div className="sg-row sg-gap-8" style={{ marginTop: 6 }}>
            {canEdit && <IonButton size="small" disabled={busy} onClick={() => apply(mode.preset)}>Apply to all stages</IonButton>}
            <IonButton size="small" fill="clear" color="medium" onClick={() => setMode({ kind: 'list' })}>Back</IonButton>
          </div>
        </div>
      )}

      {(mode.kind === 'save' || mode.kind === 'edit') && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginBottom: 6 }}>
            {mode.kind === 'save'
              ? `Saves the thresholds now in force for all ${gh.meta.stages.length} stages under a plant name.`
              : 'Rename or change the note. To change the bands, apply it, edit them, then use "Update".'}
          </div>
          <input style={input} placeholder="Plant name, e.g. Lettuce (loose-leaf)" maxLength={60} value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} aria-label="Preset name" />
          <input style={input} placeholder="Note (optional): source of the bands, variety…" maxLength={255} value={form.note}
            onChange={e => setForm(f => ({ ...f, note: e.target.value }))} aria-label="Preset note" />
          <div className="sg-row sg-gap-8">
            <IonButton size="small" disabled={busy || !nameOk}
              onClick={() => (mode.kind === 'save' ? saveNew() : saveEdit(mode.preset))}>{busy ? 'Saving…' : 'Save'}</IonButton>
            <IonButton size="small" fill="clear" color="medium" onClick={() => setMode(mode.kind === 'save' ? { kind: 'idle' } : { kind: 'list' })}>Cancel</IonButton>
          </div>
        </div>
      )}
    </div>
  );
};

export default PresetCard;
