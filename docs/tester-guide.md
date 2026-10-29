# ELITE Spaces internal test: tester guide

This is the first test of the ELITE Spaces app (PRD rollout step 1). It runs at one location, and staff play every part: students, parents, staff and the director. Everything you enter is test data.

This guide is for version 1.1: fixed schedules (a parent picks one schedule per period and the student attends every date), daily goals after each check-in, ending an emergency alert early, and a notice to parents when a scheduled day is missed. The app never asks for your phone's location.

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

1. **Director:** set the location's hours, add a period and its schedules, add staff accounts, put the Entrance QR on screen or print it.
2. **Parents:** create a family account and invite a student.
3. **Students:** open the invite and set a password. **Parents:** approve them.
4. **Staff:** set up a membership for each student (Members). Nobody can enroll without one.
5. **Parents:** choose a schedule for each student.
6. **Schedule day:** students scan in and out and set their goals, staff watch In the building and write daily notes, the director moves a date, sends an announcement and an emergency alert drill, then ends the alert.
7. **Parents:** read the daily note, check the missed-day notice, and download an hours log.

## How to report a problem

Report anything that breaks, confuses you, or doesn't match this guide. One problem per report. Copy this:

```
Role and phone:   (for example: Parent, iPhone 13, Home Screen app)
Screen:           (for example: Schedule, Choose a schedule)
What happened:
What you expected:
Screenshot:       attached / none
```

Take the screenshot the moment it happens, before you tap anything else.

---

## Student

You're a homeschooled student with your own phone. You scan in and out, see the schedule your parent picked, and set your goals for the day.

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
2. **Your schedule.** Tap **Schedule**. Before your parent picks one it says **Ask a parent to pick your schedule.** Afterwards it shows your schedule (its days, time and period) and **This week**. You can't change it: only a parent enrolls.
3. **Scan in.** At the location, from 30 minutes before your schedule starts until it ends, tap **Check in**, then **Scan to check in**. Allow the camera and point it at the code by the entrance. You should see **✓ Checked in** with the time, the schedule, and "Your parents have been told." The app should never ask for your location.
4. **Set today's goals.** Right after checking in, the app asks **What are you working on today?** Tap **Set today's goals**. Pick a **Subject**, tap one of the examples under **Start from an example** (you can change the words), then tap **Add another goal** for a second one (up to 3). Tap **Save goals**. Home now shows your goals with **Edit**.
5. **Skip a day.** On another day, after checking in, tap **Skip today** instead. You should see **Skipped. You can still add goals from Home today.** Home shows **You skipped goals today.** with **Set goals**.
6. **Scan with the Camera app.** Another time, open your phone's own Camera app and point it at the entrance code. It should open ELITE Spaces straight to check-in (and ask you to sign in first if you're signed out).
7. **Scan twice by mistake.** Right after checking in, scan again. It should ask before checking you out. Tap **Stay checked in**.
8. **Scan out.** When you leave, tap **Scan to check out**. You should see **✓ Checked out** with your total time. Scanning out doesn't ask about goals.
9. **News.** Open **News** and read the announcements. When the director sends the emergency alert drill, a red **Emergency alert** box pops up (or a notification, if the app is closed). Tap **I have read this**. When the director ends it, you get an "All clear" notification and the alert is no longer pinned.

### Look for and report

