import React, { useEffect, useState } from 'react';
import { IonPage, IonContent, IonButton, IonIcon, IonSpinner, useIonActionSheet, useIonAlert } from '@ionic/react';
import { useHistory } from 'react-router-dom';
import { powerOutline, informationCircleOutline, lockClosedOutline, chevronDown, chevronUp } from 'ionicons/icons';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useCommand } from '../components/useCommand';
import { ACTUATOR_ICON } from '../components/display';
import { fmtTime, untilText } from '../components/format';
import { reasonText } from '../contract/codes';
import type { ActuatorDef, ActuatorState, Circuit } from '../contract/types';

const DURATIONS = [1, 3, 5, 10, 15, 30];
const GROUP_TITLE: Record<string, string> = { climate: 'Climate & lighting', fertigation: 'Fertigation', enclosure: 'Controller enclosure' };
const COMPONENTS = ['pump', 'valve_fog', 'valve_drip', 'valve_sprinkler', 'servo_main', 'servo_diverter'];

const Controls: React.FC = () => {
  const gh = useGreenhouse();
  const history = useHistory();
  const { send, busy, blocked } = useCommand();
  const [sheet] = useIonActionSheet();
  const [alert] = useIonAlert();
  const [estopChecked, setEstopChecked] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const [, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(id); }, []);

  const stage = gh.meta.stages.find(s => s.id === gh.activeStageId);
  const irrDef = gh.meta.actuators.find(a => a.id === 'irrigation');
  const irr = gh.actuators.irrigation;
  const maxMin = Math.round(gh.meta.control.manual_override_max_s / 60);
  const durations = DURATIONS.filter(d => d <= maxMin);

  const pickDuration = (title: string, then: (s: number) => void) => {
    sheet({
      header: title,
      buttons: [
        ...durations.map(d => ({ text: `${d} min`, handler: () => then(d * 60) })),
        { text: 'Cancel', role: 'cancel' },
      ],
    });
  };

  const waterNow = () => {
    const circuits = (['fog', 'drip', 'sprinkler'] as Circuit[]).filter(c => gh.meta.actuators.some(a => a.id === `valve_${c}` && a.installed));
    sheet({
      header: 'Irrigate with which circuit?',
      subHeader: `The ${stage?.name ?? ''} stage uses ${stage?.irrigation_mode}.`,
      buttons: [
        ...circuits.map(c => ({
          text: `${c[0].toUpperCase()}${c.slice(1)}${c === stage?.irrigation_mode ? ' (stage default)' : ''}`,
          handler: () => pickDuration(`Run ${c} for how long?`, s => {
            alert({
              header: 'Start irrigation?',
              message: `The pump will run the ${c} circuit for up to ${Math.round(s / 60)} min, then return to automatic.`,
              buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Start', handler: () => { send({ actuator_id: 'irrigation', action: 'ON', circuit: c, duration_s: s }); } }],
            });
          }),
        })),
        { text: 'Cancel', role: 'cancel' },
      ],
    });
  };

  const lockout = (st: ActuatorState | undefined, def: ActuatorDef) =>
    !def.installed ? 'Not installed' : st?.lockout ? reasonText(st.lockout) : def.manual_only ? reasonText('MANUAL_ONLY') : null;

  const DeviceRow: React.FC<{ def: ActuatorDef }> = ({ def }) => {
    const st = gh.actuators[def.id];
    const lock = lockout(st, def);
    const manual = st?.mode === 'MANUAL';
    const disabled = !!blocked || !def.installed || def.manual_only || busy !== null;
    return (
      <div className="sg-toggle-row" style={{ opacity: def.installed ? 1 : 0.55, alignItems: 'flex-start' }}>
        <IonIcon icon={ACTUATOR_ICON[def.id]} style={{ fontSize: 18, color: st?.on ? '#22c55e' : 'var(--sg-muted)', marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="sg-row sg-gap-8">
            <span style={{ fontSize: 14, color: 'var(--sg-text)', fontWeight: 600 }}>{def.name}</span>
            <span className={`sg-pill ${st?.on ? 'sg-pill-ok' : 'sg-pill-idle'}`} style={{ fontSize: 9 }}>{st?.on ? 'ON' : 'OFF'}</span>
            {manual && <span className="sg-pill sg-pill-warn" style={{ fontSize: 9 }}>MANUAL</span>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 2 }}>
            {lock ? <><IonIcon icon={lockClosedOutline} style={{ fontSize: 10 }} /> {lock}</>
              : manual && st?.manual_until ? `Manual · ${untilText(st.manual_until)}`
              : st?.reason ? `${st.reason}${st.since ? ` · ${fmtTime(st.since)}` : ''}` : 'Automatic'}
          </div>
          {def.installed && !def.manual_only && def.kind !== 'stepper' && (
            <div className="sg-row sg-gap-8" style={{ marginTop: 8 }}>
              {busy === def.id ? <IonSpinner name="dots" /> : <>
                <IonButton size="small" fill={st?.on && manual ? 'solid' : 'outline'} disabled={disabled}
                  onClick={() => pickDuration(`Turn ${def.name} on for how long?`, s => send({ actuator_id: def.id, action: 'ON', duration_s: s }))}>On</IonButton>
                <IonButton size="small" fill={!st?.on && manual ? 'solid' : 'outline'} color="medium" disabled={disabled}
                  onClick={() => pickDuration(`Hold ${def.name} off for how long?`, s => send({ actuator_id: def.id, action: 'OFF', duration_s: s }))}>Off</IonButton>
                <IonButton size="small" fill={!manual ? 'solid' : 'outline'} color="success" disabled={disabled || !manual}
                  onClick={() => send({ actuator_id: def.id, action: 'AUTO' })}>Auto</IonButton>
              </>}
            </div>
          )}
        </div>
      </div>
    );
  };

  const groups = new Map<string, ActuatorDef[]>();
  for (const a of gh.meta.actuators) {
    if (a.virtual || COMPONENTS.includes(a.id) || a.group === 'irrigation') continue;
    groups.set(a.group, [...(groups.get(a.group) ?? []), a]);
  }
  const irrLock = irrDef ? lockout(irr, irrDef) : null;
  const irrManual = irr?.mode === 'MANUAL';

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/dashboard" />
      <IonContent className="ion-padding">
        <StatusBanner />
        {blocked && gh.mode === 'live' && (
          <div className="sg-banner-offline" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <IonIcon icon={informationCircleOutline} style={{ fontSize: 16, flexShrink: 0 }} /><span>{blocked}</span>
          </div>
        )}

        <div className="sg-card">
          <div className="sg-row-between">
            <div>
              <div style={{ fontSize: 10, color: 'var(--sg-muted)', textTransform: 'uppercase', letterSpacing: 0.6 }}>Active stage</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--sg-text)', marginTop: 2 }}>{stage?.name} · {stage?.irrigation_mode} irrigation</div>
            </div>
            <IonButton size="small" fill="outline" onClick={() => history.push('/tabs/schedules')}>Change</IonButton>
          </div>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 8, lineHeight: 1.5 }}>
            The controller runs everything on its own. A manual command holds a device for the time you pick (at most {maxMin} min), then it returns to automatic.
            Safety interlocks (low water, float switch) always win.
          </div>
        </div>

        {irrDef && (
          <div className="sg-card" style={{ border: irr?.on ? '1px solid rgba(59,130,246,0.4)' : undefined }}>
            <div className="sg-row-between" style={{ marginBottom: 6 }}>
              <div className="sg-row sg-gap-8">
                <IonIcon icon={ACTUATOR_ICON.irrigation} style={{ color: '#3b82f6', fontSize: 18 }} />
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--sg-text)' }}>Irrigation</span>
              </div>
              <div className="sg-row sg-gap-4">
                <span className={`sg-pill ${irr?.on ? 'sg-pill-info' : 'sg-pill-idle'}`}>{irr?.on ? `ON · ${irr.circuit}` : 'OFF'}</span>
                <span className={`sg-pill ${irrManual ? 'sg-pill-warn' : 'sg-pill-ok'}`}>{irrManual ? 'MANUAL' : 'AUTO'}</span>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginBottom: 10 }}>
              {irrLock ? <span style={{ color: '#ef4444' }}><IonIcon icon={lockClosedOutline} /> {irrLock}</span>
                : irr?.on ? `${irr.reason ?? `Running on the ${irr.circuit} circuit`}${irr.since || irr.ts ? ` since ${fmtTime(irr.since ?? irr.ts)}` : ''}${irrManual && irr.manual_until ? ` · ${untilText(irr.manual_until)}` : ''}`
                : `Starts when soil moisture drops below ${gh.thresholds.soil_moisture?.min ?? '—'}% (now ${gh.metrics.soil_moisture.value?.toFixed(0) ?? '—'}%).`}
            </div>
            {busy === 'irrigation' ? <IonSpinner name="dots" /> : (
              <div className="sg-row sg-gap-8">
                <IonButton size="small" disabled={!!blocked || !!irrLock || busy !== null} onClick={waterNow}>Water now</IonButton>
                <IonButton size="small" color="medium" fill="outline" disabled={!!blocked || busy !== null}
                  onClick={() => pickDuration('Hold irrigation off for how long?', s => send({ actuator_id: 'irrigation', action: 'OFF', duration_s: s }))}>Stop</IonButton>
                <IonButton size="small" color="success" fill={irrManual ? 'solid' : 'outline'} disabled={!!blocked || !irrManual || busy !== null}
                  onClick={() => send({ actuator_id: 'irrigation', action: 'AUTO' })}>Auto</IonButton>
              </div>
            )}
            <div className="sg-row-between" style={{ marginTop: 12, cursor: 'pointer' }} onClick={() => setShowParts(v => !v)}>
              <span style={{ fontSize: 12, color: 'var(--sg-muted)' }}>Pump, valves and servos</span>
              <IonIcon icon={showParts ? chevronUp : chevronDown} style={{ color: 'var(--sg-muted)' }} />
            </div>
            {showParts && (
              <div style={{ marginTop: 6 }}>
                {COMPONENTS.map(id => {
                  const def = gh.meta.actuators.find(a => a.id === id);
                  const st = gh.actuators[id];
                  if (!def) return null;
                  return (
                    <div key={id} className="sg-row-between" style={{ padding: '6px 0', borderTop: '1px solid var(--sg-border)' }}>
                      <span style={{ fontSize: 12, color: 'var(--sg-text)' }}>{def.name}{def.manual_only ? ' (by hand)' : ''}</span>
                      <span className={`sg-pill ${st?.on ? 'sg-pill-ok' : 'sg-pill-idle'}`} style={{ fontSize: 9 }}>{!def.installed ? 'N/A' : st?.lockout ? st.lockout : st?.on ? 'ON' : 'OFF'}</span>
                    </div>
                  );
                })}
                <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 4 }}>These follow the irrigation command: valves open before the pump starts; the pump stops first.</div>
              </div>
            )}
          </div>
        )}

        {[...groups.entries()].map(([g, defs]) => (
          <div key={g} className="sg-card">
            <div className="sg-section-title">{GROUP_TITLE[g] ?? g}</div>
            {defs.map(d => <DeviceRow key={d.id} def={d} />)}
            {g === 'fertigation' && (
              <IonButton size="small" fill="clear" onClick={() => history.push('/tabs/fertigation')}>Dose fertilizer →</IonButton>
            )}
          </div>
        ))}

        <div className="sg-card" style={{ border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.05)' }}>
          <div className="sg-row sg-gap-8" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={estopChecked} onChange={e => setEstopChecked(e.target.checked)} style={{ width: 16, height: 16 }} />
            <span style={{ fontSize: 12, color: '#fca5a5' }}>I understand this stops every device and holds it in manual</span>
          </div>
          <IonButton expand="block" disabled={!estopChecked || !!blocked || busy !== null}
            onClick={async () => { await send({ actuator_id: 'all', action: 'ESTOP', reason: 'ESTOP' }); setEstopChecked(false); }}
            style={{ '--background': estopChecked ? '#ef4444' : 'rgba(239,68,68,0.2)', '--color': '#fff', '--border-radius': '12px', fontWeight: 800, height: 48 }}>
            <IonIcon icon={powerOutline} slot="start" />
            EMERGENCY STOP
          </IonButton>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 8, textAlign: 'center' }}>
            The controller keeps running its safety rules even if this phone disconnects.
          </div>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default Controls;
