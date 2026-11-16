import { describe, expect, it, vi, afterEach } from 'vitest';
import { deviceLabel, keyBytes, pushBlocker } from './push';

describe('push helpers', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('names the browser and system', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-A146P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'))
      .toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'))
      .toBe('Edge on Windows');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'))
      .toBe('Safari on iPhone/iPad');
  });

  it('decodes the server key as the 65-byte point browsers expect', () => {
    // base64url of 0x04 followed by 64 bytes of 0x01
    const key = 'BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
    const b = keyBytes(key);
    expect(b.length).toBe(65);
    expect(b[0]).toBe(4);
    expect(b[64]).toBe(1);
  });

  it('says why a plain http address cannot take notifications', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(pushBlocker()).toBe('insecure');
  });

  it('asks iPhone users to add the app to the Home Screen first', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1');
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    expect(pushBlocker()).toBe('ios-home-screen');
  });
});
