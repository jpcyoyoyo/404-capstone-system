// Thin REST client for the controller API (controller/greenhouse/services/api.py).
import type {
  Ack, AlertItem, AuditEntry, CalibrationBody, CalibrationEntry, CommandRequest, EventEntry, FertilizerReport,
  ActivePreset, CloudState, CloudTest, PushConfig, PushSendResult, GreenhouseMeta, HistoryResult, LiveSnapshot, NetworkStatus, PresetBands, PresetList,
  StageSchedule, Threshold, ThresholdPreset, TokenResponse, UserItem, WaterDay, WifiNetwork,
} from '../contract/types';

export class ApiError extends Error {
  /** The parsed JSON error body, when there was one (e.g. the cloud test result on a failed set-up). */
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

export interface TokenSource {
  access(): string | null;
  /** Called once on a 401; returns a fresh access token or null (signed out). It throws when the
   *  server could not be asked (no connection, timeout, server error): the sign-in is kept. */
  refresh(): Promise<string | null>;
}

/**
 * Whether a failed token renewal means the server refused the sign-in (expired, signed out, password
 * changed, account deactivated), so the app should sign out. Anything else (no connection, a time-out,
 * a server error while switching between the controller and the cloud) keeps the sign-in: before
 * 19 Nov 2026 those also signed people out.
 */
export function signInRefused(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

const TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url: string, init: RequestInit, ms = TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

export function normaliseBase(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, '');
  // A bare host gets the API's default port.
  try {
    const parsed = new URL(u);
    if (!parsed.port && parsed.protocol === 'http:' && parsed.pathname === '/') u = `${u}:8000`;
  } catch { /* leave as typed */ }
  return u;
}

/** GET /health with a short timeout — used to pick the controller address that answers. */
export async function probe(base: string, ms = 2500): Promise<{ ok: boolean; role?: string; controllerOnline?: boolean }> {
  try {
    const r = await fetchWithTimeout(`${base}/health`, { method: 'GET' }, ms);
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: true, role: j.role, controllerOnline: j.controller_online };
  } catch {
    return { ok: false };
  }
}

/** What GET /export takes (controller/greenhouse/export.py). */
export interface ExportQuery {
  datasets: ExportDataset[];
  from: string;             // ISO
  to: string;
  types?: string[];         // sensor types; empty: all
  sensors?: string[];
  resolution: 'raw' | '15m' | '1h' | '1d';
  layout: 'long' | 'wide';
  invalid?: boolean;
}
export type ExportDataset = 'readings' | 'summary' | 'water' | 'fertilizer' | 'activity' | 'alerts' | 'power';
export interface ExportFile { blob: Blob; filename: string }

export class ApiClient {
  constructor(public base: string, private tokens: TokenSource) {}

