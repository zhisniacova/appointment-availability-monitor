# Road Test Watch

Road Test Watch monitors ICBC road-test appointment availability and emails you when an appointment appears at one of the locations you choose.

You do **not** need to install anything, write code, or keep this website open.

> Road Test Watch is an independent tool and is not affiliated with ICBC.

## How to use it

1. Open the Road Test Watch website.
2. Enter your email address.
3. Click the sign-in link sent to your email.
4. Enter your ICBC booking details.
5. Enter a postal code to find nearby road-test locations.
6. Select one or more locations you are willing to visit.
7. Click **Start monitoring**.

That's it.

Road Test Watch will continue checking in the background and email you if availability appears.

## What happens when an appointment is found?

You will receive an email showing:

- the ICBC location
- available appointment details, when they can be detected
- a link to the official ICBC booking website

Appointments can disappear quickly, so you should book directly through ICBC as soon as possible.

Road Test Watch **does not book appointments for you**.

## Managing your tracker

Sign in to the website at any time to:

- add or remove locations
- change your postal code
- update your ICBC details
- pause monitoring
- resume monitoring
- delete your tracker and stored information

## Your information

Road Test Watch needs your ICBC booking details so it can check availability while you are offline.

Sensitive ICBC credentials are encrypted before being stored and are not displayed back in the dashboard.

You can permanently delete your account and stored credentials from the website at any time.

## Important

Road Test Watch only checks for availability.

It does **not**:

- book appointments
- reserve appointments
- reschedule appointments
- cancel appointments
- make changes to your ICBC account

You are responsible for booking directly through ICBC.

---

# Developer Documentation

Everything below this point is for people who want to run or contribute to the project.


A small multi-user web application that monitors ICBC road-test appointment availability and emails users when availability appears for their selected offices.

This service only monitors. It does not book, reserve, reschedule, cancel, or modify ICBC appointments.

## User Flow

Normal users do not need Node, GitHub, `.env` files, Telegram, or chat IDs.

1. Open the website.
2. Sign in with an email magic link.
3. Enter ICBC last name, driver's licence number, and keyword/password.
4. Enter a Canadian postal code.
5. Choose one or more nearby ICBC road-test locations.
6. Start monitoring.
7. Receive email if availability appears.
8. Return to the dashboard to edit, pause, resume, or delete the tracker.

## Architecture

- `src/web-server.js` serves the passwordless sign-in flow, dashboard, tracker setup, CSRF-protected actions, and account deletion.
- `src/auth.js` creates and verifies magic links, secure session cookies, and CSRF tokens.
- `src/email-service.js` provides a vendor-neutral email abstraction with console delivery for local development and Resend support for production.
- `src/notifications.js` formats email notifications and deduplicates availability changes.
- `src/icbc-locator-client.js` calls ICBC's structured locator search during setup and isolates volatile Next.js form/action details.
- `src/location-discovery.js` normalizes postal codes, filters ICBC locator results to booking-compatible road-test locations, and orders nearby choices.
- `src/storage.js` persists users, trackers, tracker locations, auth tokens, sessions, cached locator searches, and cached ICBC locations in SQLite.
- `src/icbc-checker.js` contains the Playwright ICBC flow.
- `src/scheduler.js` runs the background worker with throttling, jitter, backoff, per-tracker locking, and graceful shutdown.

## Developer Setup

Requires Node.js 22.5 or newer. This project uses Node's built-in SQLite binding.

```bash
npm install
npx playwright install
cp .env.example .env
```

Generate the encryption key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Put that value in `ENCRYPTION_KEY`.

With `EMAIL_PROVIDER=console`, sign-in and notification emails are written to logs instead of being sent. The sign-in confirmation page also exposes the development magic link so you can click through locally.

## Environment Variables

Copy the example file:

```bash
cp .env.example .env
```

Then fill in the required values in `.env`.

For local development, the most important settings are:

```bash
PUBLIC_BASE_URL=http://localhost:3000
ENCRYPTION_KEY=your_generated_key_here
DATABASE_PATH=./data/icbc-monitor.sqlite

EMAIL_PROVIDER=console
EMAIL_FROM="Road Test Watch <notifications@example.com>"

START_WORKER=false
```

Generate the encryption key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

To send real emails with Resend, use:

