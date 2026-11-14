import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/** Vibration feedback on the Android app only (a browser or the kiosk gets none).
 *  Never throws: a phone without a vibration motor just stays quiet. */
const native = (): boolean => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

/** Light tap when a command is sent. */
export function hapticTap(): void {
  if (native()) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}

/** Controller's answer: accepted, refused, or not sent at all. */
export function hapticResult(kind: 'ok' | 'refused' | 'error'): void {
  if (!native()) return;
  const type = kind === 'ok' ? NotificationType.Success : kind === 'refused' ? NotificationType.Warning : NotificationType.Error;
  Haptics.notification({ type }).catch(() => {});
}
