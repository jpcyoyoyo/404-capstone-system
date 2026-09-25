import React from 'react';
import {
  IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel, IonRouterOutlet, IonBadge,
} from '@ionic/react';
import { Route, Redirect } from 'react-router-dom';
import {
  gridOutline, pulseOutline, optionsOutline, waterOutline, ellipsisHorizontalOutline,
} from 'ionicons/icons';

import Dashboard    from './Dashboard';
import LiveMonitor  from './LiveMonitor';
import MetricDetail from './MetricDetail';
import Schedules    from './Schedules';
import Records      from './Records';
import Alerts       from './Alerts';
import AlertDetail  from './AlertDetail';
import Controls     from './Controls';
import Fertigation  from './Fertigation';
import Energy       from './Energy';
import Settings     from './Settings';
import Profile      from './Profile';
import AppSettings  from './AppSettings';
import More         from './More';
import Calibration  from './Calibration';
import { useGreenhouse } from '../providers/GreenhouseProvider';

const MainTabs: React.FC = () => {
  const { unackedCount } = useGreenhouse();

  return (
    <IonTabs>
      <IonRouterOutlet>
        <Route exact path="/tabs/dashboard"              component={Dashboard} />
        <Route exact path="/tabs/live-monitor"           component={LiveMonitor} />
        <Route exact path="/tabs/live-monitor/metric/:id" component={MetricDetail} />
        <Route exact path="/tabs/schedules"              component={Schedules} />
        <Route exact path="/tabs/records"                component={Records} />
        <Route exact path="/tabs/alerts"                 component={Alerts} />
        <Route exact path="/tabs/alert-detail/:id"       component={AlertDetail} />
        <Route exact path="/tabs/controls"               component={Controls} />
        <Route exact path="/tabs/fertigation"            component={Fertigation} />
        <Route exact path="/tabs/energy"                 component={Energy} />
        <Route exact path="/tabs/calibration"            component={Calibration} />
        <Route exact path="/tabs/settings"               component={Settings} />
        <Route exact path="/tabs/profile"               component={Profile} />
        <Route exact path="/tabs/app-settings"          component={AppSettings} />
        <Route exact path="/tabs/more"                  component={More} />
        <Route exact path="/tabs">
          <Redirect to="/tabs/dashboard" />
        </Route>
      </IonRouterOutlet>

      <IonTabBar slot="bottom">
        <IonTabButton tab="dashboard" href="/tabs/dashboard">
          <IonIcon icon={gridOutline} />
          <IonLabel>Home</IonLabel>
        </IonTabButton>

        <IonTabButton tab="live-monitor" href="/tabs/live-monitor">
          <IonIcon icon={pulseOutline} />
          <IonLabel>Live</IonLabel>
        </IonTabButton>

        <IonTabButton tab="controls" href="/tabs/controls">
          <IonIcon icon={optionsOutline} />
          <IonLabel>Control</IonLabel>
        </IonTabButton>

        <IonTabButton tab="fertigation" href="/tabs/fertigation">
          <IonIcon icon={waterOutline} />
          <IonLabel>Nutrients</IonLabel>
        </IonTabButton>

        <IonTabButton tab="more" href="/tabs/more">
          <IonIcon icon={ellipsisHorizontalOutline} />
          <IonLabel>More</IonLabel>
          {unackedCount > 0 && <IonBadge color="danger">{unackedCount}</IonBadge>}
        </IonTabButton>
      </IonTabBar>
    </IonTabs>
  );
};

export default MainTabs;
