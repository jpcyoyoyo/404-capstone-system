import { useCallback, useState } from 'react';
import { useIonToast } from '@ionic/react';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import type { CommandInput } from '../providers/types';
import type { Ack } from '../contract/types';
import { reasonText } from '../contract/codes';

/** Sends a command, tracks which device is busy, and shows the controller's answer as a toast. */
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
    setBusy(c.actuator_id);
    try {
      const ack = await gh.sendCommand(c);
      const ok = ack.status === 'ACCEPTED' || ack.status === 'SIMULATED';
      const msg = ok
        ? `${ack.status === 'SIMULATED' ? 'SIMULATED — ' : ''}${ack.message || okText || 'Done.'}`
        : `${ack.status === 'EXPIRED' ? 'Not confirmed' : 'Refused'}: ${reasonText(ack.reason, ack.message)}`;
      toast({ message: msg, duration: ok ? 2500 : 4500, color: ok ? (ack.status === 'SIMULATED' ? 'warning' : 'success') : 'danger', position: 'top' });
      return ack;
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : 'Command failed.', duration: 4000, color: 'danger', position: 'top' });
      return null;
    } finally {
      setBusy(null);
    }
  }, [blocked, gh, toast]);

  return { send, busy, blocked };
}
