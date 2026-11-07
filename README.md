# VaxReach server-backed prototype

This project adds a Node.js server and PostgreSQL database to the VaxReach website. The connected workflow covers account sign-in, admin-created accounts, child and household records, administrator-entered dose schedules, offline vaccination drafts, server sync, review decisions, and an audit trail.

The other prototype areas (case management, camps, SMS/IVR, U-WIN, maps, reports, and help assistant) are still demo features. They are not stored in PostgreSQL. The production-mode navigation hides these areas.

## Run the local demo

With Node.js 24 or newer installed, open PowerShell in this project folder and run:

```powershell
npm install
npm run start:local
```

The startup command prints the website address; it uses [http://localhost:3000](http://localhost:3000) when that port is free and automatically selects the next free port otherwise. It starts a project-local UTF-8 PostgreSQL database, applies the schema, seeds fictional demo accounts, and starts the website. The database files stay under `data/local-postgres-utf8` after you stop the app. Press Ctrl+C to stop both services. Docker Compose remains available as an alternative with `docker compose up --build`.

Demo sign-ins:

| Role | Email | Password |
| --- | --- | --- |
| Administrator | `admin@vaxreach.demo` | `admin123` |
| Health worker | `worker@vaxreach.demo` | `worker123` |
| Child / family | `child@vaxreach.demo` | `child123` |

Use the Administrator account to create accounts, add child records, add dose entries, and review worker submissions. Enter dose schedules from an approved source supplied by the relevant health authority. VaxReach does not calculate a clinical schedule.

## How the connected workflow works

1. An administrator creates a health-worker account and enters child, household, and schedule data.
2. A worker signs in and records vaccination details only in **Offline drafts**.
3. If the worker has no connection, the draft is saved in the browser's IndexedDB outbox and remains marked as waiting to sync.
4. When the connection returns while VaxReach is open, the app uploads the draft to PostgreSQL. The admin sees it in **Vaccination review**.
5. The administrator approves or requests changes. Only approval changes the official schedule row in PostgreSQL.

The service worker caches the app shell. It does not cache personal API responses. A worker must sign in online at least once on the same browser/device, and the browser's site data must remain available until drafts have synced. The offline queue is stored on that device and is not encrypted by this app.

## PostgreSQL and server

The server requires Node.js 24 or newer and PostgreSQL. Docker Compose is the simplest local setup and is configured for **fictional demo data only**. Its database password and session secret are development values; never expose that compose setup to the public internet.

For a non-demo environment:

1. Create a PostgreSQL database and set `DATABASE_URL` and a random `SESSION_SECRET` of at least 32 characters.
2. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, and `DEMO_MODE=false` behind HTTPS. Set `TRUST_PROXY=true` only when the app is behind a trusted HTTPS proxy.
3. Install packages with `npm ci --omit=dev` and create the schema with `npm run db:migrate`.
4. Create the first administrator using environment values, then remove them from the shell:

```powershell
$env:INITIAL_ADMIN_NAME = 'VaxReach Administrator'
$env:INITIAL_ADMIN_EMAIL = 'admin@example.org'
$env:INITIAL_ADMIN_PASSWORD = Read-Host 'Enter a 12+ character administrator password'
npm run db:create-admin
Remove-Item Env:INITIAL_ADMIN_NAME, Env:INITIAL_ADMIN_EMAIL, Env:INITIAL_ADMIN_PASSWORD
```

5. Start the service with `npm start` and expose it only through HTTPS.

Do not run `npm run db:seed` in a real environment; it inserts fictional demo accounts and records. The application does not provision cloud hosting, backups, monitoring, or a managed database. Those must be configured for the chosen hosting provider.

## Data and safety boundaries

- Do not enter real patient information until your organisation has approved the hosting, privacy controls, retention rules, access policy, device security, and clinical workflow.
- Offline drafts are kept in the browser's local database and local storage. Shared-device access, device loss, and browser-data deletion need an operational policy.
- Vaccination schedules must be supplied and validated by authorised health staff. Admin-entered doses are labeled as requiring validation.
- Demo certificates are not official. In server mode, official certificate generation is disabled.
- SMS, IVR, U-WIN integration, and cloud hosting are not configured by this project.

## Main files

- `index.html` — website UI
- `server/src/server.js` — API and server-side permission checks
- `server/db/schema.sql` — PostgreSQL tables and indexes
- `server/scripts/` — migration, demo data, and initial administrator setup
- `public/vaxreach-runtime.js` — API client and IndexedDB offline queue
- `sw.js` — offline app-shell cache
- `docker-compose.yml` — local demo services
