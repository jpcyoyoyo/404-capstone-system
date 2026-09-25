import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';

export type Theme   = 'light' | 'dark' | 'system';
export type Accent   = 'green' | 'blue' | 'teal' | 'amber';
export type FontSize = 'small' | 'medium' | 'large';
export type Density  = 'compact' | 'normal' | 'comfortable';
export type Units    = 'metric' | 'imperial';
export type NumFmt    = '1,234.5' | '1.234,5';
export type Timezone  = 'utc' | 'local';
export type DateFmt   = 'iso' | 'regional';
export type SyncInterval = '5s' | '10s' | '30s' | '60s';
export type AlertSeverityFilter = 'critical' | 'warning' | 'all';
export type CacheDuration = '1h' | '6h' | '24h';

export const ACCENT_COLORS: Record<Accent, string> = {
  green: '#22c55e', blue: '#3b82f6', teal: '#14b8a6', amber: '#f59e0b',
};

const FONT_SCALE: Record<FontSize, number> = { small: 0.85, medium: 1, large: 1.2 };
const DENSITY_PAD: Record<Density, string> = { compact: '8px 10px', normal: '12px 14px', comfortable: '18px 18px' };

interface AppSettingsState {
  theme: Theme;
  accent: Accent;
  fontSize: FontSize;
  density: Density;
  units: Units;
  numFmt: NumFmt;
  timezone: Timezone;
  dateFmt: DateFmt;
  // Dashboard customisation
  showKpi: boolean;
  showActions: boolean;
  showEnergy: boolean;
  showFertilizer: boolean;
  // Notifications
  pushNotif: boolean;
  emailDigest: boolean;
  smsAlerts: boolean;
  severity: AlertSeverityFilter;
  // Data & Sync
  syncInterval: SyncInterval;
  offlineMode: boolean;
  cacheHrs: CacheDuration;
}

interface AppSettingsApi extends AppSettingsState {
  setTheme: (v: Theme) => void;
  setAccent: (v: Accent) => void;
  setFontSize: (v: FontSize) => void;
  setDensity: (v: Density) => void;
  setUnits: (v: Units) => void;
  setNumFmt: (v: NumFmt) => void;
  setTimezone: (v: Timezone) => void;
  setDateFmt: (v: DateFmt) => void;
  setShowKpi: (v: boolean) => void;
  setShowActions: (v: boolean) => void;
  setShowEnergy: (v: boolean) => void;
  setShowFertilizer: (v: boolean) => void;
  setPushNotif: (v: boolean) => void;
  setEmailDigest: (v: boolean) => void;
  setSmsAlerts: (v: boolean) => void;
  setSeverity: (v: AlertSeverityFilter) => void;
  setSyncInterval: (v: SyncInterval) => void;
  setOfflineMode: (v: boolean) => void;
  setCacheHrs: (v: CacheDuration) => void;
  resetDefaults: () => void;
  isDark: boolean;
  /** Converts a Celsius reading to the active unit system and returns { value, unit }. */
  formatTemp: (celsius: number, decimals?: number) => { value: string; unit: string };
}

const STORAGE_KEY = 'sg-app-settings';

const DEFAULTS: AppSettingsState = {
  theme: 'light',
  accent: 'green',
  fontSize: 'medium',
  density: 'normal',
  units: 'metric',
  numFmt: '1,234.5',
  timezone: 'utc',
  dateFmt: 'iso',
  showKpi: true,
  showActions: true,
  showEnergy: true,
  showFertilizer: true,
  pushNotif: true,
  emailDigest: true,
  smsAlerts: false,
  severity: 'warning',
  syncInterval: '10s',
  offlineMode: true,
  cacheHrs: '6h',
};

function loadInitial(): AppSettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore corrupt storage */ }
  return DEFAULTS;
}

const Ctx = createContext<AppSettingsApi>({
  ...DEFAULTS,
  setTheme: () => {}, setAccent: () => {}, setFontSize: () => {}, setDensity: () => {},
  setUnits: () => {}, setNumFmt: () => {}, setTimezone: () => {}, setDateFmt: () => {},
  setShowKpi: () => {}, setShowActions: () => {}, setShowEnergy: () => {}, setShowFertilizer: () => {},
  setPushNotif: () => {}, setEmailDigest: () => {}, setSmsAlerts: () => {}, setSeverity: () => {},
  setSyncInterval: () => {}, setOfflineMode: () => {}, setCacheHrs: () => {},
  resetDefaults: () => {},
  isDark: false,
  formatTemp: (c) => ({ value: c.toFixed(1), unit: '°C' }),
});

export const useAppSettings = () => useContext(Ctx);

export const AppSettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AppSettingsState>(loadInitial);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  // Resolve "system" against the OS preference, and keep it live.
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const isDark = state.theme === 'dark' || (state.theme === 'system' && systemPrefersDark);

  // Apply theme class + accent + font scale + density as CSS custom properties on <html>.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('ion-palette-dark', isDark);

    const accentHex = ACCENT_COLORS[state.accent];
    root.style.setProperty('--ion-color-primary', accentHex);
    root.style.setProperty('--sg-green', accentHex);
    root.style.setProperty('--ion-tab-bar-color-selected', accentHex);

    root.style.setProperty('--sg-font-scale', String(FONT_SCALE[state.fontSize]));
    root.style.setProperty('--sg-card-pad', DENSITY_PAD[state.density]);
  }, [isDark, state.accent, state.fontSize, state.density]);

  const formatTemp = (celsius: number, decimals = 1): { value: string; unit: string } => {
    if (state.units === 'imperial') {
      return { value: (celsius * 9 / 5 + 32).toFixed(decimals), unit: '°F' };
    }
    return { value: celsius.toFixed(decimals), unit: '°C' };
  };

  const api: AppSettingsApi = {
    ...state,
    setTheme:    (v) => setState(s => ({ ...s, theme: v })),
    setAccent:   (v) => setState(s => ({ ...s, accent: v })),
    setFontSize: (v) => setState(s => ({ ...s, fontSize: v })),
    setDensity:  (v) => setState(s => ({ ...s, density: v })),
    setUnits:    (v) => setState(s => ({ ...s, units: v })),
    setNumFmt:   (v) => setState(s => ({ ...s, numFmt: v })),
    setTimezone: (v) => setState(s => ({ ...s, timezone: v })),
    setDateFmt:  (v) => setState(s => ({ ...s, dateFmt: v })),
    setShowKpi:        (v) => setState(s => ({ ...s, showKpi: v })),
    setShowActions:    (v) => setState(s => ({ ...s, showActions: v })),
    setShowEnergy:     (v) => setState(s => ({ ...s, showEnergy: v })),
    setShowFertilizer: (v) => setState(s => ({ ...s, showFertilizer: v })),
    setPushNotif:   (v) => setState(s => ({ ...s, pushNotif: v })),
    setEmailDigest: (v) => setState(s => ({ ...s, emailDigest: v })),
    setSmsAlerts:   (v) => setState(s => ({ ...s, smsAlerts: v })),
    setSeverity:    (v) => setState(s => ({ ...s, severity: v })),
    setSyncInterval:(v) => setState(s => ({ ...s, syncInterval: v })),
    setOfflineMode: (v) => setState(s => ({ ...s, offlineMode: v })),
    setCacheHrs:    (v) => setState(s => ({ ...s, cacheHrs: v })),
    resetDefaults: () => setState(DEFAULTS),
    isDark,
    formatTemp,
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
};
