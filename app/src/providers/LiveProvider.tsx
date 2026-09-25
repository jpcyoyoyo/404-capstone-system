/**
 * Live data from the Raspberry Pi controller (or the cloud replica on the remote path).
 *
 * - REST for the first snapshot, commands and everything on demand (DataService).
 * - MQTT over WebSocket for readings, actuator states, controller status and alerts, using
 *   the read-only "app" account the API hands out at login. If the broker cannot be reached
 *   the provider falls back to polling /live every 5 s.
 * - The last snapshot is cached so the app can show greyed "last known" values while offline.
 */
import React, { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import { ApiError, type ApiClient } from '../api/client';
import { REGISTRY_META } from '../contract/registry.generated';
import type {
  ActuatorState, AlertItem, GreenhouseMeta, LiveSnapshot, MqttInfo, Reading, Threshold, ZoneSummary,
} from '../contract/types';
import { useAuth } from '../contexts/AuthContext';
import { useConnection } from '../contexts/ConnectionContext';
import { GreenhouseContext } from './context';
import { buildMetrics, newCmdId, pushHistory, summarise, thresholdMap } from './metrics';
import type { DataService, GreenhouseData } from './types';

const CACHE_KEY = 'sg-live-cache';
const POLL_STREAMING_MS = 30_000;
const POLL_FALLBACK_MS = 5_000;
const FLUSH_MS = 1_000;

interface Cache { meta: GreenhouseMeta; snapshot: LiveSnapshot; thresholds: Threshold[]; savedAt: string }

function loadCache(): Cache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCache(c: Cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* quota or unavailable */ }
}

const offline = (): Promise<never> => Promise.reject(new Error('Not connected to the controller.'));

export interface LiveOverride { api: ApiClient | null; mqtt: MqttInfo | null }

