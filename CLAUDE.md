# ELITE Spaces app (v1 prototype)

The ELITE Spaces app from `docs/PRD.md` (source: "ELITE Spaces App — PRD (v1)", Oct 6, 2026).
It checks homeschool students in and out of ELITE Spaces study centers, handles recurring
session enrollment with caps and waitlists, sends announcements and emergency alerts,
posts daily staff notes to parents, and exports attendance and hours.

Built with the gauntlet loop: builder versus a fresh critic, against a hard benchmark.

## Run it
```
npm install
npm run seed            # demo data; every password is demo1234
ELITE_DEV=1 npm start   # demo mode, http://localhost:3000 (PORT env to change)
                        # Windows PowerShell: $env:ELITE_DEV=1; npm start
npm start               # dev mode OFF: no demo sign-in, clock control or /api/dev endpoints
```
Dev mode is off unless `ELITE_DEV=1` is set explicitly. It adds a purple bar for setting the
clock and running scheduled jobs, plus one-tap demo sign-in on the sign-in screen. The clock and job endpoints
(`/api/dev/clock`, `/api/dev/run-jobs`) need a signed-in user (401 otherwise); `/api/dev/accounts` and
`/api/dev/login-as` stay open because the demo sign-in screen uses them.
The sign-in cookie is named per port (`sid_<PORT>`), so several local servers in one browser don't sign each other out.
It is httpOnly, responses must never echo its token (L64), and it is Secure when the request came over HTTPS (`trust proxy` is on).
Every response carries security headers (`src/app.js`, no dependencies): no `X-Powered-By`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` plus `Content-Security-Policy: frame-ancestors 'none'` (deliberately no script policy),
`Referrer-Policy: strict-origin-when-cross-origin`, and `Strict-Transport-Security` only when the request came over HTTPS.

Icons: `public/icon.svg` is the design; `python scripts/make-icons.py` (PIL) draws the PNGs in `public/icons/`
(180px apple-touch-icon, opaque and full-bleed; 192/512 for the manifest; a maskable 512 with the art in the safe zone).
`/apple-touch-icon.png` at the site root serves the 180px one. Edit the SVG, then rerun the script.

Hosting: `render.yaml` + `.node-version` set up a Render web service with a disk; `docs/deploy.md` has the steps.
`GET /healthz` answers `{ok:true}` without sign-in. A new database gets the schema only; `ELITE_SEED_DEMO=1`
runs the demo seed, and only into a database with no accounts.

## The benchmark (the gauntlet's pass condition)
```
npm run gate      # = npm test && npm run mutate && npm run coverage
```
Passing means all three of these:
1. `npm test` shows **FAIL 0**.
2. `npm run mutate` shows **MISSED 0, stale 0**. Every mutation deliberately breaks one behavior, and the tests must catch it.
3. `npm run coverage` shows **gaps 0**. Every `gate: "test"` requirement in `docs/requirements.json` has at least one test and at least one mutation in each module it lists.

You can scope any of them to a module: `node tests/run.js checkin`, `node tests/mutate.js checkin`,
`node tests/coverage.js checkin`. A scoped run loads only that module into the app.
`tests/integration.test.js` (with `tests/mutations/integration.js`) runs flows across modules
with every module loaded, including in `node tests/run.js integration`.

## Layout and file ownership

| Path | Owner |
|---|---|
| `schema/000_core.sql`, `schema/005_push.sql`, `src/{app,auth,db,clock,time,notify,push,audit,errors}.js`, `server.js`, `public/sw.js`, `render.yaml`, `src/modules/index.js`, `public/js/app.js`, `public/css/app.css`, `public/index.html`, `tests/{lib,run,mutate,coverage}.js`, `tests/integration.test.js`, `tests/mutations/{core,integration}.js`, `scripts/seed.js` | **foundation**: shared, change only when integrating |
| `src/modules/<m>/` (routes, services, jobs, optional `seed.js`) | module `<m>` |
| `schema/NNN_<m>.sql` (new tables and indexes only, never `ALTER TABLE`: D-55) | module `<m>` |
| `public/js/views/<m>.js` | module `<m>` |
| `tests/<m>.test.js`, `tests/mutations/<m>.js` | module `<m>` |

Modules: `accounts checkin sessions enrollment membership announcements notes attendance`.
Schema file numbers are `010_accounts 020_checkin 030_sessions 040_enrollment 050_membership 060_announcements 070_notes 080_attendance`.

Modules talk through the **core tables** (`schema/000_core.sql`), not by importing each other.
A module may `require('../<other>/...')` only for read-only helpers that the other module exports
on purpose, such as `src/modules/sessions/times.js` and `src/modules/sessions/dates.js`. Every module
decides whether a schedule meets on a date through `sessions/dates.js` (`overrides`, `meets`, `datesOf`,
`counts`, `daysPerWeek`; D-47, D-26 (6)), never with its own weekday check.
Schema files add new tables and indexes only, never `ALTER TABLE` (D-55): `src/db.js` re-runs every
schema file on each open, so new fields go in side tables. Notifications go through `src/notify.js`, staff edits through `src/audit.js`, and scope
checks through `src/auth.js`. Sign-in sessions start with `auth.startSession(ctx, res, userId)`.
The shared contracts between modules (membership audit rows, the enrollment status log, check-in
notification kinds) are in `docs/decisions.md` D-26.

Shell hooks for views (`public/js/app.js`):
- `App.boot()` redraws after a module signs someone in, and tells the other open tabs.
- One account per browser: tabs share the sign-in cookie, so the shell re-checks `/api/auth/me` when a tab comes
  into view or gets focus, before drawing a page after 5 seconds without a check, and once after any 403. Sign-in and
  sign-out are broadcast to other tabs (BroadcastChannel, else a localStorage `storage` event). When the account
  changed, the whole app is drawn again for the one signed in now (open `App.confirm` boxes answer `false`, forms are
  dropped) with a toast ("You're now signed in as Chris Ortiz."). An error whose 403 turned out to be a switch has
  `e.accountChanged`, and `App.run` doesn't toast it. Views must not keep drafts that outlive a redraw unless they are
  keyed by `App.me.user.id`.
- `App.inboxLink(refType, route)` makes Inbox items whose `ref_type` matches open a view. `route` is a
  view id with optional params (`'notes'`, `'schedule/12'`) or a function of the notification returning
  one. Several modules may register one ref type; the first route the signed-in role can open wins.
  Ref types sent today: `visit` (checkin), `closure`, `session` (sessions), `enrollment` (enrollment),
  `membership` (membership), `announcement` (announcements, including `emergency_ended`),
  `daily_note` (notes), `missed_day` (attendance), `user`, `location` (accounts).
  `enrollment_request` (enrollment) is no longer sent (D-48) but stays registered, so old Inbox items open Schedule.
- `await App.confirm({ anchor | el, title, body, confirmLabel, cancelLabel, danger })` asks before a
  consequential action and resolves `true` or `false`. Labels are verb-first and name the thing
  (`confirmLabel: 'Deactivate Sam'`, `cancelLabel: 'Keep active'`); `danger: true` makes the confirm
  button red. `anchor` opens the box right after that element; `el` swaps that element's content for
  the box until it closes; with neither, it opens after the focused button. It is an inline
  `role="alertdialog"` labelled by its title: the safe button comes first and gets focus, Escape picks
  it, and focus returns afterward to `opener` (optional), else the element focused when it opened,
  else `anchor`. Safari doesn't focus a tapped button, so pass the button as `anchor` or `opener`.
  Never use `window.confirm` or `alert`.
- `App.toast(msg, 'error'?)` and `App.run(btn, fn)` (disables `btn`, shows errors as toasts).
- A tapped push notification opens `#/inbox/<id>`, which goes on to that item's `App.inboxLink` route.
- On the sign-in screen the tab title follows the first `h2` of a panel a module shows in place of the
  sign-in form (hide the form with `style.display = 'none'`), else "Sign in".