  private async request<T>(method: string, path: string, body?: unknown, retry = true, timeoutMs?: number): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const tok = this.tokens.access();
    if (tok) headers.Authorization = `Bearer ${tok}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r: Response;
    try {
      r = await fetchWithTimeout(`${this.base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }, timeoutMs);
    } catch (e) {
      throw new ApiError(0, e instanceof Error && e.name === 'AbortError' ? 'The controller did not respond in time.' : 'Cannot reach the controller.');
    }
    if (r.status === 401 && retry && tok) {
      const fresh = await this.tokens.refresh();
      if (fresh) return this.request<T>(method, path, body, false, timeoutMs);
    }
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      let j: unknown;
      try {
        j = await r.json();
        const d = (j as { detail?: unknown }).detail;
        if (typeof d === 'string') msg = d;
        else if (Array.isArray(d)) msg = d.map((x: { msg?: string }) => x.msg).filter(Boolean).join('; ');
      } catch { /* not JSON */ }
      throw new ApiError(r.status, msg, j);
    }
    return r.json() as Promise<T>;
  }

  // auth (no bearer needed)
  login(email: string, password: string) { return this.request<TokenResponse>('POST', '/auth/login', { email, password }, false); }
  refreshToken(refresh_token: string) { return this.request<TokenResponse>('POST', '/auth/refresh', { refresh_token }, false); }
  /** Signs this device out; `everywhere`: every device signed in to this account. */
  logout(everywhere = false) { return this.request<{ ok: boolean; everywhere?: boolean }>('POST', '/auth/logout', { everywhere }); }
  changePassword(current_password: string, new_password: string) {
    return this.request<TokenResponse>('POST', '/auth/password', { current_password, new_password });
  }
  kioskToken(token?: string) {
    return this.request<TokenResponse>('GET', `/auth/kiosk${token ? `?token=${encodeURIComponent(token)}` : ''}`, undefined, false);
  }

  // live
  meta() { return this.request<GreenhouseMeta>('GET', '/greenhouse'); }
  live(gid: string) { return this.request<LiveSnapshot>('GET', `/greenhouse/${gid}/live`); }
  history(gid: string, q: { sensor?: string; type?: string; zone?: number; from?: string; to?: string; resolution?: string; limit?: number }) {
    const p = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); });
    return this.request<HistoryResult>('GET', `/greenhouse/${gid}/history?${p.toString()}`);
  }

  // control — the API waits up to ~8 s for the controller's ack
  command(c: CommandRequest) {
    const { actuator_id, ...body } = c;
    return this.request<Ack>('POST', `/actuator/${actuator_id}/command`, body, true, 20_000);
  }
  setStage(gid: string, stage_id: string, started_on?: string) {
    return this.request<StageSchedule & { stage_id: string }>('PUT', `/greenhouse/${gid}/stage`, { stage_id, started_on });
  }
  stageSchedule(gid: string) { return this.request<StageSchedule>('GET', `/greenhouse/${gid}/stage`); }
  putStageSchedule(gid: string, body: { mode?: 'auto' | 'manual'; days?: Record<string, number>; started_on?: string }) {
    return this.request<StageSchedule>('PUT', `/greenhouse/${gid}/stage-schedule`, body);
  }
  thresholds(stage: string) { return this.request<Threshold[]>('GET', `/thresholds/${stage}`); }
  putThresholds(stage: string, list: { parameter: string; min: number; max: number; deadband?: number }[]) {
    return this.request<Threshold[]>('PUT', `/thresholds/${stage}`, list);
  }
  presets() { return this.request<PresetList>('GET', '/threshold-presets'); }
  createPreset(p: { name: string; note?: string; bands?: PresetBands }) { return this.request<ThresholdPreset>('POST', '/threshold-presets', p); }
  editPreset(id: string, patch: { name?: string; note?: string; bands?: PresetBands }) {
    return this.request<ThresholdPreset>('PUT', `/threshold-presets/${encodeURIComponent(id)}`, patch);
  }
  async deletePreset(id: string) { await this.request<{ ok: boolean }>('DELETE', `/threshold-presets/${encodeURIComponent(id)}`); }
  applyPreset(id: string) {
    return this.request<{ active: ActivePreset | null; changed: number }>('POST', `/threshold-presets/${encodeURIComponent(id)}/apply`);
  }

  // alerts & logs
  alerts(status: 'all' | 'open' | 'unacknowledged' = 'all', limit = 100) { return this.request<AlertItem[]>('GET', `/alerts?status=${status}&limit=${limit}`); }
  alert(id: number) { return this.request<AlertItem & { detail?: unknown }>('GET', `/alerts/${id}`); }
  ackAlert(id: number) { return this.request<AlertItem>('POST', `/alerts/${id}/ack`); }
  audit(limit = 200) { return this.request<AuditEntry[]>('GET', `/logs?kind=audit&limit=${limit}`); }
  events(limit = 200, actuator?: string) {
    return this.request<EventEntry[]>('GET', `/logs?kind=events&limit=${limit}${actuator ? `&actuator=${actuator}` : ''}`);
  }

  /** Records as a .csv (one dataset) or a .zip (several); allows two minutes for long periods. */
  async exportData(q: ExportQuery, retry = true): Promise<ExportFile> {
    const p = new URLSearchParams({
      datasets: q.datasets.join(','), from: q.from, to: q.to, types: (q.types ?? []).join(','),
      sensors: (q.sensors ?? []).join(','), resolution: q.resolution, layout: q.layout, invalid: String(!!q.invalid),
    });
    const tok = this.tokens.access();
    const headers: Record<string, string> = { Accept: 'text/csv, application/zip, application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    let r: Response;
    try {
      r = await fetchWithTimeout(`${this.base}/export?${p.toString()}`, { method: 'GET', headers }, 120_000);
    } catch (e) {
      throw new ApiError(0, e instanceof Error && e.name === 'AbortError' ? 'The export took too long. Try a shorter period or averages.' : 'Cannot reach the controller.');
    }
    if (r.status === 401 && retry && tok) {
      const fresh = await this.tokens.refresh();
      if (fresh) return this.exportData(q, false);
    }
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { const d = (await r.json()).detail; if (typeof d === 'string') msg = d; } catch { /* not JSON */ }
      throw new ApiError(r.status, msg);
    }
    const cd = r.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `greenhouse-export.${q.datasets.length > 1 ? 'zip' : 'csv'}`;
    return { blob: await r.blob(), filename };
  }

  // reports, calibration, users
  waterUsage(days = 7) { return this.request<WaterDay[]>('GET', `/reports/water-usage?days=${days}`); }
  fertilizer(days = 30) { return this.request<FertilizerReport>('GET', `/reports/fertilizer?days=${days}`); }
  calibrations() { return this.request<CalibrationEntry[]>('GET', '/calibration'); }
  calibrate(sensorId: string, body: CalibrationBody) { return this.request<{ constants: Record<string, unknown> }>('POST', `/calibration/${sensorId}`, body); }
  users() { return this.request<UserItem[]>('GET', '/users'); }
  addUser(u: { email: string; name: string; password: string; role: 'admin' | 'viewer' }) { return this.request<UserItem>('POST', '/users', u); }
  patchUser(id: number, patch: Partial<{ name: string; role: 'admin' | 'viewer'; active: boolean; password: string; sign_out: boolean }>) {
    return this.request<UserItem>('PATCH', `/users/${id}`, patch);
  }
  // cloud server (required) and network settings (greenhouse display)
  cloud() { return this.request<CloudState>('GET', '/cloud'); }
  cloudTest(body: { url?: string; token?: string }) { return this.request<CloudTest>('POST', '/cloud/test', body, true, 25_000); }
  cloudSetup(body: { url: string; token: string; force?: boolean }) {
    return this.request<CloudState & { test: CloudTest }>('PUT', '/cloud', body, true, 25_000);
  }
  network() { return this.request<NetworkStatus>('GET', '/network', undefined, true, 25_000); }
  wifiScan() { return this.request<WifiNetwork[]>('GET', '/network/wifi', undefined, true, 35_000); }
  wifiSet(body: { profile: 'magso' | 'router'; ssid: string; password: string }) {
    return this.request<{ ok: boolean; connected?: boolean; message: string }>('POST', '/network/wifi', body, true, 80_000);
  }
  wifiForget(profile: 'magso' | 'router') { return this.request<{ ok: boolean; message: string }>('DELETE', `/network/wifi/${profile}`); }
  hotspot() { return this.request<{ ok: boolean; message: string }>('POST', '/network/hotspot', undefined, true, 50_000); }

  // Web Push notifications (sent by the cloud server)
  pushConfig() { return this.request<PushConfig>('GET', '/push/config'); }
  pushSubscribe(subscription: PushSubscriptionJSON, level: 'all' | 'urgent', label: string) {
    return this.request<{ registered: boolean; level: 'all' | 'urgent' }>('POST', '/push/subscription', { subscription, level, label });
  }
  pushCheck(endpoint: string) {
    return this.request<{ registered: boolean; level: 'all' | 'urgent' | null }>('POST', '/push/subscription/check', { endpoint });
  }
  pushUnsubscribe(endpoint: string) { return this.request<{ ok: boolean; removed: boolean }>('POST', '/push/unsubscribe', { endpoint }); }
  pushTest() { return this.request<PushSendResult>('POST', '/push/test', undefined, true, 25_000); }

  simFault(f: { kind: string; sensor_id?: string; node_id?: string; value?: number; attr?: string }) {
    return this.request<{ ok: boolean }>('POST', '/sim/fault', f);
  }
}
