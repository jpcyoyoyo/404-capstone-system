import React, { ReactNode } from 'react';
import { useConnection } from '../contexts/ConnectionContext';
import { DemoProvider } from './DemoProvider';
import { LiveProvider } from './LiveProvider';

/** Mounts the live controller provider or the labelled demo provider, per Connection settings. */
export const GreenhouseProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { mode } = useConnection();
  return mode === 'demo'
    ? <DemoProvider key="demo">{children}</DemoProvider>
    : <LiveProvider key="live">{children}</LiveProvider>;
};

export { useGreenhouse } from './context';