Web push (`src/push.js`): `notify.send()` also pushes each notification to the user's subscribed browsers,
after the request finishes, never throwing into it. VAPID keys come from `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, else are made once and kept in `settings`. Endpoints must be a known push
service over https. Tests set `ctx.pushSender` to a fake and `await push.flush(ctx)`; nothing touches the network.
Home shows parents and students a banner to turn notifications on (the iPhone Add to Home Screen steps in
Safari); permission is asked only on a tap, "No thanks" is remembered per device, and it shows once a session.

## Rules
- **Every behavior arrives with a test that fails when the behavior is reverted**, plus a mutation
  in `tests/mutations/<m>.js` that proves it. Changing a test instead of the code is a failed round.
- Tests reach the app only through `tests/lib.js` (`makeApp`, `load`). Never `require('../src/...')`.
- Tag every test with the requirement IDs it proves: `test(['CI-1','NF-4'], 'name', async () => {...})`.
- Every endpoint enforces scope (NF-1): families see only their own, staff only their location,
  and HQ everything. Each module tests that a family can't read another family's data and that staff can't reach
  another location's data.
- Times: UTC ms in the DB. Location-local dates and times come from `src/time.js` and the location's
  `timezone`, never the server's zone.
- Follow `docs/decisions.md`. A change that needs a different rule must ask first.
- No payment data. No email or SMS: notifications go to the in-app inbox, and as web push to devices that turned it on.
- English only (PRD non-goal). WCAG 2.1 AA: labeled controls, 44px targets, contrast tokens from
  `app.css`, visible focus.
- Never deploy, never push to a remote, and never touch real families' data.
