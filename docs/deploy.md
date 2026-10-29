# Putting ELITE Spaces online (Render)

The app is ready to host on Render. Nothing is online yet: this page is the plan for when you decide to do it.
The setup lives in `render.yaml` (one web service, Node 24, a 1 GB disk for the database).

**What it costs:** a Render "Starter" web service (about $7 a month) plus the disk (about $0.25 per GB a month).
The free plan can't keep a disk, and without a disk every restart would erase all data.

**What you need first:** a GitHub account. Render only deploys from a Git repository (GitHub, GitLab or
Bitbucket); it has no "upload a folder" option for this kind of setup.

## Your steps (click by click)

### 1. Put the code on GitHub (private)
1. Go to github.com and sign in (or create an account).
2. Top right **+** > **New repository**.
3. Name: `elite-spaces`. Choose **Private**. Leave "Add a README" unchecked. Click **Create repository**.
4. Send Claude the repository's address (it looks like `https://github.com/<you>/elite-spaces`) and say "push it".
   Claude never pushes code anywhere until you say so.

### 2. Create the Render account
1. Go to render.com and click **Get Started**.
2. Choose **Sign up with GitHub** and approve.
3. Add a card: your account menu (top right) > **Billing** > add a payment method.

### 3. Create the app from the Blueprint
1. In the Render dashboard click **New** (top right) > **Blueprint**.
2. Under "Connect a repository", click **Connect GitHub** (first time only). In the GitHub window choose
   **Only select repositories**, pick `elite-spaces`, and click **Install**.
3. Back in Render, pick `elite-spaces` and click **Connect**.
4. Blueprint name: `elite-spaces`. Branch: `master`. Render lists one web service, `elite-spaces`, with a disk.
5. Render asks for three values:
   - `VAPID_PUBLIC_KEY`: leave blank.
   - `VAPID_PRIVATE_KEY`: leave blank. (With both blank the app makes its own push keys once and keeps them on the disk.)
   - `VAPID_SUBJECT`: type `mailto:` followed by an ELITE email address that phone makers can reach if push
     ever misbehaves, for example `mailto:support@<elite's domain>`.
6. Click **Deploy Blueprint** (or **Apply**).
7. Wait until the service shows **Live** (a few minutes). Its address is shown at the top, like
   `https://elite-spaces.onrender.com` (Render may add a few letters to the name).
8. Check it: open that address with `/healthz` on the end. You should see `{"ok":true}`.

Do **not** add `ELITE_DEV`. Dev mode (one-tap demo sign-in, clock control) must never be on for a hosted server.

### 4. Demo or real?
- **For a demo:** in the service, open **Environment** > **Add Environment Variable**: key `ELITE_SEED_DEMO`,
  value `1` > **Save, rebuild, and deploy**. The demo data (every password `demo1234`) goes in only while the
  database is empty, so this can never wipe real data. Remove the variable afterwards.
- **For real families:** don't add it. A new database starts with no accounts at all, so the first HQ account
  has to be created before anyone can sign in. That step isn't built yet: tell Claude when you get here.

### 5. Phones
- **iPhone:** open the address in **Safari** > Share button > **Add to Home Screen** > **Add**. Open ELITE Spaces
  from the new icon, sign in, and tap **Turn on notifications** on Home. (iPhone only allows notifications
  from the Home Screen app, and the app shows these steps when opened in Safari.)
- **Android:** open the address in Chrome, sign in, and tap **Turn on notifications** on Home.

## What Claude does after
- Pushes the code to your private repository, only when you say so.
- Checks the live service: `/healthz`, signing in over HTTPS (the sign-in cookie is marked Secure there), and a
  test notification arriving on your phone with the app closed.
- Reads the Render logs if something fails, and fixes it locally with the full test gate green first.
- Ships updates only when you approve: Claude pushes the new commit, then you click **Manual Deploy** >
  **Deploy latest commit** in Render (automatic deploys are off in `render.yaml`).

## Good to know
- Everyone is signed out when the service restarts or redeploys (sign-ins are kept in memory). They just sign in again.
- The database is one file on the disk (`/var/data/elite-spaces.db`). Render's disk snapshots are its backup.

## Upgrading from v1 to v1.1
v1.1 (fixed schedules) does not convert a v1 database: v1 had no real families, so nothing migrates its per-day
enrollments (MIG-1 and D-54 were retired on Oct 28, 2026). A v1 database must be reseeded instead:
- **Locally:** `npm run seed` (it rebuilds `data/elite-spaces.db` from scratch).
- **On Render:** the demo service (free plan, no disk, `ELITE_SEED_DEMO=1`) starts a fresh demo database on every
  deploy, so deploying v1.1 is the reseed. A service with a disk keeps its file across deploys: delete
  `/var/data/elite-spaces.db` (Shell tab) before the v1.1 deploy so it starts empty and the demo seed runs again.

## Upgrading to weekly goals (Oct 28, 2026)
Weekly top 3 goals (D-57) replace the daily goals: `schema/070_notes.sql` no longer has `daily_goal_days` or
`daily_goals`; the new tables are `goal_weeks`, `week_goals` and `goal_checks`. Every database before this is demo
data (Justin, Oct 28), so it is reseeded, not converted, the same way as above: `npm run seed` locally, and on Render
a fresh demo deploy (or delete `/var/data/elite-spaces.db` first on a service with a disk). An old file keeps its
unused daily tables until it is reseeded; nothing reads them.
