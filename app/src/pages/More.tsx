import React from 'react';
import { IonPage, IonContent, IonIcon } from '@ionic/react';
import { useHistory } from 'react-router-dom';
import {
  notificationsOutline, calendarOutline, analyticsOutline, flashOutline,
  settingsOutline, personOutline, optionsOutline, chevronForward, speedometerOutline,
} from 'ionicons/icons';
import PersistentHeader from '../components/PersistentHeader';
import { useGreenhouse } from '../providers/GreenhouseProvider';

const ALL_ITEMS = [
  { label: 'Alerts',        sub: 'View and acknowledge alerts',            icon: notificationsOutline, color: '#ef4444', path: '/tabs/alerts' },
  { label: 'Thresholds',    sub: 'Growth-stage bands & safety rules',      icon: calendarOutline,      color: '#3b82f6', path: '/tabs/schedules' },
  { label: 'Records',       sub: 'History, water & fertilizer reports',    icon: analyticsOutline,     color: '#6366f1', path: '/tabs/records' },
  { label: 'Calibration',   sub: 'Sensor constants and calibration age',   icon: speedometerOutline,   color: '#14b8a6', path: '/tabs/calibration' },
  { label: 'Power & Energy',sub: 'Solar and battery',                      icon: flashOutline,         color: '#f59e0b', path: '/tabs/energy', energy: true },
  { label: 'Settings',      sub: 'Users, logs, diagnostics',               icon: settingsOutline,      color: 'var(--sg-muted)', path: '/tabs/settings' },
  { label: 'App Settings',  sub: 'Connection, appearance, units',          icon: optionsOutline,       color: 'var(--sg-muted)', path: '/tabs/app-settings' },
  { label: 'Profile',       sub: 'Account and sign out',                   icon: personOutline,        color: '#22c55e', path: '/tabs/profile' },
];

const More: React.FC = () => {
  const history = useHistory();
  const { meta, unackedCount } = useGreenhouse();
  const items = ALL_ITEMS.filter(i => !i.energy || meta.capabilities.energy);
  return (
    <IonPage>
      <PersistentHeader />
      <IonContent className="ion-padding">
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--sg-text)', marginBottom: 14 }}>More</div>

        <div className="sg-card" style={{ padding: 0 }}>
          {items.map((it, i) => (
            <div
              key={it.label}
              onClick={() => history.push(it.path)}
              className="sg-row sg-gap-12"
              style={{
                padding: '14px 14px',
                borderBottom: i < items.length - 1 ? '1px solid var(--sg-border)' : 'none',
                cursor: 'pointer',
              }}
            >
              <div className="sg-icon-chip" style={{ background: `${it.color}1f`, color: it.color }}>
                <IonIcon icon={it.icon} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--sg-text)' }}>
                  {it.label}
                  {it.path === '/tabs/alerts' && unackedCount > 0 && <span className="sg-pill sg-pill-crit" style={{ marginLeft: 8 }}>{unackedCount} new</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 1 }}>{it.sub}</div>
              </div>
              <IonIcon icon={chevronForward} style={{ color: 'var(--sg-dim)', fontSize: 16 }} />
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--sg-dim)', padding: '12px 0' }}>
          SmartGreenhouse · v1.0.0
        </div>
      </IonContent>
    </IonPage>
  );
};

export default More;
