import React from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { checkmarkCircle, closeCircle, flaskOutline } from 'ionicons/icons';
import type { CommandResult } from './useCommand';

/** "Sending…" while a device's command is on its way. */
export const Sending: React.FC = () => (
  <span className="sg-sending" role="status"><IonSpinner name="crescent" />Sending…</span>
);

/** The controller's answer for `id`, popped in beside its buttons for a moment. */
export const CommandBadge: React.FC<{ id: string; result: CommandResult | null }> = ({ id, result }) => {
  if (!result || result.id !== id) return null;
  const icon = result.kind === 'no' ? closeCircle : result.kind === 'sim' ? flaskOutline : checkmarkCircle;
  return (
    <span className={`sg-cmd-badge ${result.kind}`} role="status">
      <IonIcon icon={icon} style={{ fontSize: 13 }} />{result.label}
    </span>
  );
};
