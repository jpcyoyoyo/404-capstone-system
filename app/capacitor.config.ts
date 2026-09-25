import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ph.edu.slsu.smartgreenhouse',
  appName: 'SmartGreenhouse',
  webDir: 'dist',
  server: {
    // The controller serves plain HTTP on the greenhouse network (http://<pi>:8000, ws://<pi>:9001).
    // Serving the app itself over http avoids mixed-content blocking, and cleartext allows the calls.
    androidScheme: 'http',
    cleartext: true,
  },
};

export default config;
