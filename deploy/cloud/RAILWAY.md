# Cloud server on Railway

Railway is the hosted alternative to the VPS in `compose.yaml`. It runs the same two parts:

* **MySQL**: Railway's own MySQL service, with its own volume.
* **API** (`GH_ROLE=cloud`): built from `controller/Dockerfile`, which also builds the web app.

Caddy is not used. Railway gives the API an HTTPS address (`https://<name>.up.railway.app`) with
its own certificate. The Pi only sends data out to `/sync/ingest`, so nothing has to reach into the
greenhouse network. Nobody commands hardware from the cloud while `remote_commands` is false.

`railway.json` at the repository root tells Railway to build `controller/Dockerfile`, wait for
`/health` before switching to a new deployment, and restart the API if it stops.

## Cost (Railway's published prices, checked 13 Nov 2026)

| Plan | Price | What it gives |
|---|---|---|
| Trial | free | one-time US$5 credit, up to 30 days, 1 GB RAM per service |
| Free (after the trial) | US$0 | US$1 of usage a month, 0.5 GB RAM per service: **not enough** to keep MySQL and the API running all month |
| Hobby | US$5 a month | includes US$5 of usage; a card is billed after use |

Usage is billed by the minute: RAM US$10 per GB per month, CPU US$20 per vCPU per month, volume
US$0.15 per GB per month, egress US$0.05 per GB. MySQL and the API together use roughly 0.5 GB of
RAM, so expect about US$5–7 a month (an estimate; check **Usage** in Railway after a few days).

On the trial, the volume (all cloud data) is deleted 30 days after the credit ends unless the
account is upgraded. The Pi keeps its own copy of everything, so nothing is lost on the greenhouse
side; a new cloud server is filled again by the Pi's next sync.

## Set it up (about 20 minutes)

You need: the repository on GitHub (pushed with GitHub Desktop), a Railway account signed in with
GitHub, and a terminal on the Pi.

1. **Project.** In Railway: **New Project → Deploy from GitHub repo →** choose the repository.
   Railway finds `railway.json` and starts building the API. The first build fails or keeps
   restarting until steps 3 and 4 are done; that is expected.
2. **Region.** Open the API service → **Settings → Region** → **Southeast Asia (Singapore)**.
3. **MySQL.** In the project: **+ Create → Database → MySQL**. Put it in the same region. Leave its
   name as `MySQL` (the variables in step 4 refer to it by that name).
4. **Variables.** Open the API service → **Variables → Raw Editor** and paste the contents of
   `deploy/cloud/railway.env.example`. Then replace the two secrets yourself:
   * `GH_JWT_SECRET`: copy it from the Pi: `sudo grep '^GH_JWT_SECRET=' /etc/greenhouse/greenhouse.env`
   * `GH_SYNC_TOKEN`: make a new one on the Pi: `openssl rand -hex 32`. Keep it open for step 7.

   Do not put these values in chats, documents, commits or photos. Save; Railway redeploys.
5. **Address.** API service → **Settings → Networking → Generate Domain**, port **8000** (the
   `PORT=8000` line in the variables makes the API listen there). Note the address.
6. **Check the server** from the laptop or the Pi (PowerShell: `curl.exe`):

   ```
   curl https://<name>.up.railway.app/health
   ```

   Pass when it answers `"ok": true` and `"role": "cloud"`.
