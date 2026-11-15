import React from 'react';
import { IonIcon } from '@ionic/react';
import { useHistory, useLocation } from 'react-router-dom';
import {
  gridOutline, pulseOutline, optionsOutline, waterOutline, notificationsOutline, calendarOutline,
  analyticsOutline, speedometerOutline, flashOutline, settingsOutline, colorPaletteOutline, leaf,
} from 'ionicons/icons';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import { initials } from './format';

interface NavItem { label: string; icon: string; path: string; match?: string[]; energy?: boolean; alerts?: boolean }

/** Desktop navigation, shown instead of the bottom tab bar from 992px wide (theme/layout.css).
 *  The same pages as the tabs plus everything under More, so nothing is two clicks away. */
const GROUPS: { title: string; items: NavItem[] }[] = [
  { title: 'Monitor', items: [
    { label: 'Overview',     icon: gridOutline,          path: '/tabs/dashboard' },
    { label: 'Live sensors', icon: pulseOutline,         path: '/tabs/live-monitor' },
    { label: 'Records',      icon: analyticsOutline,     path: '/tabs/records' },
    { label: 'Alerts',       icon: notificationsOutline, path: '/tabs/alerts', match: ['/tabs/alert-detail'], alerts: true },
  ] },
  { title: 'Operate', items: [
    { label: 'Controls',     icon: optionsOutline,       path: '/tabs/controls' },
    { label: 'Nutrients',    icon: waterOutline,         path: '/tabs/fertigation' },
    { label: 'Thresholds',   icon: calendarOutline,      path: '/tabs/schedules' },
    { label: 'Calibration',  icon: speedometerOutline,   path: '/tabs/calibration' },
    { label: 'Power',        icon: flashOutline,         path: '/tabs/energy', energy: true },
  ] },
  { title: 'System', items: [
    { label: 'Settings',     icon: settingsOutline,      path: '/tabs/settings' },
    { label: 'App settings', icon: colorPaletteOutline,  path: '/tabs/app-settings' },
  ] },
];

const SideNav: React.FC = () => {
  const history = useHistory();
  const { pathname } = useLocation();
  const { meta, unackedCount } = useGreenhouse();
  const { session } = useAuth();
  const user = session?.user;

  const isActive = (it: NavItem) => [it.path, ...(it.match ?? [])].some(p => pathname === p || pathname.startsWith(p + '/'));
  const go = (path: string) => { if (pathname !== path) history.push(path); };

  return (
    <nav className="sg-sidenav" aria-label="Main">
      <div className="sg-sidenav-brand">
        <div className="sg-sidenav-logo"><IonIcon icon={leaf} /></div>
        <div style={{ minWidth: 0 }}>
          <div className="sg-sidenav-app">SmartGreenhouse</div>
          <div className="sg-sidenav-site" title={meta.name}>{meta.name}</div>
        </div>
      </div>

      <div className="sg-sidenav-scroll">
        {GROUPS.map(g => {
          const items = g.items.filter(i => !i.energy || meta.capabilities.energy);
          return (
            <div key={g.title} className="sg-sidenav-group">
              <div className="sg-sidenav-title">{g.title}</div>
              {items.map(it => {
                const on = isActive(it);
                return (
                  <button key={it.path} type="button" className={`sg-sidenav-item${on ? ' active' : ''}`}
                    aria-current={on ? 'page' : undefined} onClick={() => go(it.path)}>
                    <IonIcon icon={it.icon} aria-hidden="true" />
                    <span className="sg-sidenav-label">{it.label}</span>
                    {it.alerts && unackedCount > 0 && <span key={unackedCount} className="sg-sidenav-badge sg-pop">{unackedCount}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <button type="button" className={`sg-sidenav-user${pathname === '/tabs/profile' ? ' active' : ''}`} onClick={() => go('/tabs/profile')}>
        <span className="sg-sidenav-avatar">{initials(user?.name)}</span>
        <span style={{ minWidth: 0, textAlign: 'left' }}>
          <span className="sg-sidenav-uname">{user?.name ?? 'Signed out'}</span>
          <span className="sg-sidenav-urole">{user?.role === 'admin' ? 'Administrator' : 'Viewer'}{session?.mode === 'demo' ? ' · demo' : ''}</span>
        </span>
      </button>
    </nav>
  );
};

export default SideNav;
