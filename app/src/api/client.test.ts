import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, signInRefused } from './client';

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('token renewal', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('signs out only when the server refuses the sign-in', () => {
    expect(signInRefused(new ApiError(401, 'invalid or expired refresh token'))).toBe(true);
    expect(signInRefused(new ApiError(401, 'session revoked'))).toBe(true);
    expect(signInRefused(new ApiError(403, 'administrator only'))).toBe(true);
    expect(signInRefused(new ApiError(0, 'Cannot reach the controller.'))).toBe(false);
    expect(signInRefused(new ApiError(502, 'Bad Gateway'))).toBe(false);
    expect(signInRefused(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('retries with the new token after a renewal', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(res(401, { detail: 'invalid or expired token' }))
      .mockResolvedValueOnce(res(200, { name: 'MAgSO' }));
    vi.stubGlobal('fetch', fetch);
    let token = 'old';
    const c = new ApiClient('http://pi:8000', { access: () => token, refresh: async () => (token = 'new') });
    await expect(c.meta()).resolves.toMatchObject({ name: 'MAgSO' });
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer new');
  });

  it('reports the lost connection, not an expired token, when the renewal cannot reach the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(res(401, { detail: 'invalid or expired token' })));
    const c = new ApiClient('http://pi:8000', {
      access: () => 'old',
      refresh: async () => { throw new ApiError(0, 'Cannot reach the controller.'); },
    });
    await expect(c.meta()).rejects.toMatchObject({ status: 0, message: 'Cannot reach the controller.' });
  });

  it('signs out this device, or every device when asked', async () => {
    const fetch = vi.fn().mockImplementation(async () => res(200, { ok: true }));
    vi.stubGlobal('fetch', fetch);
    const c = new ApiClient('http://pi:8000', { access: () => 't', refresh: async () => null });
    await c.logout();
    await c.logout(true);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ everywhere: false });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ everywhere: true });
  });
});