7. **Connect the Pi:**

   ```
   sudo ghctl cloud setup https://<name>.up.railway.app
   sudo ghctl cloud status
   ```

   `setup` asks for the sync token (paste the one from step 4; nothing shows while typing), tests
   it and saves it. Pass when `status` shows health `ok` and a recent last upload (it can take a
   minute or two after setup). The app's **More → Settings → Cloud** should show **Connected**.
   About a minute after the first upload, `/health` on the cloud shows `"controller_online": true`
   (the greenhouse controller's heartbeat travels up with the settings once a minute).

The accounts on the Pi are copied to the cloud with the first sync, so the same sign-ins work
there. No account has to be created on Railway; new accounts are added on the Pi (the cloud
refuses them, so the two never hand out the same account number). Signing out, changing a
password or editing an account on the cloud address does work: the change reaches the Pi with the
next upload, within about a minute.

## Remote monitoring in a browser

The server also serves the web app at its root, so the address from step 5 is the remote
monitoring site:

1. On any computer, open `https://<name>.up.railway.app` and sign in with an account from the Pi.
2. The header shows **Remote** and the time of the last sync. The overview shows the readings, a
   trend chart (6 h to 30 days), the stage, devices, reservoir and open alerts; the side menu opens
   every other page. Controls are visible but disabled ("view only") while `remote_commands` is
   false.
3. Optional: in Chrome or Edge, click **Install** in the address bar (or menu → *Install page as
   app*) to open it in its own window from the desktop or taskbar.

The cloud only has what the Pi has uploaded, and the Pi uploads once a minute, so readings there
can be about a minute old. A new app version goes live with the next Railway deployment; reload
the page to pick it up.

## Phone notifications (Web Push, added 17 Nov 2026)

The cloud server can send phone notifications: one for each new alert (about a minute after the
greenhouse raises it, when the Pi's upload arrives) and one when the controller has not reported
for 5 minutes, then again when it is back. They arrive with the app closed or the screen off. They
work in the web app opened from the Railway address; the Android APK and the Pi's own http address
cannot receive them (App Settings says so and gives the address to use).

**On the server (once):**

1. On the Pi, after `git pull` and `sudo bash ./deploy/pi-setup.sh`:

   ```
   sudo ghctl push keys
   ```

   It prints a new key pair. Copy only the `GH_VAPID_PRIVATE_KEY=…` line. It is a secret: do not
   save it in a file, a chat, a document or a photo.
2. Railway → API service → **Variables → New Variable**: name `GH_VAPID_PRIVATE_KEY`, value the
   key. Save; Railway redeploys. `GH_VAPID_SUBJECT` (a contact for the push services) is
   optional on Railway: it defaults to the service's own https address.
3. Keep the same key for good. Every phone's subscription is tied to it; a new key means every
   phone turns notifications on again.

**On each phone:**

* **Android (Chrome):** open the Railway address, menu → **Install app** (or **Add to Home
  screen**), open it from the home screen, sign in, then **More → App Settings → Notifications**:
  turn on **Notifications on this device**, allow when Chrome asks, choose **All alerts** or
  **Urgent only**, and tap **Send a test**.
* **iPhone or iPad (iOS 16.4 or later):** in Safari, **Share → Add to Home Screen**, open it from
  the Home Screen, sign in, then the same steps.
* A computer works the same way in Chrome or Edge.

Signing out turns notifications off on that device. If the test does not arrive within a minute
on Android, check that notifications for Chrome (or the installed app) are allowed in the phone's
settings and that battery saving is not restricting Chrome.

**Moving to another server (for example Hostinger):** put the same `GH_VAPID_PRIVATE_KEY` in the
new server's `cloud.env`, with `GH_VAPID_SUBJECT` set to its https address. A subscription
belongs to the address it was made on, so each phone opens the new address, installs it and turns
notifications on again there.

## When something goes wrong

| Symptom | Likely cause | What to do |
|---|---|---|
| Build fails at `npm ci` or `npm run build` | `app/package-lock.json` out of date with `package.json` | On the laptop: `cd app`, `npm install`, commit the lock file, push |
| Deploy log: `Can't connect to MySQL` or `Unknown MySQL server host` | MySQL not running yet, or it has another name | Wait for MySQL to show Active; if it was renamed, change `MySQL` in the `${{MySQL.…}}` references |
| Deploy log: `Access denied` | `GH_DATABASE_URL` edited by hand | Paste the line from `railway.env.example` again |
| `/health` works but `cloud setup` says the token is wrong | `GH_SYNC_TOKEN` differs from what was typed on the Pi | Run `sudo ghctl cloud setup …` again with the token in Railway |
| Sign-in on the cloud fails with a valid Pi account | `GH_JWT_SECRET` differs from the Pi's, or the first sync has not run | Copy the secret again (step 4); wait for `cloud status` to show an upload |
| People are signed out of the app well before 14 days | Before 19 Nov 2026: a renewal that failed for lack of a connection signed out; a token from a server whose clock was ahead was refused; and the Pi's upload undid sign-outs and password changes made on the cloud | Fixed 19 Nov 2026. Push, wait for Railway to redeploy, then on the Pi `git pull` and `sudo bash ./deploy/pi-setup.sh`, and rebuild the APK |
| `cloud status` shows **NOT REACHABLE** with *The read operation timed out* soon after setup, while `/health` answers | The first upload carries the Pi's whole backlog, and before 14 Nov 2026 the server saved it one row at a time (4,000 database calls per 2,000 readings), which took longer than the Pi waits | Fixed 14 Nov 2026 (rows saved in bulk, the Pi waits up to 120 s, accounts and settings go first). Push, wait for Railway to redeploy, then on the Pi `git pull` and `sudo bash ./deploy/pi-setup.sh`. Uploads carry on from where they stopped |
| Uploads work, but `/health` on the cloud always shows `"controller_online": false` and the app on the cloud path says *The control service is not reporting* | Before 14 Nov 2026 the cloud only learnt the controller's state over MQTT, which it does not have, so it always said offline (and showed readings as stale) | Fixed 14 Nov 2026 (the heartbeat is uploaded with the settings; the cloud allows two sync intervals of delay). Push, wait for Railway to redeploy, then on the Pi `git pull` and `sudo bash ./deploy/pi-setup.sh`. If it still says false, check `systemctl status greenhouse-control` on the Pi |
| App Settings → Notifications says the server has no notification key | `GH_VAPID_PRIVATE_KEY` not set on the API service | Steps under *Phone notifications* above |
| It says the notification key is not valid | The value was cut short or has extra characters | Paste the `GH_VAPID_PRIVATE_KEY` line again exactly, or make a new key (every phone then turns notifications on again) |
| The switch is greyed out with *blocked for this site* | Notifications were refused when the browser asked | Allow them in the browser's site settings (Android: long-press the installed app → App info → Notifications), then turn the switch on |
| Test says *No device took the test* | The phone unsubscribed or cleared its data | Turn the switch off and on again on that phone |
| Controller raises `CLOUD_UNREACHABLE` | No upload for 30 minutes: Pi offline, or the Railway service stopped (check credit) | Data stays on the Pi and uploads resume by themselves once the server is back |

## Stopping it after the demo

API service → **Settings → Delete Service**, then the same for MySQL (or delete the whole project).
Then on the Pi the controller raises `CLOUD_NOT_CONFIGURED` / `CLOUD_UNREACHABLE` again until a new
server is set with `sudo ghctl cloud setup`.