```bash
EMAIL_PROVIDER=resend
EMAIL_FROM="Road Test Watch <onboarding@resend.dev>"
RESEND_API_KEY=your_resend_api_key
```
For production over HTTPS, set:

```bash
COOKIE_SECURE=true
```

See `.env.example` for the complete list of available settings.

Never commit your real `.env` file or secrets to GitHub.

## Running

```bash
npm run dev
```

Production uses the same entrypoint:

```bash
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

The background worker starts in the same process by default. Set `START_WORKER=false` for web-only smoke tests or if you run a separate worker process.

## Database

SQLite is used for local development. The data-access layer is centralized in `src/storage.js` so Postgres can replace SQLite later.

Primary tables:

- `users`: email identity and timestamps.
- `trackers`: encrypted ICBC credentials, active state, check timestamps, availability state, errors, and backoff.
- `tracker_locations`: one or more selected ICBC locations per tracker, plus per-location availability notification state.
- `locations`: cached ICBC locator records with stable locator key, display name, address, city, coordinates, phone fields, raw JSON, and booking-verification metadata.
- `auth_tokens`: short-lived one-time magic-link tokens.
- `sessions`: signed-in browser sessions.
- `postal_location_searches`: cached setup-time locator search results.

## Location Discovery

Setup posts the user's postal code to ICBC's public locator with `serviceType=driver-licensing-office` and uses the structured `locations[]` records returned by that search. The service caches setup searches and does not query the ICBC locator during monitoring cycles.

ICBC's locator includes driver licensing offices, road-tests-only claims centres, Service BC centres, and third-party agents. The UI therefore filters general locator records through `src/locations.js` before presenting selections.

`src/locations.js` is a manually seeded candidate allowlist, not an automated proof that every listed office is currently searchable in the road-test booking workflow. Entries are marked `manual-unverified` until a future verification job confirms them against the booking autocomplete. No entries are currently marked as confirmed by such a job. This keeps unverified ICBC locator results separate from confirmed road-test-searchable locations.

ICBC currently handles postal-code proximity server-side but does not expose the exact geocoded postal-code coordinate in the response. To avoid misleading precision, the UI does not claim a 50 km or 100 km radius. It presents ICBC's nearest-first monitorable results and offers "Show more nearby locations."

## Worker

The scheduler is independent from HTTP requests and browser sessions. It keeps running after a user closes the website.

If ICBC reports that a user already has an active road-test appointment, the checker records only the normalized active appointment fields needed for comparison, enters ICBC's reschedule search flow, and treats only earlier available slots as actionable. It must never click an appointment slot, review a replacement, confirm a replacement, cancel, or otherwise modify a booking.

Worker protections include:

- no permanent browser per user
- shared Playwright browser with isolated context per check
- server-wide concurrency limit
- per-tracker locking
- scheduling jitter
- progressive error backoff
- global pause protection for repeated likely ICBC outages
- graceful shutdown

Keep `CHECK_INTERVAL_MINUTES`, `MAX_CONCURRENT_CHECKS`, and `MIN_DELAY_BETWEEN_CHECKS_MS` conservative.

## Security

- ICBC credentials are encrypted at rest with AES-256-GCM.
- `ENCRYPTION_KEY` must come from environment variables or secret management.
- ICBC credentials are never logged or displayed back in the UI.
- Magic links are short-lived and single-use.
- Session cookies are HTTP-only and SameSite=Lax; use HTTPS and `COOKIE_SECURE=true` in production.
- Mutating forms use CSRF protection.
- Authentication and tracker setup endpoints are rate limited in memory.
- HTTP security headers are set on every response.
- Users can permanently delete their account, tracker, selected locations, and stored ICBC credentials.

## Testing

```bash
npm run check
npm test
```

The automated tests avoid real ICBC credentials and do not contact ICBC. Manual ICBC testing requires a real account.

## Deployment Notes

- Deploy behind HTTPS before inviting real users.
- Store `ENCRYPTION_KEY`, email API keys, and other secrets outside git.
- Back up the SQLite database if you need account continuity.
- Do not rotate `ENCRYPTION_KEY` without a migration plan; stored ICBC credentials cannot be decrypted without it.
- Move from in-memory rate limiting and SQLite to shared infrastructure before running multiple app instances.
- Consider separating the web process and worker process once traffic grows.

## Responsible Use

Use conservative polling settings and respect ICBC's systems and terms. The service exists to notify users so they can manually decide what to do next.