- A scan that takes more than about 2 seconds.
- A wrong refusal. These messages are correct only when true: **No session right now** (nothing starting within 30 minutes or under way), **[Schedule] doesn't meet today (moved to [day])** (the director moved or skipped today's date), **This code has expired** (yesterday's code).
- Any time the app asked for your location, or the camera prompt didn't appear, or the help steps didn't get you going again.
- Goals you couldn't save, or the goals question coming back after you already answered it that day.
- Notifications that didn't arrive, arrived twice, or arrived with the app closed but showed wrong details.
- You won't see daily notes. That's on purpose in this version.

---

## Parent

You hold the family account. You invite your student, choose their schedule, and get check-ins, notes, missed-day notices and hours.

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
3. **Choose a schedule.** Once staff have set up a membership, open **Schedule**. Under **Choose a schedule**, each schedule shows its days and time, how many days a week it meets, its period, and the seats left. Tap **Enroll** on one. It should appear under **[Name]'s schedule**, and you get a notification.
4. **A schedule that doesn't fit.** A schedule that meets more days a week than the membership allows has its button turned off, with the reason under it. Check the reason makes sense.
5. **Switch.** In the same period, tap **Switch to this** on a different schedule. It asks first and names the schedule that ends. Confirm: the new one replaces the old one, with one notification about both.
6. **Waitlist (with a second parent).** On a schedule the director set to very few seats, fill it, then have the other parent tap **Join waitlist**. Their student keeps their current schedule until a seat opens. Drop the full schedule with **Drop**, then **Drop [schedule]**. The waiting student should be moved in automatically, and their parent notified.
7. **A moved date.** When the director moves or skips one of your schedule's dates, you get a notification. **This week** on Schedule shows the new date.
8. **Schedule day.** You should get a notification when your student checks in and when they check out. Home's **Today** card should match.
9. **Daily note.** After staff post it, you get a notification. Open **Notes** to read the ratings, the comment and **[Name]'s goals today** (only when your student set goals). Home also shows **Today's notes**.
10. **Missed day.** Agree with your student that they skip one scheduled day. About 30 minutes after that day's schedule ends you get **[Name] didn't check in today**. Tap it: it opens **Hours** on that week, and the absence says **Parents notified**.
11. **Hours.** Open **Hours**. Switch between **Week**, **Month** and **Term**. Under **Download a log**, pick a range and tap **Download PDF**, then **Download CSV**. Open both.

### Look for and report

- Any check-in or check-out notification that was missing, late, or had the wrong time or schedule.
- An automatic check-out (student forgot to scan out) that isn't labeled as automatic.
- A missed-day notice for a day your student came in, a closed day or a skipped date, or one that came twice.
- Hours that don't match the times you saw, or a PDF/CSV you couldn't open or wouldn't hand to an evaluator.
- An enroll, switch, waitlist or drop that said one thing and showed another.
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

On a phone, **Members**, **Schedules** and **People** are under **More**.

### Try these, in order

1. **Set up memberships.** Open **Members**. Find a test student, tap **Set up**. Leave **Status** on **Active**, set **Weekly limit (days a week)** (try 3), **Start date** and **Last day**, tap **Set up membership**. Do this for every test student before parents enroll.
2. **Open In the building.** Check the counts: **in the building**, **still expected**, **left today**. The list refreshes on its own every 15 seconds or so.
3. **Show the entrance code.** Tap **Entrance QR**, then **Full screen** (or **Print**). It should say **Students: scan to check in or out** and **Today's code · good until** a time.
4. **Check someone in by hand.** Under **Check someone in or out by hand**, type a name in **Student name**, tap **Check in**, pick a **Reason (optional)** like **Phone is dead**, tap **Check in** (or **Check in anyway** if they have no schedule now). The row under **Here** should say **Checked in by [your name]**. Check them out the same way with **Check out**.
5. **Review a missed scan-out.** Agree with a student that they won't scan out. After their schedule ends they appear under **Needs review**. Tap **Time is right**, or **Fix time out**, set **Actual time out**, tap **Save time out**.
6. **Write daily notes.** Open **Daily notes**. The top card shows **Goals: [n] set · [n] skipped · [n] not answered**. Each student's card shows their **Goals** (or **Skipped goals** / **No goals set**) above the ratings. Tap **Needs work**, **Good** or **Great** on every item, reply to the goals in **Comment (optional)**, tap **Post note**. Try **Save for later** on one, then come back and post it. Edit a posted note with **Edit note** › **Save changes**.
7. **Change a membership.** In **Members**, open a student who holds a schedule. Try to lower **Weekly limit (days a week)** below the days their schedule meets (it should refuse and explain). Then set **Status** to **Inactive**: the button should say **Save and pause** with the schedule. Save, then set it back to **Active** and save again. The schedule should come back, and the family should be told each time.
8. **People.** Open **People** › **Families**. Search for a student or parent by name, email or phone.

### Look for and report

- A student who checked in but isn't under **Here**, or a count that's wrong.
- A manual entry that isn't saved with your name and reason.
- Goals on a daily note that don't match what the student set, or a note you couldn't post, or a parent who didn't get the notification after **Post note**.
- Any screen that's slow or hard to use at the front desk with a line of students.
- **Schedules** is read-only for staff, and only directors post in **News**. That's on purpose.

---

## Director

You lead the location. You do everything staff do, plus the schedules, staff accounts, announcements, emergency alerts and reports.

### Get in

1. The test coordinator (HQ) gives you a **temporary password**. Open the test link and sign in with your work **Email** and that password.
2. On Home, under **Choose your own password**, fill in **Current password** and **New password**, tap **Save new password**.
3. Phone: install it the same way as families (iPhone: Safari › Share › **Add to Home Screen** › **Add**; Android: Chrome › ⋮ › **Add to Home screen**).
4. Notifications: director accounts don't get the **Turn on notifications** banner in this build. Watch the bell (top right) and the pop-ups while the app is open.

On a phone, **News**, **Members**, **Schedules** and **People** are under **More**.

### Try these, in order

1. **Location settings.** Open **People** › **Location settings**. Check **New QR code each day at**, **Opens at** and **Closes at**. Tap **Save changes**. (There is no check-in radius: a scan of today's code counts as being there.)
2. **Period and schedules.** Open **Schedules**. Tap **Add a period**, fill **Name** (or tap **This month** or **Next month** to fill the dates), **First day**, **Last day**, tap **Add period**. Periods can't overlap. Then tap **+ New schedule**: **Name** (like "Mornings MWF"), **Days it meets**, **Starts**, **Ends**, **Seats**, tap **Publish schedule**. Make one schedule with only 1 or 2 seats so parents can test the waitlist.
3. **Staff accounts.** Open **People** › **Staff**, tap **Add a staff member**, fill **Full name** and **Work email**, tap **Create account**. Copy the temporary password (it shows once) and give it to them. Try **Reset password**, **Deactivate** and **Reactivate** on a test account.
4. **Entrance code.** Open **In the building** › **Entrance QR** › **Full screen** on a screen by the door, or **Print** it. A printed copy works only until the time it shows.
5. **Change one date.** In **Schedules**, open a schedule families are enrolled in. Its days are now fixed (the boxes are turned off with a note). Under **Dates**, tap **Move…** on a coming date, pick the **New date**, add a **Reason (optional)**, tap **Move this date** › **Move and tell families**. Families should get one notification. Try **Skip** and **Add a date** too, then **Undo** one.
6. **Announcement.** Open **News** › **New announcement**. Pick **Who should get this?**, a **Kind of post**, a **Title** and **Message**, leave **Send now**, tap **Review**, then **Post now**. Also schedule one with **Schedule for later**. Watch **Sent to**, **Delivered** and **Read**, and tap **Refresh numbers**.
7. **Emergency alert drill.** Agree the time with everyone first. In **News**, tap **Send emergency alert**. Start the **Headline** with "TEST DRILL", fill **What should people do?**, tap **Review alert**, then **Send alert now**. Everyone with the app open should get a red pop-up, and everyone else a notification, including parents who muted announcements.
8. **End the alert.** On the pinned alert, tap **End alert** › **End alert**. It should stop being pinned, show **Ended** with the time, and everyone it went to should get an "All clear" notification. (An alert HQ sent to several locations can only be ended by HQ.)
9. **Closure and schedule changes.** In **Schedules**, tap **Add a closure**, pick a **Date** (today or later), tap **Close this day** › **Close and tell families**. Then **Reopen** it. Open a schedule, change **Seats**, tap **Save changes**. Families should be told.
10. **Reports.** Open **Reports**. Pick a **Schedule** and a range, tap **Show report**. Check **By student**, **Visits** and **Absences**, then **Download CSV** and **Download PDF**.

Also try the staff list (memberships, In the building, daily notes) if no one else covers it.

### Look for and report

- Families who should have been told about a closure, a date change, a change or a cancellation but weren't, or who were told twice.
- **Sent to**, **Delivered** or **Read** numbers that don't match what testers say they got.
- An emergency alert that didn't pop up for someone signed in, that someone could mute, or that stayed pinned after you ended it.
- Report numbers that don't match In the building, Daily notes or a parent's Hours.
- Anything that refused a change without saying why.

---

## Already known (no need to report)

- Students don't see daily notes, and a student holds one schedule per period. Both are on purpose in this version.
- A missed-day notice goes out only for a day with no check-in at all. A student who came to part of the day shows **Absent** in Hours for the part they missed, with no notice.
- After some buttons (**Refresh numbers**, **Cancel invite**, **Deactivate**), the screen jumps back to the top.
- The parent's check-out notification doesn't name the schedule (the check-in one does).
- Home's **Latest news** doesn't update by itself when a normal announcement arrives (emergency alerts do).
- Everyone is signed out if the test server restarts. Just sign in again.
