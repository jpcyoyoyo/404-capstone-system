import React from 'react';
import { render } from '@testing-library/react';
import App from './App';

test('renders without crashing', async () => {
  const { baseElement, unmount } = render(<App />);
  expect(baseElement).toBeDefined();
  // <ion-app> finishes its start-up (tap click, keyboard assist, back button) on a 32 ms timer
  // followed by lazy imports. Let that settle before jsdom is torn down, or it fails afterwards
  // with "window is not defined" on a cold cache (as in CI).
  await new Promise((r) => setTimeout(r, 2000));
  unmount();
}, 10000);
