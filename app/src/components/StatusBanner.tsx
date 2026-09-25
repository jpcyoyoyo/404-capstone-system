import React from 'react';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { timeAgo } from './format';

/** One line under the header that says when the data is not live (demo, offline, controller down). */
const StatusBanner: React.FC = () => {
  const gh = useGreenhouse();
  if (gh.mode === 'demo') {
    return (
      <div className="sg-banner-warn" style={{ marginBottom: 12 }}>
        <span style={{ fontWeight: 700 }}>DEMO MODE</span> · simulated data — commands never reach the greenhouse.
      </div>
    );
  }
  if (gh.link === 'offline' || !gh.ready) {
    return (
      <div className="sg-banner-offline" style={{ marginBottom: 12 }}>
        {gh.ready ? `Offline — last known values from ${timeAgo(gh.lastUpdate)}. Controls are disabled.` : 'Connecting to the controller…'}
      </div>
    );
  }
  if (gh.error && !gh.controllerOnline) {
    return (
      <div className="sg-banner-offline" style={{ marginBottom: 12 }}>
        Controller not answering ({gh.error}). Showing values from {timeAgo(gh.lastUpdate)}; controls are disabled.
      </div>
    );
  }
  if (!gh.controllerOnline) {
    return (
      <div className="sg-banner-crit" style={{ marginBottom: 12 }}>
        The control service is not reporting. Readings may be stale; automatic control may be stopped.
      </div>
    );
  }
  if (gh.link === 'remote') {
    return (
      <div className="sg-banner-warn" style={{ marginBottom: 12 }}>
        Remote view via the cloud — data may lag a few minutes{gh.canCommand ? '' : '; controls work only on the greenhouse network'}.
      </div>
    );
  }
  return null;
};

export default StatusBanner;
