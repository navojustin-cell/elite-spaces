# ELITE Spaces internal test: tester guide

This is the first test of the ELITE Spaces app (PRD rollout step 1). It runs at one location, and staff play every part: students, parents, staff and the director. Everything you enter is test data.

Find your role below. Each role has its own page: how to get in, what to try in order, and what to report.

| Fill in before the test | |
|---|---|
| Test link | ______________________________ |
| Test location | ______________________________ |
| Test dates | ______________________________ |
| Send reports to | ______________________________ |

## Before you start (everyone)

- **Every account needs its own email address.** If you play a parent and also have a staff account, use a different email for each. A student can't use the parent's email.
- **Use one phone per account if you can.** Notifications go to whoever is signed in on that phone. If you switch accounts, sign out first (your first name and ⏻, top right).
- **iPhone:** notifications need iOS 16.4 or later, and only work from the Home Screen app, not from Safari.
- **Don't tap "No thanks" on the notifications banner.** It hides the banner on that phone for good, and this build has no other button to turn notifications on.
- The bell (top right) is your Inbox. Everything the app sends you lands there, even with notifications off.

## Test order

Some steps need others done first. Go in this order:

1. **Director:** set the location's hours, add a term and sessions, add staff accounts, put the Entrance QR on screen or print it.
2. **Parents:** create a family account and invite a student.
3. **Students:** open the invite and set a password. **Parents:** approve them.
4. **Staff:** set up a membership for each student (Members). Nobody can enroll without one.
5. **Parents:** enroll students in sessions. **Students:** ask to join one.
6. **Session day:** students scan in and out, staff watch In the building and write daily notes, the director sends an announcement and an emergency alert drill.
7. **Parents:** read the daily note and download an hours log.

## How to report a problem

Report anything that breaks, confuses you, or doesn't match this guide. One problem per report. Copy this:

```
Role and phone:   (for example: Parent, iPhone 13, Home Screen app)
Screen:           (for example: Schedule, Add a session)
What happened:
What you expected:
Screenshot:       attached / none
```

Take the screenshot the moment it happens, before you tap anything else.

---

## Student

You're a homeschooled student with your own phone. You scan in and out, see your schedule, and ask a parent for sessions.

### Get in

1. Your "parent" sends you an invite by text or email. Open the link **on your phone**. (No link? Open the test link, tap **Have an invite code?**, type the code, tap **Continue**.)
2. You see **Welcome, [your name]**. Fill in **Choose a password** (and **Your email** if it asks), then tap **Finish my account**.
3. You see **You're almost in**. Your parent has to approve you before you can sign in. Tell them.
4. Install the app:
   - **iPhone (Safari):** open the test link, tap the Share button (square with an arrow), tap **Add to Home Screen**, tap **Add**.
   - **Android (Chrome):** open the test link, tap the ⋮ menu, tap **Add to Home screen** (or **Install app**).
5. Open **ELITE Spaces** from the new icon. Sign in with your **Email** and **Password**, tap **Sign in**.
6. On Home, tap **Turn on notifications**, then **Allow**.

### Try these, in order

1. **Home.** You should see **Not checked in**, a **Scan to check in** button and a **Your membership** card.
2. **Ask for a session.** Tap **Schedule**. Under **Ask to join a session**, tap **Ask to join** on one. It should change to **Asked**, and **Your requests** should say **Waiting for a parent**.
3. **Get the answer.** When your parent decides, you get a notification. **Your requests** should change to **Approved · enrolled** or **Declined**. An approved session shows under **Every week**.
4. **Scan in.** At the location, from 30 minutes before your session starts until it ends, tap **Check in**, then **Scan to check in**. Allow the camera, point it at the code by the entrance, and allow your location. You should see **✓ Checked in** with the time, the session, and "Your parents have been told."
5. **Scan with the Camera app.** Another time, open your phone's own Camera app and point it at the entrance code. It should open ELITE Spaces straight to check-in (and ask you to sign in first if you're signed out).
6. **Scan twice by mistake.** Right after checking in, scan again. It should ask before checking you out. Tap **Stay checked in**.
7. **Scan out.** When you leave, tap **Scan to check out**. You should see **✓ Checked out** with your total time.
8. **News.** Open **News** and read the announcements. When the director sends the emergency alert drill, a red **Emergency alert** box pops up (or a notification, if the app is closed). Tap **I have read this**.

### Look for and report

- A scan that takes more than about 2 seconds once your location is found.
- A wrong refusal. These messages are correct only when true: **We couldn't confirm you're in the building** (you're outside), **No session right now** (no session starting within 30 minutes or under way), **This code has expired** (yesterday's code).
- Any time the camera or location prompt didn't appear, or the help steps didn't get you going again.
- Notifications that didn't arrive, arrived twice, or arrived with the app closed but showed wrong details.
- You won't see daily notes. That's on purpose in this version.

