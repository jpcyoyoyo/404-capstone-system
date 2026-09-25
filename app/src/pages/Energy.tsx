import React, { useState } from 'react';
import { IonPage, IonContent, IonButton, IonIcon } from '@ionic/react';
import {
  sunnyOutline, batteryHalfOutline, flashOutline, hardwareChipOutline,
  bulbOutline, leafOutline, informationCircleOutline, arrowForward,
} from 'ionicons/icons';
import PersistentHeader from '../components/PersistentHeader';
import Sparkline from '../components/Sparkline';
import { useGreenhouse } from '../providers/GreenhouseProvider';

const Energy: React.FC = () => {
  const gh = useGreenhouse();
  const [mode, setMode] = useState('normal');
  // Hidden unless the registry enables the "energy" capability (solar is outside the study scope).
  const e = gh.meta.capabilities.energy ? gh.energy : null;
  if (!e) {
    return (
      <IonPage>
        <PersistentHeader showBack defaultHref="/tabs/more" />
        <IonContent className="ion-padding">
          <div className="sg-card">
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--sg-text)' }}>No solar telemetry</div>
            <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginTop: 4 }}>
              Solar and battery monitoring is not part of this installation. It can be switched on later
              (capability "energy" in the registry) once MAgSO adds a solar setup.
            </div>
          </div>
        </IonContent>
      </IonPage>
    );
  }
  // Solar is outside the study scope; this screen is kept for when MAgSO adds it
  // (registry capability "energy"). Demo mode feeds it from the simulation.
  const sim = { solar: e.solarW, loads: e.loadsW, battery: e.batteryPct, solarToday: e.solarTodayKWh, batteryHistory: e.batteryHistory };

  const netW = sim.solar - sim.loads;
  const runtimeH = (sim.battery / 100 * 2400) / sim.loads;

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/dashboard" />
      <IonContent className="ion-padding">

        {/* Generation / Remaining */}
        <div className="sg-row sg-gap-8" style={{ marginBottom: 14 }}>
          <div className="sg-card" style={{ flex: 1, margin: 0, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}>
            <div className="sg-row sg-gap-6"><IonIcon icon={sunnyOutline} style={{ color: '#22c55e' }} /><span style={{ fontSize: 10, color: 'var(--sg-muted)', textTransform: 'uppercase' }}>Generation</span></div>
            <div style={{ fontSize: 24, fontWeight: 800, color: '#22c55e', marginTop: 4 }}>{sim.solarToday.toFixed(1)}<span style={{ fontSize: 13, fontWeight: 400 }}> kWh</span></div>
            <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 2 }}>Peak: {sim.solar}W</div>
          </div>
          <div className="sg-card" style={{ flex: 1, margin: 0, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)' }}>
            <div className="sg-row sg-gap-6"><IonIcon icon={batteryHalfOutline} style={{ color: '#3b82f6' }} /><span style={{ fontSize: 10, color: 'var(--sg-muted)', textTransform: 'uppercase' }}>Remaining</span></div>
            <div style={{ fontSize: 24, fontWeight: 800, color: '#3b82f6', marginTop: 4 }}>{runtimeH.toFixed(1)}<span style={{ fontSize: 13, fontWeight: 400 }}> hrs</span></div>
            <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 2 }}>Est. empty 04:15 AM</div>
          </div>
        </div>

        {/* Real-time power flow */}
        <div className="sg-card">
          <div className="sg-section-title">Real-time Power Flow</div>
          <div className="sg-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <div className="sg-flow-node">
              <IonIcon icon={sunnyOutline} style={{ fontSize: 18, color: '#f59e0b' }} />
              <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginTop: 4 }}>SOLAR</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>{sim.solar}W</div>
            </div>
            <IonIcon icon={arrowForward} className="sg-flow-arrow" />
            <div className="sg-flow-node active">
              <IonIcon icon={batteryHalfOutline} style={{ fontSize: 18, color: '#22c55e' }} />
              <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginTop: 4 }}>STORAGE</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: netW >= 0 ? '#22c55e' : '#ef4444' }}>{netW >= 0 ? '+' : ''}{netW}W Net</div>
            </div>
            <IonIcon icon={arrowForward} className="sg-flow-arrow" />
            <div className="sg-flow-node">
              <IonIcon icon={flashOutline} style={{ fontSize: 18, color: '#3b82f6' }} />
              <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginTop: 4 }}>LOADS</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>{sim.loads}W</div>
            </div>
          </div>
          <div className="sg-row sg-gap-12">
            <div className="sg-row sg-gap-6"><IonIcon icon={bulbOutline} style={{ fontSize: 13, color: 'var(--sg-muted)' }} /><span style={{ fontSize: 11, color: 'var(--sg-muted)' }}>Lighting: 180W</span></div>
            <div className="sg-row sg-gap-6"><IonIcon icon={leafOutline} style={{ fontSize: 13, color: 'var(--sg-muted)' }} /><span style={{ fontSize: 11, color: 'var(--sg-muted)' }}>Ventilation: 100W</span></div>
          </div>
        </div>

        {/* Energy modes */}
        <div className="sg-section-title" style={{ marginTop: 4 }}>Energy Modes</div>
        <div className="sg-row sg-gap-8" style={{ marginBottom: 14 }}>
          {[
            { id: 'normal',     label: 'Normal',   sub: 'Standard Ops',        icon: flashOutline },
            { id: 'eco',        label: 'Eco',       sub: 'Fan/Light -20%',      icon: hardwareChipOutline },
            { id: 'critical',   label: 'Critical',  sub: 'Vital Loads Only',    icon: informationCircleOutline },
          ].map(m => (
            <div key={m.id} className={`sg-select-card ${mode === m.id ? 'active' : ''}`} onClick={() => setMode(m.id)}>
              <IonIcon icon={m.icon} style={{ fontSize: 18, color: mode === m.id ? '#22c55e' : 'var(--sg-muted)' }} />
              <div style={{ fontSize: 13, fontWeight: 700, color: mode === m.id ? '#22c55e' : 'var(--sg-text)', marginTop: 6 }}>{m.label}</div>
              <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginTop: 2 }}>{m.sub}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: -8, marginBottom: 14, fontStyle: 'italic' }}>
          Display only — not yet wired to actuator behavior.
        </div>

        {/* Battery state */}
        <div className="sg-card">
          <div className="sg-row-between" style={{ marginBottom: 4 }}>
            <div className="sg-row sg-gap-8">
              <IonIcon icon={batteryHalfOutline} style={{ color: 'var(--sg-muted)' }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--sg-text)' }}>Battery State (24h)</span>
            </div>
            <span className="sg-pill sg-pill-ok">Healthy</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginBottom: 8 }}>Charging cycle efficiency: 94%</div>
          <Sparkline data={sim.batteryHistory} color="#22c55e" width={300} height={60} />
          <div className="sg-row-between" style={{ marginTop: 10, borderTop: '1px solid var(--sg-border)', paddingTop: 10 }}>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--sg-muted)' }}>Cycles</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>142</div>
            </div>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--sg-muted)' }}>Temp</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>24°C</div>
            </div>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--sg-muted)' }}>SOH</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>98.2%</div>
            </div>
          </div>
        </div>

        {/* Optimize battery life suggestion */}
        <div className="sg-card" style={{ border: '1px solid rgba(59,130,246,0.3)' }}>
          <div className="sg-row sg-gap-8">
            <div className="sg-icon-chip" style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6', flexShrink: 0 }}>
              <IonIcon icon={informationCircleOutline} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)', marginBottom: 4 }}>Optimize Battery Life</div>
              <div style={{ fontSize: 12, color: 'var(--sg-muted)', lineHeight: 1.5 }}>
                Based on today's low solar forecast, consider switching to <span style={{ color: '#3b82f6', fontWeight: 600 }}>Conserving Mode</span> after 06:00 PM to extend battery backup by 4.5 hours.
              </div>
              <IonButton fill="clear" size="small" style={{ '--color': '#3b82f6', '--padding-start': 0, marginTop: 4, fontSize: 12 }}>
                Apply Suggestion <IonIcon icon={arrowForward} slot="end" style={{ fontSize: 13 }} />
              </IonButton>
            </div>
          </div>
        </div>

      </IonContent>
    </IonPage>
  );
};

export default Energy;
