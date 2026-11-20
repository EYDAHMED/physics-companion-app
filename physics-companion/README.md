# Physics — Daily Companion

A local-first React + Vite PWA for daily tasks, focus timers, prayer-time reminders, bilingual UI, and a voice-enabled assistant. It can run without Firebase; Firebase sync is optional.

## Requirements

- Node.js 20.19+ or 22.12+
- npm
- A modern browser (Chrome/Edge recommended for speech recognition)

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open the local URL printed by Vite. Production build:

```bash
npm run build
npm run preview
```

The output is written to `dist/`.

## Firebase setup

1. Create a project at [Firebase Console](https://console.firebase.google.com/).
2. Add a Web app and copy its Firebase config into `.env`:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
3. In Firebase Authentication, enable **Anonymous** sign-in.
4. Create a Firestore database.
5. Example Firestore rules (adjust before production; this app uses anonymous UID documents):

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /physicsUsers/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

6. Run `npm install` again if needed, then `npm run build`.
7. The app stores state in browser localStorage first. When Firebase is configured, use Settings → Connect Firebase to enable per-anonymous-user Firestore sync. Treat anonymous auth as browser/device identity, not a recoverable account. Add account linking and conflict-resolution logic before using this as a multi-device production account system.

## AI endpoint and API-key safety

The app embeds the Physics system prompt and sends the selected language, profile, today's tasks, prayer times, and previous-day summary to `VITE_AI_API_URL` when configured. The endpoint should be a trusted server or Firebase Cloud Function that authenticates requests, validates payloads, calls your chosen AI provider, and returns JSON such as:

```json
{ "text": "Your answer", "action": null }
```

Optional structured actions currently supported by the UI:

```json
{ "text": "Starting a timer.", "action": { "type": "timer", "minutes": 45 } }
{ "text": "Task completed.", "action": { "type": "complete", "id": "task-id" } }
{ "text": "Task added.", "action": { "type": "add", "title": "Read chapter 2" } }
```

**Never place a real private AI API key in a `VITE_*` variable.** Vite embeds client variables in public JavaScript. `VITE_AI_API_KEY` is included only as a requested placeholder and is intentionally not used by the client. Keep provider secrets in server-side environment configuration.

If no AI endpoint is configured, Physics uses a small local command assistant for common actions; it is not a general-purpose LLM.

## Prayer times, notifications, and location

Prayer times are fetched from the AlAdhan public API using the city in Settings (default: Hurghada, Egypt). The app does not silently request precise location. Enter a city manually; a future location picker can request browser geolocation with explicit consent. Verify the calculation method and local authority's timetable for your area.

Browser notifications require permission and generally work only while the browser/PWA is allowed to run. This app checks prayer times while the page is active; it does not guarantee alarms when the browser is suspended or the device is powered off.

## Voice and PWA limitations

- Push-to-talk uses the browser Web Speech API where available.
- Speech recognition support and Arabic dialect quality vary by browser and operating system.
- A reliable always-on wake phrase ("Hey Physics") is **not** implemented. Browsers do not provide a dependable background wake-word API for ordinary PWAs.
- A PWA cannot guarantee microphone listening, audio playback, timers, or notifications while the phone is locked or the app is suspended. Wake Lock can prevent screen dimming only while a page is active and supported; it does not enable background execution. Media Session is useful for media controls but does not turn a web app into a background voice service.
- For dependable locked-screen alarms or wake-word detection, build a native Android/iOS companion with platform-approved background services and explicit user permissions.

## GitHub + Firebase Hosting deployment

1. Update `.firebaserc` and the workflow's `projectId` from `YOUR_FIREBASE_PROJECT_ID` to your Firebase project ID.
2. In Firebase Console → Project settings → Service accounts, generate a deployment service-account JSON.
3. In GitHub repository → Settings → Secrets and variables → Actions, add:
   - `FIREBASE_SERVICE_ACCOUNT`: the full JSON contents of the service-account key.
4. Push the project to GitHub's `main` branch. The workflow installs dependencies, builds `dist/`, and deploys to Firebase Hosting.
5. For local manual deployment, install Firebase CLI and run:

```bash
npm install -g firebase-tools
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
npm run build
firebase deploy --only hosting
```

## Before production

- Add a real AI backend with authentication, rate limiting, input validation, and abuse controls.
- Add Firebase App Check, account recovery/linking, data export/deletion, and explicit privacy/retention disclosures.
- Use server-side scheduled notifications or native push/alarm support if reminders must fire when the app is closed.
- Add automated tests, error monitoring, and robust multi-device conflict resolution.
- Review Firestore rules and API quotas for your deployment.
