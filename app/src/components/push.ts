/**
 * Web Push in the browser (the server side is controller/greenhouse/push.py).
 *
 * Works only in a browser on a secure (https) address, i.e. the web app opened from the cloud
 * server, installed or not; on an iPhone only once it is added to the Home Screen. The Android APK
 * (no Web Push in its WebView) and the Pi's own http address cannot receive it, and say so.
 */
import { Capacitor } from '@capacitor/core';
import type { ApiClient } from '../api/client';

export type PushLevel = 'all' | 'urgent';

export type PushBlocker = 'native' | 'insecure' | 'ios-home-screen' | 'unsupported';

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function standalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch { return false; }
}

/** Why this device cannot take notifications, or null when it can. */
export function pushBlocker(): PushBlocker | null {
  try { if (Capacitor.isNativePlatform()) return 'native'; } catch { /* web */ }
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  const hasApi = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !standalone()) return 'ios-home-screen';
  return hasApi ? null : 'unsupported';
}

export function permission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** A short name for this browser, so the server's list says which device is which. */
export function deviceLabel(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function keyBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b64url: string): boolean {
  if (!a) return false;
  const x = new Uint8Array(a), y = keyBytes(b64url);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushBlocker()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

export class PushError extends Error {
  constructor(public kind: 'denied' | 'server' | 'browser', message: string) { super(message); }
}

/**
 * Turn notifications on for this browser. Call it straight from the tap: the permission prompt has
 * to come from the person's own action, so it is asked before anything goes over the network.
 */
export async function enablePush(api: ApiClient, level: PushLevel): Promise<void> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new PushError('denied', 'Notifications are blocked for this site. Allow them in the browser\'s site settings, then turn this on again.');
  }
  const cfg = await api.pushConfig();
  if (!cfg.available || !cfg.public_key) throw new PushError('server', cfg.reason || 'This server does not send notifications.');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server's key (an old address) only takes that server's messages.
  if (sub && !sameKey(sub.options.applicationServerKey, cfg.public_key)) {
    await sub.unsubscribe();
    sub = null;
  }
  try {
    sub = sub ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.public_key) as BufferSource });
  } catch (e) {
    throw new PushError('browser', `The browser could not set up notifications (${e instanceof Error ? e.message : String(e)}).`);
  }
  await api.pushSubscribe(sub.toJSON(), level, deviceLabel());
}

/** Turn them off for this browser (also on sign-out). Never throws. */
export async function disablePush(api: ApiClient | null): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (!sub) return;
    if (api) await api.pushUnsubscribe(sub.endpoint).catch(() => { /* offline: the server drops it when it bounces */ });
    await sub.unsubscribe();
  } catch { /* nothing to undo */ }
}

/** Whether this browser is on, and at which level, as the server sees it. */
export async function pushStatus(api: ApiClient): Promise<{ on: boolean; level: PushLevel | null }> {
  const sub = await currentSubscription();
  if (!sub || permission() !== 'granted') return { on: false, level: null };
  const r = await api.pushCheck(sub.endpoint);
  return { on: r.registered, level: r.level };
}
