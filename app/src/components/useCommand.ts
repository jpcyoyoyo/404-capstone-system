import { useCallback, useState } from 'react';
import { useIonToast } from '@ionic/react';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import type { CommandInput } from '../providers/types';
import type { Ack } from '../contract/types';
import { commandError, commandRefusal, reasonText } from '../contract/codes';
import { ApiError } from '../api/client';

/** Sends a command, tracks which device is busy, and shows the controller's answer as a toast.
 *  A refusal names the device, says what did not happen and why, and when to try again. */
export function useCommand() {
  const gh = useGreenhouse();
  const { isAdmin } = useAuth();
  const [toast] = useIonToast();
  const [busy, setBusy] = useState<string | null>(null);

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
    try {
      const ack = await gh.sendCommand(c);
      const ok = ack.status === 'ACCEPTED' || ack.status === 'SIMULATED';
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
      toast({ header: `${name}: command not sent`, message: commandError(status, e instanceof Error ? e.message : 'Command failed.'),
        duration: 6000, color: 'danger', position: 'top', buttons: [{ text: 'OK', role: 'cancel' }] });
      return null;
    } finally {
      setBusy(null);
    }
  }, [blocked, gh, toast]);

  return { send, busy, blocked };
}