---

## Parent

You hold the family account. You invite your student, pick their sessions, and get check-ins, notes and hours.

### Get in

1. **Install the app first:**
   - **iPhone (Safari):** open the test link, tap the Share button (square with an arrow), tap **Add to Home Screen**, tap **Add**.
   - **Android (Chrome):** open the test link, tap the ⋮ menu, tap **Add to Home screen** (or **Install app**).
2. Open **ELITE Spaces** from the new icon. Tap **New family? Create an account**.
3. Fill in **Your full name**, **Email**, **Mobile phone**, **Password** (8 or more characters), and pick the test location under **Home location**. Tap **Create account**.
4. Go to **Home** and tap **Turn on notifications**, then **Allow**.

On a phone, **News** and **Family** are under **More** in the bottom bar.

### Try these, in order

1. **Invite your student.** The **Invite a student** form opens right after sign-up (or **Family** › **Invite a student**). Fill in **Student's full name** and **Student's email** (an email only the student uses), tap **Create invite**. Send it with **Text it**, **Email it** or **Copy invite message**. The code is shown only once.
2. **Approve your student.** When they set a password you get a notification, and Home shows **[Name] is waiting for your approval**. Tap **Approve**.
3. **Enroll.** Once staff have set up a membership, open **Schedule**. Under **Add a session**, tap **Enroll** on a day and time. It should appear under **[Name]'s weekly sessions**.
4. **Answer a request.** When your student asks for a session, **Requests from your students** appears on Schedule (and **Session requests** on Home). Approve one. If you can, decline another and check your student is told.
5. **Waitlist (with a second parent).** On a session the director set to very few seats, fill it, then have the other parent tap **Join waitlist** (or **Enroll**, then **Add [Name] to the waitlist**). Drop a spot with **Drop**, then **Drop [day]s**. The waiting student should be enrolled automatically, and their parent notified.
6. **Session day.** You should get a notification when your student checks in and when they check out. Home's **Today** card should match.
7. **Daily note.** After staff post it, you get a notification. Open **Notes** to read the ratings and comment. Home also shows **Today's notes**.
8. **Hours.** Open **Hours**. Switch between **Week**, **Month** and **Term**. Under **Download a log**, pick a range and tap **Download PDF**, then **Download CSV**. Open both.

### Look for and report

- Any check-in or check-out notification that was missing, late, or had the wrong time or session.
- An automatic check-out (student forgot to scan out) that isn't labeled as automatic.
- Hours that don't match the times you saw, or a PDF/CSV you couldn't open or wouldn't hand to an evaluator.
- An enroll, waitlist or drop that said one thing and showed another.
- Anything in **Family** that's confusing: invite states, **Resend**, **Cancel invite**, **Invite a guardian**.

---

## Staff

You work the front desk and the floor. You watch who's in the building, fix check-ins, set memberships, and write daily notes.

### Get in

1. Your director gives you a **temporary password**. Open the test link (a computer is fine; staff screens are built for desktop too).
2. Sign in with your work **Email** and the temporary password, tap **Sign in**.
3. On Home, under **Choose your own password**, fill in **Current password** (the temporary one) and **New password**, tap **Save new password**.
4. Phone: install it the same way as families (iPhone: Safari › Share › **Add to Home Screen** › **Add**; Android: Chrome › ⋮ › **Add to Home screen**).
5. Notifications: staff accounts don't get the **Turn on notifications** banner in this build. Watch the bell (top right) and the pop-ups while the app is open.

On a phone, **Members**, **Sessions** and **People** are under **More**.

### Try these, in order

1. **Set up memberships.** Open **Members**. Find a test student, tap **Set up**. Leave **Status** on **Active**, set **Weekly session limit** (try 3), **Start date** and **Last day**, tap **Set up membership**. Do this for every test student before parents enroll.
2. **Open In the building.** Check the counts: **in the building**, **still expected**, **left today**. The list refreshes on its own every 15 seconds or so.
3. **Show the entrance code.** Tap **Entrance QR**, then **Full screen** (or **Print**). It should say **Students: scan to check in or out** and **Today's code · good until** a time.
4. **Check someone in by hand.** Under **Check someone in or out by hand**, type a name in **Student name**, tap **Check in**, pick a **Reason (optional)** like **Phone is dead**, tap **Check in** (or **Check in anyway** if they have no session now). The row under **Here** should say **Checked in by [your name]**. Check them out the same way with **Check out**.
5. **Review a missed scan-out.** Agree with a student that they won't scan out. After their session ends they appear under **Needs review**. Tap **Time is right**, or **Fix time out**, set **Actual time out**, tap **Save time out**.
6. **Write daily notes.** Open **Daily notes**. For each student who came in, tap **Needs work**, **Good** or **Great** on every item, add a **Comment (optional)**, tap **Post note**. Try **Save for later** on one, then come back and post it. Edit a posted note with **Edit note** › **Save changes**.
7. **Change a membership.** In **Members**, open a student who holds sessions. Try to lower **Weekly session limit** below what they hold (it should refuse and explain). Then set **Status** to **Inactive**: the button should say **Save and pause [n] sessions**. Save, then set it back to **Active** and save again. Their sessions should come back, and the family should be told each time.
8. **People.** Open **People** › **Families**. Search for a student or parent by name, email or phone.

