// Thin REST client for the controller API (controller/greenhouse/services/api.py).
import type {
  Ack, AlertItem, AuditEntry, CalibrationBody, CalibrationEntry, CommandRequest, EventEntry, FertilizerReport,
  GreenhouseMeta, HistoryResult, LiveSnapshot, Threshold, TokenResponse, UserItem, WaterDay,
} from '../contract/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface TokenSource {
  access(): string | null;
  /** Called once on a 401; returns a fresh access token or null (signed out). */
  refresh(): Promise<string | null>;
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
      try {
        const j = await r.json();
        if (typeof j.detail === 'string') msg = j.detail;
        else if (Array.isArray(j.detail)) msg = j.detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join('; ');
      } catch { /* not JSON */ }
      throw new ApiError(r.status, msg);
    }
    return r.json() as Promise<T>;
  }

  // auth (no bearer needed)
  login(email: string, password: string) { return this.request<TokenResponse>('POST', '/auth/login', { email, password }, false); }
  refreshToken(refresh_token: string) { return this.request<TokenResponse>('POST', '/auth/refresh', { refresh_token }, false); }
  logout() { return this.request<{ ok: boolean }>('POST', '/auth/logout'); }
  changePassword(current_password: string, new_password: string) {
    return this.request<TokenResponse>('POST', '/auth/password', { current_password, new_password });
  }
  kioskToken(token?: string) {
    return this.request<TokenResponse>('GET', `/auth/kiosk${token ? `?token=${encodeURIComponent(token)}` : ''}`, undefined, false);
  }

  // live
  meta() { return this.request<GreenhouseMeta>('GET', '/greenhouse'); }
  live(gid: string) { return this.request<LiveSnapshot>('GET', `/greenhouse/${gid}/live`); }
  history(gid: string, q: { sensor?: string; type?: string; zone?: number; from?: string; to?: string; resolution?: string }) {
    const p = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); });
    return this.request<HistoryResult>('GET', `/greenhouse/${gid}/history?${p.toString()}`);
  }

  // control — the API waits up to ~8 s for the controller's ack
  command(c: CommandRequest) {
    const { actuator_id, ...body } = c;
    return this.request<Ack>('POST', `/actuator/${actuator_id}/command`, body, true, 20_000);
  }
  setStage(gid: string, stage_id: string) { return this.request<{ stage_id: string }>('PUT', `/greenhouse/${gid}/stage`, { stage_id }); }
  thresholds(stage: string) { return this.request<Threshold[]>('GET', `/thresholds/${stage}`); }
  putThresholds(stage: string, list: { parameter: string; min: number; max: number; deadband?: number }[]) {
    return this.request<Threshold[]>('PUT', `/thresholds/${stage}`, list);
  }

  // alerts & logs
  alerts(status: 'all' | 'open' | 'unacknowledged' = 'all', limit = 100) { return this.request<AlertItem[]>('GET', `/alerts?status=${status}&limit=${limit}`); }
  alert(id: number) { return this.request<AlertItem & { detail?: unknown }>('GET', `/alerts/${id}`); }
  ackAlert(id: number) { return this.request<AlertItem>('POST', `/alerts/${id}/ack`); }
  audit(limit = 200) { return this.request<AuditEntry[]>('GET', `/logs?kind=audit&limit=${limit}`); }
  events(limit = 200, actuator?: string) {
    return this.request<EventEntry[]>('GET', `/logs?kind=events&limit=${limit}${actuator ? `&actuator=${actuator}` : ''}`);
  }

  // reports, calibration, users
  waterUsage(days = 7) { return this.request<WaterDay[]>('GET', `/reports/water-usage?days=${days}`); }
  fertilizer(days = 30) { return this.request<FertilizerReport>('GET', `/reports/fertilizer?days=${days}`); }
  calibrations() { return this.request<CalibrationEntry[]>('GET', '/calibration'); }
  calibrate(sensorId: string, body: CalibrationBody) { return this.request<{ constants: Record<string, unknown> }>('POST', `/calibration/${sensorId}`, body); }
  users() { return this.request<UserItem[]>('GET', '/users'); }
  addUser(u: { email: string; name: string; password: string; role: 'admin' | 'viewer' }) { return this.request<UserItem>('POST', '/users', u); }
  patchUser(id: number, patch: Partial<{ name: string; role: 'admin' | 'viewer'; active: boolean; password: string }>) {
    return this.request<UserItem>('PATCH', `/users/${id}`, patch);
  }
  simFault(f: { kind: string; sensor_id?: string; node_id?: string; value?: number; attr?: string }) {
    return this.request<{ ok: boolean }>('POST', '/sim/fault', f);
  }
}
