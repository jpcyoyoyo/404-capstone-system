import { useCallback, useEffect, useRef, useState } from 'react';
import { useIonToast } from '@ionic/react';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import type { CommandInput } from '../providers/types';
import type { Ack } from '../contract/types';
import { commandError, commandRefusal, reasonText } from '../contract/codes';
import { ApiError } from '../api/client';
import { hapticResult, hapticTap } from './haptics';

/** The controller's last answer for one device, shown for a moment next to its buttons. */
export interface CommandResult { id: string; kind: 'ok' | 'sim' | 'no'; label: string }

/** Sends a command, tracks which device is busy, and shows the controller's answer as a toast.
 *  A refusal names the device, says what did not happen and why, and when to try again.
 *  `result` holds the last answer for 1.6 s so the device's buttons can show it (`feedback(id)`),
 *  and the Android app vibrates on send and on the answer. */
export function useCommand() {
  const gh = useGreenhouse();
  const { isAdmin } = useAuth();
  const [toast] = useIonToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((r: CommandResult) => {
    clearTimeout(timer.current);
    setResult(r);
    timer.current = setTimeout(() => setResult(null), 1600);
  }, []);

  const blocked: string | null = !isAdmin ? 'Your account can view but not control.'
    : !gh.canCommand ? (gh.link === 'remote' ? reasonText('REMOTE_READ_ONLY')
      : gh.link === 'local' && !gh.controllerOnline ? 'The control service is not running, so commands cannot be carried out.'
      : 'Not connected to the controller.')
    : null;

  const send = useCallback(async (c: CommandInput, okText?: string): Promise<Ack | null> => {
    if (blocked) { toast({ message: blocked, duration: 2500, color: 'medium' }); return null; }
    const name = c.actuator_id === 'all' ? 'Emergency stop'
      : gh.meta.actuators.find(a => a.id === c.actuator_id)?.name ?? c.actuator_id;
    setBusy(c.actuator_id);
    hapticTap();
    try {
      const ack = await gh.sendCommand(c);
      const ok = ack.status === 'ACCEPTED' || ack.status === 'SIMULATED';
      hapticResult(ok ? 'ok' : 'refused');
      show(ok ? { id: c.actuator_id, kind: ack.status === 'SIMULATED' ? 'sim' : 'ok', label: ack.status === 'SIMULATED' ? 'Simulated' : 'Accepted' }
        : { id: c.actuator_id, kind: 'no', label: 'Refused' });
      if (ok) {
        toast({ message: `${ack.status === 'SIMULATED' ? 'SIMULATED — ' : ''}${ack.message || okText || 'Done.'}`, duration: 2500,
          color: ack.status === 'SIMULATED' ? 'warning' : 'success', position: 'top' });
      } else {
        const r = commandRefusal(ack.reason, ack.message, name, c.actuator_id === 'all' ? 'ESTOP' : c.action);
        toast({ header: r.title, message: r.text, duration: 6000, color: 'danger', position: 'top',
          buttons: [{ text: 'OK', role: 'cancel' }] });
      }
      return ack;
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined;
      hapticResult('error');
      show({ id: c.actuator_id, kind: 'no', label: 'Not sent' });
      toast({ header: `${name}: command not sent`, message: commandError(status, e instanceof Error ? e.message : 'Command failed.'),
        duration: 6000, color: 'danger', position: 'top', buttons: [{ text: 'OK', role: 'cancel' }] });
      return null;
    } finally {
      setBusy(null);
    }
  }, [blocked, gh, toast, show]);

  /** Class for a device's button row: a green ring when accepted, a shake when refused. */
  const feedback = useCallback((id: string): string =>
    result?.id !== id ? '' : result.kind === 'no' ? 'sg-cmd-no' : 'sg-cmd-ok', [result]);

  return { send, busy, blocked, result, feedback };
}
