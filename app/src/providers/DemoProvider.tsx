import React, { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DemoController, DemoSnapshot } from '../simulation/demoEngine';
import type { DataService, GreenhouseData } from './types';
import { buildMetrics, newCmdId, pushHistory, summarise, thresholdMap } from './metrics';
import { GreenhouseContext } from './context';
import { useAuth } from '../contexts/AuthContext';

const STAGE_KEY = 'sg-active-stage';
const TICK_MS = 2000;

function loadStage(): string {
  try { return localStorage.getItem(STAGE_KEY) || 'growth'; } catch { return 'growth'; }
}

const later = <T,>(fn: () => T, ms = 150): Promise<T> =>
  new Promise((res, rej) => setTimeout(() => { try { res(fn()); } catch (e) { rej(e); } }, ms));

/**
 * Permanent, always-labelled demo mode (Integration Plan §9.3): the same data shapes as the
 * controller, produced by an in-app simulation. Commands are acknowledged as SIMULATED.
 */
export const DemoProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { session } = useAuth();
  const who = session?.user.email ?? 'demo@greenhouse.local';
  const engine = useMemo(() => new DemoController(loadStage()), []);
  const [snap, setSnap] = useState<DemoSnapshot>(() => engine.snapshot());
  const [hist, setHist] = useState<Record<string, number[]>>({});
  const [thrVersion, setThrVersion] = useState(0);
  const whoRef = useRef(who);
  whoRef.current = who;

  useEffect(() => {
    const id = setInterval(() => {
      const s = engine.tick(TICK_MS / 1000);
      setSnap(s);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [engine]);

  const zones = useMemo(() => summarise(engine.meta, snap.readings), [engine, snap.readings]);
  useEffect(() => { setHist(h => pushHistory(h, zones)); }, [zones]);

  useEffect(() => {
    try { localStorage.setItem(STAGE_KEY, snap.stage); } catch { /* storage unavailable */ }
  }, [snap.stage]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const thresholds = useMemo(() => thresholdMap(engine.thresholds[snap.stage] ?? []), [engine, snap.stage, thrVersion]);
  const metrics = useMemo(() => buildMetrics(engine.meta, snap.readings, zones, thresholds, hist), [engine, snap.readings, zones, thresholds, hist]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const openAlerts = useMemo(() => engine.alertsList('open'), [engine, snap.alertsVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const unackedCount = useMemo(() => engine.alertsList('unacknowledged').filter(a => !a.resolved_at).length, [engine, snap.alertsVersion]);

  const data = useMemo<DataService>(() => ({
    history: q => later(() => engine.history(q), 250),
    thresholds: stage => later(() => engine.thresholds[stage] ?? []),
    putThresholds: (stage, list) => later(() => { const r = engine.putThresholds(stage, list, whoRef.current); setThrVersion(v => v + 1); return r; }),
    alerts: (status, limit) => later(() => engine.alertsList(status, limit)),
    ackAlert: id => later(() => { const r = engine.ackAlert(id, whoRef.current); setSnap(engine.snapshot()); return r; }),
    audit: (limit = 200) => later(() => engine.audit.slice(0, limit)),
    events: (limit = 200, actuator) => later(() => engine.events.filter(e => !actuator || e.actuator_id === actuator).slice(0, limit)),
    waterUsage: days => later(() => engine.waterUsage(days)),
    fertilizer: days => later(() => engine.fertilizer(days)),
    calibrations: () => later(() => engine.calibrationList()),
    calibrate: (id, body) => later(() => engine.calibrate(id, body, whoRef.current)),
    users: () => later(() => engine.users),
    addUser: u => later(() => engine.addUser(u)),
    patchUser: (id, p) => later(() => engine.patchUser(id, p)),
  }), [engine]);

  const sendCommand = useCallback<GreenhouseData['sendCommand']>(async (c) => {
    await new Promise(r => setTimeout(r, 350));
    const ack = engine.command({ ...c, cmd_id: c.cmd_id ?? newCmdId(), ts: new Date().toISOString() }, whoRef.current);
    setSnap(engine.snapshot());
    return ack;
  }, [engine]);

  const setActiveStage = useCallback(async (id: string) => {
    engine.setStage(id, whoRef.current);
    setSnap(engine.snapshot());
  }, [engine]);

  const value: GreenhouseData = {
    mode: 'demo', link: 'demo', ready: true, error: null, streaming: true,
    lastUpdate: new Date(snap.now).toISOString(), controllerOnline: true, nodes: { node_a: true, node_b: true },
    meta: { ...engine.meta, active_stage: snap.stage },
    readings: snap.readings, zones, metrics, actuators: snap.actuators,
    activeStageId: snap.stage, thresholds, openAlerts, unackedCount,
    energy: snap.energy,
    canCommand: true,
    sendCommand, setActiveStage,
    refresh: async () => setSnap(engine.snapshot()),
    reloadAlerts: async () => setSnap(engine.snapshot()),
    data,
  };
  return <GreenhouseContext.Provider value={value}>{children}</GreenhouseContext.Provider>;
};
