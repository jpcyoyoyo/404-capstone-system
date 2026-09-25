import { Redirect, Route } from 'react-router-dom';
import { IonApp, IonRouterOutlet, setupIonicReact } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import Login      from './pages/Login';
import MainTabs   from './pages/MainTabs';
import QuickSetup from './pages/QuickSetup';
import Kiosk      from './pages/Kiosk';
import { AppSettingsProvider } from './contexts/AppSettingsContext';
import { ConnectionProvider } from './contexts/ConnectionContext';
import { AuthProvider } from './contexts/AuthContext';
import { GreenhouseProvider } from './providers/GreenhouseProvider';
import PrivateRoute from './components/PrivateRoute';

/* Core CSS required for Ionic components to work properly */
import '@ionic/react/css/core.css';

/* Basic CSS for apps built with Ionic */
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';

/* Optional CSS utils */
import '@ionic/react/css/padding.css';
import '@ionic/react/css/float-elements.css';
import '@ionic/react/css/text-alignment.css';
import '@ionic/react/css/text-transformation.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/display.css';

/* Theme variables + SmartGreenhouse global design system.
   Light is the default palette; dark is applied via the .ion-palette-dark
   class on <html>, toggled at runtime by AppSettingsProvider. */
import './theme/fonts.css';
import './theme/variables.css';
import './theme/global.css';

setupIonicReact();

// Provider order: settings → which backend (live/demo, which address) → who is signed in →
// the data provider for that backend. The kiosk route brings its own read-only live provider.
const App: React.FC = () => (
  <AppSettingsProvider>
  <ConnectionProvider>
  <AuthProvider>
  <GreenhouseProvider>
  <IonApp>
    <IonReactRouter>
      <IonRouterOutlet>
        <Route exact path="/login"       component={Login} />
        <Route exact path="/quick-setup" component={QuickSetup} />
        <Route exact path="/kiosk"       component={Kiosk} />
        <PrivateRoute path="/tabs"       component={MainTabs} />
        <Route exact path="/">
          <Redirect to="/login" />
        </Route>
      </IonRouterOutlet>
    </IonReactRouter>
  </IonApp>
  </GreenhouseProvider>
  </AuthProvider>
  </ConnectionProvider>
  </AppSettingsProvider>
);

export default App;
