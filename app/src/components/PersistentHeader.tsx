import React from 'react';
import { IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonIcon } from '@ionic/react';
import { leaf } from 'ionicons/icons';
import { useHistory } from 'react-router-dom';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import type { Link } from '../providers/types';
import { fmtTime, initials } from './format';

interface PersistentHeaderProps {
  showBack?: boolean;
  defaultHref?: string;
}

const LINK_LABEL: Record<Link, string> = {
  local: 'Online', remote: 'Remote', demo: 'Demo mode', offline: 'Offline',
};
const LINK_COLOR: Record<Link, string> = {
  local: '#22c55e', remote: '#3b82f6', demo: '#f59e0b', offline: '#ef4444',
};

const PersistentHeader: React.FC<PersistentHeaderProps> = ({
  showBack = false,
  defaultHref = '/tabs/dashboard',
}) => {
  const history = useHistory();
  const gh = useGreenhouse();
  const { session } = useAuth();
  const stageName = gh.meta.stages.find(s => s.id === gh.activeStageId)?.name ?? gh.activeStageId;
  const link: Link = gh.link === 'local' && !gh.controllerOnline ? 'offline' : gh.link;
  const e = gh.energy;
  const batColor = e ? (e.batteryPct < 30 ? '#ef4444' : e.batteryPct < 50 ? '#f59e0b' : '#22c55e') : '';

  return (
    <IonHeader>
      <IonToolbar>
        {showBack && (
          <IonButtons slot="start">
            <IonBackButton defaultHref={defaultHref} />
          </IonButtons>
        )}

        <IonTitle>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 15, fontWeight: 700, color: 'var(--sg-text)', minWidth: 0, letterSpacing: -0.1 }}>
              <IonIcon icon={leaf} style={{ color: 'var(--sg-green)', fontSize: 15, flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gh.meta.name}</span>
            </span>
            <span style={{ fontSize: 10, color: 'var(--sg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {gh.activePreset ? gh.activePreset.name.replace(/\s*\(default\)$/, '') : 'Custom thresholds'} · {stageName} stage
            </span>
          </div>
        </IonTitle>

        <IonButtons slot="end">
          <div style={{ textAlign: 'right', lineHeight: 1.6, marginRight: 8 }}>
            <div style={{ fontSize: 10, color: LINK_COLOR[link], fontWeight: 600, whiteSpace: 'nowrap' }}>
              <span className={`sg-live-dot${gh.streaming && link !== 'offline' ? ' on' : ''}`} />
              {gh.link === 'local' && !gh.controllerOnline ? 'Controller down' : LINK_LABEL[link]}
            </div>
            {e && gh.meta.capabilities.energy && (
              <div style={{ fontSize: 10, color: 'var(--sg-muted)' }}>
                ☀ {e.solarW}W · <span style={{ color: batColor }}>🔋 {e.batteryPct.toFixed(0)}%</span>
              </div>
            )}
            <div style={{ fontSize: 10, color: 'var(--sg-muted)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
              {gh.streaming ? 'Live' : 'Sync'} {fmtTime(gh.lastUpdate, true)}
            </div>
          </div>

          <div
            onClick={() => history.push('/tabs/profile')}
            title={session?.user.name}
            style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'linear-gradient(135deg, #22c55e 0%, #15803d 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 800, color: '#fff',
              cursor: 'pointer', marginRight: 4, flexShrink: 0,
              border: '2px solid rgba(34,197,94,0.45)',
              boxShadow: '0 0 8px rgba(34,197,94,0.25)',
              userSelect: 'none',
            }}
          >
            {initials(session?.user.name)}
          </div>
        </IonButtons>
      </IonToolbar>
    </IonHeader>
  );
};

export default PersistentHeader;
