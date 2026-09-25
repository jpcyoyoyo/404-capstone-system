import { createContext, useContext } from 'react';
import type { GreenhouseData } from './types';

export const GreenhouseContext = createContext<GreenhouseData | null>(null);

export const useGreenhouse = (): GreenhouseData => {
  const ctx = useContext(GreenhouseContext);
  if (!ctx) throw new Error('useGreenhouse() must be used within a GreenhouseProvider');
  return ctx;
};
