# DecuGuard: pressure-injury prevention & bed-exit monitor

Web dashboard (Firebase Hosting + Realtime Database) fed by an ESP-12E bedside unit.

```
decuguard/
  public/            web app (deployed)
    index.html
    css/styles.css
    js/app.js        dashboard logic
    js/config.js     your Firebase config + device id
  firmware/esp12e_bedside_unit.ino
  database.rules.json
  firebase.json  .firebaserc
```

## 1. Firebase project (once)
1. console.firebase.google.com -> Add project.
2. Build -> **Realtime Database** -> Create database.
3. Build -> **Authentication** -> Sign-in method -> enable **Anonymous**.
4. Project settings -> Your apps -> add a **Web app** -> copy `firebaseConfig`.

## 2. Deploy
```bash
npm install -g firebase-tools
firebase login
# edit .firebaserc and put your project id
# edit public/js/config.js and paste firebaseConfig (or enter it later in the app)
firebase deploy            # publishes hosting + database rules
```
Open the printed `https://<project>.web.app` URL.

Test locally (modules need http, not file://):
```bash
firebase emulators:start --only hosting     # or: cd public && python3 -m http.server 8080
```

## 3. ESP-12E
Open `firmware/esp12e_bedside_unit.ino`, set WiFi, `API_KEY`, `DB_URL`, `DEVICE_ID`, install the libraries
listed in its header, wire per the comment, upload. The dashboard turns "Live" within seconds.

## Data layout (`devices/<DEVICE_ID>/`)
| Path | Written by | Content |
|---|---|---|
| `latest` | ESP-12E (every 2 s) | pressure %, edge cm, PIR, rssi, uptime |
| `history/0..239` | ESP-12E (every 30 s) | 2-hour ring buffer for trend charts |
| `cmd` | web app | speaker/buzzer/volume commands |
| `settings` | web app | turn interval, edge distance, FSR full-scale |
| `alerts`, `acks`, `lastTurn` | web app | alert log and acknowledgements |

## Before real patient use
Rules allow any signed-in (anonymous) user. Restrict them (Email/Google sign-in + per-user paths) and
calibrate every FSR with known weights. This is a prototype, not a certified medical device.