export const LiveProvider: React.FC<{ children: ReactNode; override?: LiveOverride }> = ({ children, override }) => {
  const auth = useAuth();
  const conn = useConnection();
  const api = override ? override.api : (auth.isAuthenticated && auth.session?.mode === 'live' ? auth.api : null);
  const mqttInfo = override ? override.mqtt : auth.session?.mqtt ?? null;
  const cached = useMemo(loadCache, []);

  const [meta, setMeta] = useState<GreenhouseMeta>(cached?.meta ?? REGISTRY_META);
  const [readings, setReadings] = useState<Record<string, Reading>>(cached?.snapshot.readings ?? {});
  const [ctrlZones, setCtrlZones] = useState<Record<string, ZoneSummary>>(cached?.snapshot.zones ?? {});
  const [actuators, setActuators] = useState<Record<string, ActuatorState>>(cached?.snapshot.actuators ?? {});
  const [stage, setStage] = useState<string>(cached?.snapshot.active_stage ?? 'growth');
  const [thresholds, setThresholds] = useState<Threshold[]>(cached?.thresholds ?? []);
  const [openAlerts, setOpenAlerts] = useState<AlertItem[]>([]);
  const [unackedCount, setUnacked] = useState(0);
  const [controllerOnline, setOnline] = useState(false);
  const [nodes, setNodes] = useState<Record<string, boolean>>({});
  const [lastUpdate, setLastUpdate] = useState<string | null>(cached?.snapshot.server_time ?? null);
  const [ready, setReady] = useState(!!cached);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [hist, setHist] = useState<Record<string, number[]>>({});

  const metaRef = useRef(meta); metaRef.current = meta;
  const resolveRef = useRef(conn.resolve); resolveRef.current = conn.resolve;
  const stageRef = useRef(stage); stageRef.current = stage;

  // ── loading ─────────────────────────────────────────────────────────
  const loadThresholds = useCallback(async (s: string) => {
    if (!api) return;
    try { setThresholds(await api.thresholds(s)); } catch { /* keep previous */ }
  }, [api]);

  const loadAlerts = useCallback(async () => {
    if (!api) return;
    try {
      const [open, unacked] = await Promise.all([api.alerts('open', 200), api.alerts('unacknowledged', 200)]);
      setOpenAlerts(open);
      setUnacked(unacked.filter(a => !a.resolved_at).length);
    } catch { /* keep previous */ }
  }, [api]);

  const applySnapshot = useCallback((snap: LiveSnapshot, m: GreenhouseMeta) => {
    setReadings(snap.readings);
    setCtrlZones(snap.zones);
    setActuators(snap.actuators);
    setOnline(snap.controller.online);
    setNodes(snap.controller.nodes ?? {});
    setLastUpdate(snap.server_time);
    if (snap.active_stage !== stageRef.current) setStage(snap.active_stage);
    metaRef.current = m;
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const m = await api.meta();
      setMeta(m);
      const snap = await api.live(m.id);
      applySnapshot(snap, m);
      const thr = await api.thresholds(snap.active_stage);
      setThresholds(thr);
      saveCache({ meta: m, snapshot: snap, thresholds: thr, savedAt: new Date().toISOString() });
      setReady(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load data from the controller.');
      if (e instanceof ApiError && e.status === 0) {
        // The controller stopped answering: mark it down and look for another path (other address, cloud).
        setOnline(false);
        resolveRef.current();
      }
    }
  }, [api, applySnapshot]);

  useEffect(() => {
    if (!api) {
      setStreaming(false);
      if (conn.mode === 'live' && conn.link === 'offline') setError('Offline — showing the last known values.');
      return;
    }
    refresh();
    loadAlerts();
  }, [api, refresh, loadAlerts, conn.mode, conn.link]);

  // ── MQTT over WebSocket ─────────────────────────────────────────────
  const clientRef = useRef<MqttClient | null>(null);
  useEffect(() => {
    if (!api || !mqttInfo?.url) return;
    const pending: { readings: Record<string, Reading>; acts: Record<string, ActuatorState> } = { readings: {}, acts: {} };
    let dirty = false;
    const prefix = mqttInfo.prefix;
    const client = mqtt.connect(mqttInfo.url, {
      username: mqttInfo.username ?? undefined,
      password: mqttInfo.password ?? undefined,
      clientId: `app-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000, connectTimeout: 6000, clean: true,
    });
    clientRef.current = client;
    client.on('connect', () => {
      setStreaming(true);
      client.subscribe([
        `${prefix}/zone/+/sensor/+`, `${prefix}/actuator/+/state`, `${prefix}/status`,
        `${prefix}/alert`, `${prefix}/config/changed`, `${prefix}/node/+/status`,
      ], { qos: 0 });
    });
    const down = () => { setStreaming(false); refresh(); };
    client.on('close', down);
    client.on('offline', down);
    client.on('error', down);
    client.on('message', (topic, buf) => {
      let p: Record<string, unknown>;
      try { p = JSON.parse(buf.toString()); } catch { return; }
      const rest = topic.slice(prefix.length + 1);
      if (rest.startsWith('zone/')) {
        const r = p as unknown as Reading;
        pending.readings[r.sensor_id] = r; dirty = true;
      } else if (rest.startsWith('actuator/') && rest.endsWith('/state')) {
        const a = p as unknown as ActuatorState;
        pending.acts[a.actuator_id] = a; dirty = true;
      } else if (rest === 'status') {
        setOnline(!!p.online);
        if (p.params) setCtrlZones(p.params as Record<string, ZoneSummary>);
        if (p.nodes) setNodes(p.nodes as Record<string, boolean>);
        if (typeof p.active_stage === 'string' && p.active_stage !== stageRef.current) {
          setStage(p.active_stage);
        }
        if (typeof p.ts === 'string') setLastUpdate(p.ts);
      } else if (rest.startsWith('node/')) {
        const node = rest.split('/')[1];
        setNodes(n => ({ ...n, [node]: !!p.online }));
      } else if (rest === 'alert') {
        loadAlerts();
      } else if (rest === 'config/changed') {
        if (p.what === 'thresholds') loadThresholds(stageRef.current);
        else refresh();
      }
    });
    const flush = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      const r = pending.readings; const a = pending.acts;
      pending.readings = {}; pending.acts = {};
      if (Object.keys(r).length) setReadings(prev => ({ ...prev, ...r }));
      if (Object.keys(a).length) setActuators(prev => ({ ...prev, ...a }));
      setLastUpdate(new Date().toISOString());
    }, FLUSH_MS);
    return () => {
      clearInterval(flush);
      client.end(true);
      clientRef.current = null;
      setStreaming(false);
    };
  }, [api, mqttInfo?.url, mqttInfo?.username, mqttInfo?.password, mqttInfo?.prefix, loadAlerts, loadThresholds, refresh]);

  // ── polling (always slow; fast when MQTT is down) ───────────────────
  useEffect(() => {
    if (!api) return;
    const id = setInterval(() => { refresh(); loadAlerts(); }, streaming ? POLL_STREAMING_MS : POLL_FALLBACK_MS);
    return () => clearInterval(id);
  }, [api, streaming, refresh, loadAlerts]);

  useEffect(() => { loadThresholds(stage); }, [stage, loadThresholds]);

  // ── derived ─────────────────────────────────────────────────────────
  const zones = useMemo(() => {
    const own = summarise(meta, readings);
    for (const [k, z] of Object.entries(ctrlZones)) {
      if (own[k]) own[k] = { ...own[k], manual_required: z.manual_required ?? [] };
    }
    return own;
  }, [meta, readings, ctrlZones]);
  useEffect(() => { setHist(h => pushHistory(h, zones)); }, [zones]);
  const thrMap = useMemo(() => thresholdMap(thresholds), [thresholds]);
  const metrics = useMemo(() => buildMetrics(meta, readings, zones, thrMap, hist), [meta, readings, zones, thrMap, hist]);

  const data = useMemo<DataService>(() => api ? {
    history: q => api.history(metaRef.current.id, q),
    thresholds: s => api.thresholds(s),
    putThresholds: async (s, list) => { const r = await api.putThresholds(s, list); if (s === stageRef.current) setThresholds(r); return r; },
    alerts: (st, l) => api.alerts(st, l),
    ackAlert: async id => { const r = await api.ackAlert(id); loadAlerts(); return r; },
    audit: l => api.audit(l),
    events: (l, a) => api.events(l, a),
    waterUsage: d => api.waterUsage(d),
    fertilizer: d => api.fertilizer(d),
    calibrations: () => api.calibrations(),
    calibrate: (id, b) => api.calibrate(id, b),
    users: () => api.users(),
    addUser: u => api.addUser(u),
    patchUser: (id, p) => api.patchUser(id, p),
  } : {
    history: offline, thresholds: offline, putThresholds: offline, alerts: offline, ackAlert: offline, audit: offline,
    events: offline, waterUsage: offline, fertilizer: offline, calibrations: offline, calibrate: offline, users: offline,
    addUser: offline, patchUser: offline,
  }, [api, loadAlerts]);

  const sendCommand = useCallback<GreenhouseData['sendCommand']>(async (c) => {
    if (!api) return { cmd_id: c.cmd_id ?? '', status: 'REJECTED', reason: 'OFFLINE', message: 'Not connected to the controller.', ts: new Date().toISOString() };
    const ack = await api.command({ ...c, cmd_id: c.cmd_id ?? newCmdId(), ts: new Date().toISOString() });
    if (!clientRef.current?.connected) setTimeout(() => { refresh(); }, 600);
    return ack;
  }, [api, refresh]);

  const setActiveStage = useCallback(async (id: string) => {
    if (!api) throw new Error('Not connected to the controller.');
    await api.setStage(metaRef.current.id, id);
    setStage(id);
    await loadThresholds(id);
  }, [api, loadThresholds]);

  const link = conn.link;
  const value: GreenhouseData = {
    mode: 'live', link, ready, error, streaming, lastUpdate,
    controllerOnline: !!api && controllerOnline, nodes,
    meta: { ...meta, active_stage: stage },
    readings, zones, metrics, actuators,
    activeStageId: stage, thresholds: thrMap, openAlerts, unackedCount,
    energy: null,
    canCommand: !!api && controllerOnline && (link === 'local' || !!meta.capabilities.remote_commands),
    sendCommand, setActiveStage, refresh, reloadAlerts: loadAlerts, data,
  };
  return <GreenhouseContext.Provider value={value}>{children}</GreenhouseContext.Provider>;
};