### Look for and report

- A student who checked in but isn't under **Here**, or a count that's wrong.
- A manual entry that isn't saved with your name and reason.
- A note you couldn't post, or a parent who didn't get the notification after **Post note**.
- Any screen that's slow or hard to use at the front desk with a line of students.
- **Sessions** is read-only for staff, and only directors post in **News**. That's on purpose.

---

## Director

You lead the location. You do everything staff do, plus the schedule, staff accounts, announcements, emergency alerts and reports.

### Get in

1. The test coordinator (HQ) gives you a **temporary password**. Open the test link and sign in with your work **Email** and that password.
2. On Home, under **Choose your own password**, fill in **Current password** and **New password**, tap **Save new password**.
3. Phone: install it the same way as families (iPhone: Safari › Share › **Add to Home Screen** › **Add**; Android: Chrome › ⋮ › **Add to Home screen**).
4. Notifications: director accounts don't get the **Turn on notifications** banner in this build. Watch the bell (top right) and the pop-ups while the app is open.

On a phone, **News**, **Members**, **Sessions** and **People** are under **More**.

### Try these, in order

1. **Location settings.** Open **People** › **Location settings**. Check **Check-in radius (meters)** (150 suits most buildings), **New QR code each day at**, **Opens at** and **Closes at**. Tap **Save changes**.
2. **Term and sessions.** Open **Sessions**. Tap **Add a term**, fill **Name**, **First day**, **Last day**, tap **Add term**. Then tap **+ New session**: **Name**, **Days it meets**, **Starts**, **Ends**, **Seats per day**, tap **Create session**. Make one session with only 1 or 2 seats so parents can test the waitlist.
3. **Staff accounts.** Open **People** › **Staff**, tap **Add a staff member**, fill **Full name** and **Work email**, tap **Create account**. Copy the temporary password (it shows once) and give it to them. Try **Reset password**, **Deactivate** and **Reactivate** on a test account.
4. **Entrance code.** Open **In the building** › **Entrance QR** › **Full screen** on a screen by the door, or **Print** it. A printed copy works only until the time it shows.
5. **Announcement.** Open **News** › **New announcement**. Pick **Who should get this?**, a **Kind of post**, a **Title** and **Message**, leave **Send now**, tap **Review**, then **Post now**. Also schedule one with **Schedule for later**. Watch **Sent to**, **Delivered** and **Read**, and tap **Refresh numbers**.
6. **Emergency alert drill.** Agree the time with everyone first. In **News**, tap **Send emergency alert**. Start the **Headline** with "TEST DRILL", fill **What should people do?**, tap **Review alert**, then **Send alert now**. Everyone with the app open should get a red pop-up, and everyone else a notification, including parents who muted announcements.
7. **Closure and session changes.** In **Sessions**, tap **Add a closure**, pick a **Date** (today or later), tap **Close this day** › **Close and tell families**. Then **Reopen** it. Tap a session in **Weekly schedule**, change **Seats per day**, tap **Save changes**. Families should be told.
8. **Reports.** Open **Reports**. Pick a **Session** and a range, tap **Show report**. Check **By student**, **Visits** and **Absences**, then **Download CSV** and **Download PDF**.

Also try the staff list (memberships, In the building, daily notes) if no one else covers it.

### Look for and report

- Families who should have been told about a closure, change or cancellation but weren't, or who were told twice.
- **Sent to**, **Delivered** or **Read** numbers that don't match what testers say they got.
- An emergency alert that didn't pop up for someone signed in, or that someone could mute.
- Report numbers that don't match In the building, Daily notes or a parent's Hours.
- Anything that refused a change without saying why.

---

## Already known (no need to report)

- An emergency alert stays pinned as **active now** for 24 hours. There's no way to end it early yet.
- A missed session shows as **Absent**, but parents aren't notified.
- Students don't see daily notes, and enrollment is weekly only (no single dates). Both are on purpose in this version.
- After some buttons (**Refresh numbers**, **Decline**, **Cancel invite**, **Deactivate**), the screen jumps back to the top.
- The parent's check-out notification doesn't name the session (the check-in one does).
- Home's **Latest news** doesn't update by itself when a normal announcement arrives (emergency alerts do).
- Everyone is signed out if the test server restarts. Just sign in again.
