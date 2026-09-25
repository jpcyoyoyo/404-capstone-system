# SmartGreenhouse app

Ionic React + Capacitor. See [`CLAUDE.md`](CLAUDE.md) for how the app is put together and
[`../README.md`](../README.md) for running it with the controller. This README covers building
the Android APK. On the Pi the app is served by the controller itself (browser and `/kiosk`),
so there is no separate desktop build.

## Prerequisites

- **Node.js 22 LTS** — `@capacitor/cli@8` requires Node **>= 22.0.0** (confirmed via
  `npm view @capacitor/cli engines`); older LTS releases like Node 20 will fail.
- **Android Studio** (a recent version — this project targets `compileSdk`/`targetSdk` 36 via
  `android/variables.gradle`, so use a current Android Studio release; older versions may not
  bundle a compatible Android Gradle Plugin/JDK and will prompt you to update).
- Android Studio's bundled **JDK** and **Android SDK Platform 36** — if missing, Android Studio's
  first Gradle sync will prompt you to install them via the SDK Manager.
- A physical Android device with **USB debugging** enabled, or an Android Studio emulator, for
  installing/testing the APK.

## 1. Install dependencies

```bash
npm ci
```

## 2. Build the web app and sync it into the Android project

The native `android/` folder is generated, not kept in the repository. On a fresh clone create it
once (after the first `npm run build`):

```bash
npm run build
npx cap add android
```

Then, and after every change:

```bash
npm run android:sync
```

This runs `npm run build` (TypeScript check + Vite production build → `dist/`), then
`npx cap sync android`, which copies `dist/` into `android/app/src/main/assets/public` and
updates the native Capacitor/Gradle dependencies to match `package.json`.

**Re-run this command after every change to `src/`** — Android Studio only sees whatever was last
synced into `android/`, not your live source files.

## 3. Open the project in Android Studio

```bash
npm run android:open
```

(equivalent to `npx cap open android`, or just open the `android/` folder directly from Android
Studio's "Open" dialog). Let Gradle finish syncing — the first sync on a new machine can take a
few minutes and may prompt to download missing SDK components.

## 4. Generate an APK

**Debug APK** (unsigned, fastest — good for testing on your own device):

1. In Android Studio: **Build → Build App Bundle(s) / APK(s) → Build APK(s)**.
2. Once it finishes, click the **"locate"** link in the notification, or find it at:
   `android/app/build/outputs/apk/debug/app-debug.apk`.

**Signed release APK** (required for distributing outside your own test devices):

1. **Build → Generate Signed Bundle / APK…**
2. Choose **APK**, then **Create new…** under Key store path (first time) to generate a keystore,
   or select an existing one. **Keep the keystore file and its passwords safe and back them up** —
   losing it means you can never publish an update under the same app identity again.
3. Select the **release** build variant and finish. Output lands at:
   `android/app/build/outputs/apk/release/app-release.apk`.

**Fastest path to a device for testing:** instead of building an APK file first, connect your
device via USB (with USB debugging enabled) or start an emulator, then click Android Studio's
green **Run ▶** button — it builds, installs, and launches the app on the selected device in one
step.

## 5. Install the APK manually (optional)

If you built an APK file directly rather than using Run ▶:

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

or transfer the `.apk` file to the device and open it (the device must allow installs from the
source you use — sideloading from a file manager, browser download, etc.).

## Notes

- `capacitor.config.ts`'s `appId` is still the generic Capacitor starter value (`io.ionic.starter`)
  and `android/variables.gradle` reflects the Gradle project as originally scaffolded. Renaming the
  app identifier for a real release means updating `capacitor.config.ts` **and** the Android
  project's `applicationId`/package structure in `android/app/build.gradle` and Java source dirs —
  do this deliberately as its own step if/when you're ready to ship under a real identity; it's not
  required just to build and test APKs.
- There is no backend — the app is fully self-contained (see `src/simulation/SimulationContext.tsx`),
  so a built APK works the same on-device as it does in the dev server, no server/network setup
  needed.
