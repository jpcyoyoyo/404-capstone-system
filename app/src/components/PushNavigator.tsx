/**
 * Tapping a notification while the app is open brings the window forward and the service worker
 * (public/sw.js) posts the page to open; this moves the app there without reloading it.
 */
import { useEffect } from 'react';
import { useHistory } from 'react-router-dom';

const PushNavigator: React.FC = () => {
  const history = useHistory();
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; path?: string } | null;
      if (d?.type === 'sg-open' && typeof d.path === 'string' && d.path.startsWith('/')) history.push(d.path);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [history]);
  return null;
};

export default PushNavigator;
