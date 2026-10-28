/* Check-in views (PRD 1, CI-1..CI-7):
   - student "Check in": camera scan with jsQR, one button for in and out; after a check-in it asks
     for today's goals through the notes API (/api/notes/goals/today, D-50)
   - #/scan/<locationId>/<code>: the link a phone camera opens from the entrance QR; finishes the scan
   - staff "In the building": here / expected / left, manual check-in and check-out, visits needing review
   - "Entrance QR": today's code full screen (or printed), refreshing itself
   - Home cards: student scan button + status, parent status per student, staff counts.
   The scan sends the code only: the app never asks for the phone's location (S-5, D-49, NF-5). */
(function () {
  'use strict';
  const { h } = App;
  const API = '/api/checkin';
  const EARLY_MS = 30 * 60000;

  // ---------- styles this module needs beyond app.css ----------
  document.head.append(h('style', null, `
    .ci-status { display: flex; gap: .75rem; align-items: center; }
    .ci-status .grow { flex: 1; min-width: 0; }
    .ci-result { text-align: center; padding: 18px 16px; }
    .ci-result .ci-big { display: block; font-size: 1.9rem; font-weight: 800; line-height: 1.15; margin: .1rem 0 .35rem; }
    .ci-result p { margin: 0 0 .5rem; }
    .ci-cam { position: relative; border-radius: var(--radius); overflow: hidden; background: #000; aspect-ratio: 1 / 1; width: 100%; max-width: 420px; margin: 0 auto 12px; }
    .ci-cam video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ci-cam .ci-frame { position: absolute; inset: 16%; border: 3px solid rgba(255,255,255,.9); border-radius: 18px; box-shadow: 0 0 0 999px rgba(0,0,0,.28); pointer-events: none; }
    .ci-stats { display: flex; gap: 12px 24px; flex-wrap: wrap; }
    .ci-qr-stage { display: flex; flex-direction: column; align-items: center; text-align: center; gap: .5rem; }
    .ci-qr-stage h1 { font-size: 1.8rem; margin: 0; }
    .ci-qr { background: #fff; padding: 12px; border-radius: var(--radius); width: min(100%, 62vh, 520px); }
    .ci-qr svg { display: block; width: 100%; height: auto; }
    .ci-qr-stage:fullscreen { background: #fff; color: #111; justify-content: center; padding: 24px; }
    .ci-qr-stage:fullscreen .muted { color: #444; }
    .ci-dialog { border: 1px solid var(--line); border-radius: var(--radius); padding: 0; width: min(calc(100vw - 32px), 440px); background: var(--surface); color: var(--text); }
    .ci-dialog::backdrop { background: rgba(15, 19, 27, .55); }
    .ci-dialog form { padding: 16px; }
    .ci-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
    .ci-hideable[hidden] { display: none !important; }
    @media print {
      body:has(.ci-qr-stage) #topbar, body:has(.ci-qr-stage) #nav, body:has(.ci-qr-stage) #devbar, .ci-noprint { display: none !important; }
      body:has(.ci-qr-stage) #main { padding: 0; }
    }
  `));

  // ---------- helpers ----------
  const first = name => String(name || '').split(' ')[0];
  const initials = name => String(name || '?').split(/\s+/).filter(Boolean).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const platform = () => (/iPhone|iPad|iPod/.test(navigator.userAgent) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'other');
  const outLabel = m => ({ scan: 'Scanned out', auto: 'Checked out automatically', staff: 'Checked out by staff' }[m] || '');
  const inLabel = m => (m === 'staff' ? 'Checked in by staff' : 'Scanned in');
  // 'Thu, Oct 15' in the given zone (App.fmtDate always uses the signed-in user's own zone).
  const fmtDay = (ms, tz) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }).format(ms);

  // The entrance QR encodes a link into the app: .../#/scan/<locationId>/<code>
  function parseScanLink(text) {
    const m = /#\/scan\/(\d+)\/([A-Za-z0-9_-]+)/.exec(String(text || ''));
    return m ? { locationId: Number(m[1]), code: m[2] } : null;
  }

  // One line about a student's day, for students and parents (times in the location's zone).
  function statusLine(s, you, now) {
    const tz = s.location.timezone, v = s.visit, n = s.next;
    if (s.state === 'here') {
      return (you ? "You're" : first(s.name) + ' is') + ` at ${s.location.name} since ${App.fmtTime(v.check_in_at, tz)}`
        + (v.session_name ? ` · ${v.session_name} until ${App.fmtTime(v.ends_at, tz)}` : '');
    }
    // "On now" only once the session has started; in the 30 minutes before (D-13) check-in is open but it hasn't begun.
    const nextText = !n ? '' : (n.start_at <= now && now <= n.end_at)
      ? `${n.session_name} is on now, until ${App.fmtTime(n.end_at, tz)}`
      : (n.opens_at <= now && now < n.start_at)
        ? `${n.session_name} starts at ${App.fmtTime(n.start_at, tz)} · check-in is open`
        : `Next session ${n.when} · ${n.session_name}`;
    if (s.state === 'left') {
      const how = v.checkout_method === 'auto' ? ' (checked out automatically)' : v.checkout_method === 'staff' ? ' (checked out by staff)' : '';
      return `Left at ${App.fmtTime(v.check_out_at, tz)}${how}` + (nextText ? ' · ' + nextText : '');
    }
    // A membership that hasn't started yet can't check in (R6), so no session is "on now" before then.
    if (s.starts_on) {
      const day = fmtDay(Date.parse(s.starts_on + 'T12:00:00Z'), 'UTC');
      return you ? `Your membership starts ${day}, so you can check in from then.` : `${first(s.name)}'s membership starts ${day}.`;
    }
    if (!nextText && s.paused) {
      return you ? `Your membership isn't active, so your sessions are paused. Ask a parent or the front desk at ${s.location.name} to renew it.`
        : `${first(s.name)}'s membership isn't active, so sessions are paused.`;
    }
    return nextText || (you ? 'No sessions coming up. Ask a parent to enroll you in one.' : 'No sessions coming up.');
  }
  function stateBadge(s) {
    if (s.state === 'here') return h('span', { class: 'badge badge-ok' }, 'Here');
    if (s.state === 'left') return h('span', { class: 'badge' }, 'Left');
    return h('span', { class: 'badge' }, 'Not in');
  }

  // ---------- camera permission help, named per phone ----------
  function cameraHelp() {
    const p = platform();
    if (p === 'ios') return ['Open Settings › Safari › Camera and choose "Allow" (or Settings › ELITE Spaces › Camera if you added it to your Home Screen).',
      'Come back here and tap Scan again.', 'Or open your phone\'s Camera app and point it at the code. It opens this app for you.'];
    if (p === 'android') return ['Tap the icon to the left of the web address, then Permissions › Camera › Allow.',
      'Come back here and tap Scan again.', 'Or open your phone\'s Camera app and point it at the code. It opens this app for you.'];
    return ['Allow the camera for this site in your browser\'s site settings, then tap Scan again.'];
  }

  // ---------- the scan panel (student Check in view and the #/scan link) ----------
  function scanPanel(el, { auto } = {}) {
    let status = null, now = App.now();
    let stopCamera = null;
    const statusBox = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading your status…'));
    const result = h('div', { role: 'status', 'aria-live': 'polite' });
    const camBox = h('div');
    const scanBtn = h('button', { class: 'btn btn-primary btn-lg btn-block ci-hideable', type: 'button', onclick: startCamera },
      h('span', { 'aria-hidden': 'true' }, '📷'), h('span', { class: 'ci-scan-label' }, 'Scan to check in'));
    // Staff can check a student in or out by hand; the line follows the button (check out while here).
    const helpLine = h('p', { class: 'muted small', style: 'margin:0' }, 'Having trouble? Ask staff at the front desk to check you in.');
    const devBtn = App.me && App.me.dev && h('button', { class: 'btn btn-block', type: 'button', onclick: simulate }, 'Simulate scan at my location (dev)');
    el.append(statusBox, result, camBox,
      h('div', { class: 'card' }, scanBtn,
        helpLine,
        devBtn && h('div', { style: 'margin-top:.75rem' }, devBtn)));

    async function loadStatus() {
      try {
        const r = await App.api.get(API + '/status');
        status = r.students[0] || null;
        now = r.now;
      } catch (e) { statusBox.replaceChildren(h('p', { class: 'notice notice-danger', style: 'margin:0' }, e.message)); return; }
      if (!status) return;
      statusBox.replaceChildren(h('div', { class: 'ci-status' },
        h('div', { class: 'grow' }, h('strong', null, status.state === 'here' ? "You're checked in" : status.state === 'left' ? "You've checked out" : 'Not checked in'),
          h('div', { class: 'muted small' }, statusLine(status, true, now))),
        stateBadge(status)));
      scanBtn.querySelector('.ci-scan-label').textContent = status.state === 'here' ? 'Scan to check out' : 'Scan to check in';
      // On a closure day (SC-3) there is nothing to check in to, so the line says so instead of offering staff (L31).
      const closed = status.closed_today && status.state !== 'here';
      helpLine.textContent = closed
        ? `${status.location.name} is closed today${status.closed_today.reason ? ` (${status.closed_today.reason})` : ''}. There are no sessions to check in to.`
        : `Having trouble? Ask staff at the front desk to check you ${status.state === 'here' ? 'out' : 'in'}.`;
    }

    function showError(title, text, { steps, retry } = {}) {
      result.replaceChildren(h('div', { class: 'card ci-result', role: 'alert' },
        h('div', { class: 'notice notice-danger', style: 'text-align:left' }, h('strong', null, title), h('div', null, text),
          steps && h('ol', null, steps.map(s => h('li', null, s)))),
        retry && h('button', { class: 'btn btn-block', type: 'button', onclick: retry }, 'Try again')));
    }
    function showSuccess(r) {
      const tz = r.location.timezone;
      const v = r.visit;
      const box = r.action === 'checkin'
        ? h('div', { class: 'notice notice-ok ci-result' },
          h('span', { class: 'ci-big' }, h('span', { 'aria-hidden': 'true' }, '✓ '), 'Checked in'),
          h('p', null, `${App.fmtTime(v.check_in_at, tz)} · ${r.session.name} · ends ${App.fmtTime(r.session.end_at, tz)}`),
          h('p', { class: 'small', style: 'margin:0' }, `${r.location.name}. Your parents have been told.`))
        : h('div', { class: 'notice notice-ok ci-result' },
          h('span', { class: 'ci-big' }, h('span', { 'aria-hidden': 'true' }, '✓ '), 'Checked out'),
          h('p', null, `${App.fmtTime(v.check_out_at, tz)}${r.session ? ' · ' + r.session.name : ''} · Total time ${App.fmtDuration(r.total_minutes)}`),
          h('p', { class: 'small', style: 'margin:0' }, `See you next time at ${r.location.name}.`));
      result.replaceChildren(box);
      box.setAttribute('tabindex', '-1');
      box.focus({ preventScroll: false });
      // After a check-in (never a check-out) the student is asked for today's goals (D-50, DG-3).
      if (r.action === 'checkin') askGoals();
    }
    // Today's goals, from the notes module: not answered -> set or skip; set -> the subjects and Edit.
    // A failed load shows nothing: the check-in itself already worked.
    async function askGoals() {
      const box = h('div', { class: 'card' });
      result.append(box);
      let g;
      try { g = await App.api.get('/api/notes/goals/today'); } catch (_) { box.remove(); return; }
      if (!box.isConnected) return;
      if (g.status === 'set') {
        box.append(h('p', { style: 'margin:0 0 .5rem' }, h('strong', null, "Today's goals: "), g.goals.map(x => x.subject_label).join(' · ')),
          h('a', { class: 'btn', href: '#/goals', 'aria-label': "Edit today's goals" }, 'Edit'));
        return;
      }
      if (g.status !== 'none') { box.remove(); return; }
      const skip = h('button', { class: 'btn', type: 'button', onclick: async e => {
        await App.run(e.currentTarget, async () => {
          await App.api.post('/api/notes/goals/today/skip', {});
          const done = h('p', { style: 'margin:0', tabindex: '-1' }, 'Skipped. You can still add goals from Home today.');
          box.replaceChildren(done);
          done.focus(); // the Skip button is gone, so focus stays on the answer
        });
      } }, 'Skip today');
      box.append(h('h2', null, 'What are you working on today?'),
        h('div', { class: 'ci-actions' }, h('a', { class: 'btn btn-primary', href: '#/goals' }, "Set today's goals"), skip));
    }
    // A second scan soon after checking in (or out) asks before undoing it.
    function askFirst(message, { yes, no, kept }, go) {
      result.replaceChildren(h('div', { class: 'card ci-result', role: 'alert' },
        h('p', null, h('strong', null, message)),
        h('div', { class: 'ci-actions', style: 'justify-content:center' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: go }, yes),
          h('button', { class: 'btn', type: 'button', onclick: () => result.replaceChildren(h('p', { class: 'notice' }, kept)) }, no))));
    }

    const TITLES = {
      code_expired: 'This code has expired', bad_code: "That code didn't work", wrong_location: 'This is a different location',
      no_session: 'No session right now', membership_inactive: "Your membership isn't active",
      location_closed: 'This location is closed', checked_out_auto: "You're already checked out", closed_today: 'Closed today',
    };

    // Send one scan: the code only (D-49).
    async function submit(target, confirm) {
      try {
        const r = await App.api.post(API + '/scan', { locationId: target.locationId, code: target.code, confirm: confirm || undefined });
        showSuccess(r);
        loadStatus();
      } catch (e) {
        if (e.code === 'confirm_checkout') return askFirst(e.message, { yes: 'Check out', no: 'Stay checked in', kept: "OK, you're still checked in." }, () => submit(target, true));
        if (e.code === 'confirm_checkin') return askFirst(e.message, { yes: 'Check back in', no: 'Stay checked out', kept: "OK, you're still checked out." }, () => submit(target, true));
        // After any refused scan the status card is refreshed so it matches the message; on a closure
        // day (which keeps the no_session code) it also says whether today is closed (L31).
        await loadStatus();
        const closed = e.code === 'no_session' && status && status.closed_today;
        showError(TITLES[closed ? 'closed_today' : e.code] || "We couldn't check you in", e.message);
      }
    }

    async function startCamera() {
      if (stopCamera) return;
      result.replaceChildren();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.jsQR) {
        return showError("This browser can't open the camera here", "Open your phone's Camera app and point it at the code by the entrance. It opens this app straight to check-in.");
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return showError('The camera is blocked for ELITE Spaces', 'We need the camera to read the code by the entrance.', { steps: cameraHelp(), retry: startCamera });
        if (e && e.name === 'NotFoundError') return showError("We couldn't find a camera", 'Ask staff at the front desk to check you in.');
        return showError("The camera didn't start", 'Close other apps using the camera and try again, or ask staff to check you in.', { retry: startCamera });
      }
      const video = h('video', { playsinline: true, muted: true, autoplay: true, 'aria-hidden': 'true' });
      video.muted = true;
      video.srcObject = stream;
      const hint = h('p', { class: 'muted small', role: 'status', style: 'text-align:center' }, 'Point your camera at the code by the entrance.');
      camBox.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'ci-cam' }, video, h('div', { class: 'ci-frame' })), hint,
        h('button', { class: 'btn btn-block', type: 'button', onclick: () => stopCamera && stopCamera() }, 'Cancel')));
      scanBtn.hidden = true;
      let live = true;
      stopCamera = () => {
        live = false;
        stream.getTracks().forEach(t => t.stop());
        camBox.replaceChildren();
        scanBtn.hidden = false;
        stopCamera = null;
      };
      try { await video.play(); } catch (_) { /* autoplay handles it */ }
      const canvas = document.createElement('canvas');
      const g = canvas.getContext('2d', { willReadFrequently: true });
      let warned = 0;
      const tick = () => {
        if (!live) return;
        if (!video.isConnected) return stopCamera && stopCamera();
        if (video.readyState >= 2 && video.videoWidth) {
          const scale = Math.min(1, 480 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          g.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = g.getImageData(0, 0, canvas.width, canvas.height);
          const found = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (found) {
            const target = parseScanLink(found.data);
            if (target) { stopCamera(); return submit(target); }
            if (Date.now() - warned > 3000) { warned = Date.now(); hint.textContent = "That isn't the ELITE Spaces code. Point at the code by the entrance."; }
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    async function simulate(e) {
      await App.run(e.currentTarget, async () => {
        const s = await App.api.get(API + '/dev/simulate');
        await submit({ locationId: s.locationId, code: s.code });
      });
    }

    loadStatus();
    if (auto) submit(auto);
  }

  App.register({
    id: 'checkin', title: 'Check in', icon: '📷', roles: ['student'], order: 10,
    async render(el) {
      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Check in'),
        h('p', null, 'Scan the code at the entrance when you arrive and again when you leave.'))));
      scanPanel(el);
    },
  });

  // The link a phone camera opens from the entrance QR. If the student was signed out,
  // the shell signs them in first and this route then finishes the same scan.
  App.register({
    id: 'scan', title: 'Check in', icon: '📷', nav: false, order: 91,
    async render(el, params) {
      const target = { locationId: Number(params[0]), code: String(params[1] || '') };
      if (App.role() !== 'student') {
        el.append(h('div', { class: 'card' }, h('h1', null, 'This code is for students'),
          h('p', null, App.isOps()
            ? 'Students scan this code with their own phone to check in and out. You can see who is here in In the building.'
            : 'Your student scans this code with their own phone to check in and out. You get a notification each time.'),
          App.isOps() && h('a', { class: 'btn btn-primary', href: '#/building' }, 'Open In the building')));
        return;
      }
      // A refresh of this page must not repeat the scan.
      history.replaceState(null, '', '#/checkin');
      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Check in'))));
      if (!target.locationId || !target.code) return scanPanel(el);
      scanPanel(el, { auto: target });
    },
  });

  // ---------- staff: In the building ----------
  const IN_REASONS = ['Phone is dead', 'Forgot phone', "Camera didn't work", 'Other'];
  const OUT_REASONS = ['Phone is dead', 'Forgot to scan out', 'Leaving early', 'Other'];

  // One reusable dialog for every check-in/out sheet. Closing it any way (Cancel, Escape, done)
  // empties it and takes it out of the page at once, so its fields and ids never linger or repeat.
  const sheetDlg = h('dialog', { class: 'ci-dialog', 'aria-labelledby': 'ci-dlg-title' });
  function closeSheet() {
    if (sheetDlg.open) sheetDlg.close();
    sheetDlg.replaceChildren();
    sheetDlg.remove();
  }
  // Escape closes the dialog natively. The close event arrives later, so skip it if the sheet has opened again.
  sheetDlg.addEventListener('close', () => { if (!sheetDlg.open) closeSheet(); });

  // A confirm sheet that names the student and the action, with an optional reason (CI-7).
  // "Other" opens a short text box; what staff type there is saved as the reason.
  function confirmSheet({ title, warn, confirmLabel, reasons, onConfirm }) {
    closeSheet();
    const reason = h('select', { id: 'ci-reason' }, h('option', { value: '' }, 'No reason given'), reasons.map(r => h('option', { value: r }, r)));
    const other = h('input', { type: 'text', id: 'ci-reason-other', maxlength: 100, autocomplete: 'off' });
    const otherField = h('label', { class: 'field ci-hideable', for: 'ci-reason-other', hidden: true }, h('span', null, 'What happened?'), other);
    reason.addEventListener('change', () => {
      otherField.hidden = reason.value !== 'Other';
      if (!otherField.hidden) other.focus();
    });
    const warnBox = h('div');
    const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, confirmLabel);
    const setWarn = text => warnBox.replaceChildren(text ? h('div', { class: 'notice notice-warn' }, text) : '');
    setWarn(warn);
    sheetDlg.replaceChildren(
      h('form', { onsubmit: async ev => {
        ev.preventDefault();
        const why = reason.value === 'Other' ? other.value.trim() || 'Other' : reason.value;
        await App.run(btn, async () => {
          const done = await onConfirm(why, { setWarn, setLabel: t => { btn.textContent = t; } });
          if (done !== false) closeSheet();
        });
      } },
      h('h2', { id: 'ci-dlg-title' }, title),
      warnBox,
      h('label', { class: 'field', for: 'ci-reason' }, h('span', null, 'Reason (optional)'), reason),
      otherField,
      h('p', { class: 'muted small' }, 'This is saved with your name.'),
      h('div', { class: 'ci-actions' }, btn, h('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Cancel'))));
    document.body.append(sheetDlg);
    sheetDlg.showModal();
  }

  // Why staff are about to check someone in anyway: an inactive membership, no session open now, or both.
  function overrideWarn(name, membershipActive, sessionWarn) {
    if (membershipActive !== false) return sessionWarn;
    return `${first(name)}'s membership isn't active.` + (sessionWarn ? ' ' + sessionWarn : ' Check in anyway?');
  }
  // "Checked in by Chris Ortiz · Phone is dead" for a manual entry.
  const byLine = (verb, name, reason) => `${verb} by ${name || 'staff'}` + (reason ? ' · ' + reason : '');
  const inLine = v => (v.checkin_method === 'staff' ? byLine('Checked in', v.checked_in_by_name, v.checkin_reason) : inLabel(v.checkin_method));
  const outLine = v => (v.checkout_method === 'staff' ? byLine('Checked out', v.checked_out_by_name, v.checkout_reason) : outLabel(v.checkout_method));
  // 'HH:MM' (24-hour) in the location's zone, the value a time input takes.
  const hhmm = (ms, tz) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(ms);

  function manualCheckin(student, { override, warn, after }) {
    confirmSheet({
      title: `Check in ${student.name}?`, warn, reasons: IN_REASONS,
      confirmLabel: override ? 'Check in anyway' : 'Check in',
      async onConfirm(reason, sheet) {
        try {
          await App.api.post(API + '/manual-checkin', { studentId: student.id, reason: reason || undefined, override: override || undefined });
        } catch (e) {
          if (e.code !== 'no_session' && e.code !== 'membership_inactive') throw e;
          override = true; // no session or an inactive membership after all: say so and ask once more
          sheet.setWarn(e.message);
          sheet.setLabel('Check in anyway');
          return false;
        }
        App.toast(`${first(student.name)} is checked in.`);
        after();
      },
    });
  }
  function manualCheckout(visitId, name, after) {
    confirmSheet({
      title: `Check out ${name}?`, reasons: OUT_REASONS, confirmLabel: 'Check out',
      async onConfirm(reason) {
        await App.api.post(`${API}/visits/${visitId}/checkout`, { reason: reason || undefined });
        App.toast(`${first(name)} is checked out.`);
        after();
      },
    });
  }

  App.register({
    id: 'building', title: 'In the building', icon: '🏫', roles: ['staff'], order: 10,
    async render(el, params) {
      let locId = Number(params[0]) || App.me.user.location_id;
      let picker = null;
      if (App.role() === 'hq') {
        const { locations } = await App.api.get('/api/locations');
        if (!locations.length) return el.append(h('div', { class: 'card empty' }, 'There are no locations yet.'));
        if (!locations.some(l => l.id === locId)) locId = locations[0].id;
        const sel = h('select', { id: 'ci-loc', onchange: () => App.go('building', sel.value) },
          locations.map(l => h('option', { value: l.id, selected: l.id === locId }, l.name)));
        picker = h('label', { class: 'field', for: 'ci-loc', style: 'margin:0;min-width:200px' }, h('span', null, 'Location'), sel);
      }
      const sub = h('p');
      el.append(h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'In the building'), sub),
        h('div', { class: 'row' }, picker, h('a', { class: 'btn', href: '#/entrance-qr/' + locId }, h('span', { 'aria-hidden': 'true' }, '🔳'), 'Entrance QR'))));
      const live = h('div');
      el.append(live);

      // ---- find a student (manual check-in) ----
      const q = h('input', { type: 'search', id: 'ci-find', autocomplete: 'off', placeholder: 'Start typing a name' });
      const found = h('ul', { class: 'list' });
      let tz = App.tz();
      let timer = null;
      async function search() {
        const { students } = await App.api.get(`${API}/locations/${locId}/students?q=${encodeURIComponent(q.value.trim())}`);
        if (!students.length) return found.replaceChildren(h('li', { class: 'muted' }, `No students match "${q.value.trim()}".`));
        found.replaceChildren(...students.map(s => h('li', null,
          h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(s.name)),
          h('div', { class: 'grow' }, h('strong', null, s.name), h('div', { class: 'muted small' },
            s.here ? `Here since ${App.fmtTime(s.since, tz)}` : !s.approved ? 'Waiting for a parent to approve the account'
              : s.session_now ? `Has ${s.session_now.name} now` : 'No session right now')),
          // A student no parent has approved yet can't be checked in (D-20), so there is no button.
          !s.here && !s.approved ? null : s.here
            ? h('button', { class: 'btn', type: 'button', 'aria-label': `Check out ${s.name}`, onclick: () => manualCheckout(s.visit_id, s.name, reload) }, 'Check out')
            : h('button', { class: 'btn', type: 'button', 'aria-label': `Check in ${s.name}`,
              onclick: () => manualCheckin(s, { override: !s.session_now || !s.membership_active, after: reload,
                warn: overrideWarn(s.name, s.membership_active, s.session_now ? null : `${first(s.name)} doesn't have a session right now. You can still check them in.`) }) }, 'Check in'))));
      }
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search().catch(e => App.toast(e.message, 'error')), 250); });
      el.append(h('section', { class: 'card', 'aria-labelledby': 'ci-find-h' },
        h('h2', { id: 'ci-find-h' }, 'Check someone in or out by hand'),
        h('p', { class: 'muted small' }, 'For a dead phone, a failed scan, or a student without a session right now. Every manual entry is saved with your name.'),
        h('label', { class: 'field', for: 'ci-find' }, h('span', null, 'Student name'), q),
        found));

      async function reload() {
        let d;
        try { d = await App.api.get(`${API}/locations/${locId}/building`); } catch (e) { App.toast(e.message, 'error'); return; }
        tz = d.location.timezone;
        sub.textContent = `${d.location.name} · ${App.fmtDate(d.today)} · updated ${App.fmtTime(d.now, tz)}`;
        live.replaceChildren(stats(d), review(d), here(d), expected(d), left(d));
        if (q.value.trim()) search().catch(() => {});
      }

      const stat = (n, label) => h('div', null, h('div', { class: 'stat' }, n), h('div', { class: 'stat-label' }, label));
      function stats(d) {
        return h('div', { class: 'card' }, h('div', { class: 'ci-stats' },
          stat(d.here.length, 'in the building'), stat(d.expected.length, 'still expected'), stat(d.left.length, 'left today'),
          d.needs_review.length ? stat(d.needs_review.length, 'need review') : null),
          h('p', { class: 'muted small', style: 'margin:.5rem 0 0' }, 'This list refreshes on its own.'));
      }

      function review(d) {
        if (!d.needs_review.length) return '';
        return h('section', { class: 'card', 'aria-labelledby': 'ci-rev-h' },
          h('h2', { id: 'ci-rev-h' }, h('span', { class: 'badge badge-warn' }, 'Needs review'), ' ', plural(d.needs_review.length, 'visit', 'visits') + ' to check'),
          h('p', { class: 'muted small' }, "These students didn't scan out, so the app checked them out automatically. Confirm the time, or set the real time out."),
          h('ul', { class: 'list' }, d.needs_review.map(v => {
            // Starts at the automatic time out (the session end or closing time), so staff only adjust it.
            const time = h('input', { type: 'time', id: 'ci-out-' + v.visit_id, required: true, value: v.check_out_at != null ? hhmm(v.check_out_at, tz) : null });
            const fix = h('form', { class: 'row ci-hideable', hidden: true, style: 'margin-top:.5rem', onsubmit: async ev => {
              ev.preventDefault();
              await App.run(ev.submitter, async () => {
                const r = await App.api.post(`${API}/visits/${v.visit_id}/review`, { out_time: time.value });
                // An unchanged time is confirmed as it was (still automatic), the same as "Time is right".
                App.toast(r.visit.checkout_method === v.checkout_method && r.visit.check_out_at === v.check_out_at
                  ? `Marked ${first(v.name)}'s visit reviewed.` : `Saved ${first(v.name)}'s time out.`);
                reload();
              });
            } },
            h('label', { class: 'field', for: 'ci-out-' + v.visit_id, style: 'margin:0' }, h('span', null, 'Actual time out'), time),
            h('button', { class: 'btn btn-primary', type: 'submit', style: 'align-self:flex-end' }, 'Save time out'));
            return h('li', { style: 'flex-wrap:wrap' },
              h('div', { class: 'grow' }, h('strong', null, v.name),
                h('div', { class: 'muted small' }, `${App.fmtDate(v.local_date)} · ${v.session_name || 'No session'} · in ${App.fmtTime(v.check_in_at, tz)} · out ${App.fmtTime(v.check_out_at, tz)}`
                  + (v.checkout_method === 'auto' ? ' (automatic)' : '')),
                v.checkin_method === 'staff' && h('div', { class: 'muted small' }, inLine(v)),
                v.checkout_method === 'staff' && h('div', { class: 'muted small' }, outLine(v)),
                v.flag_reason && h('div', { class: 'small' }, v.flag_reason), fix),
              h('div', { class: 'ci-actions' },
                h('button', { class: 'btn', type: 'button', 'aria-label': `Time is right for ${v.name}`, onclick: async e => {
                  await App.run(e.currentTarget, async () => {
                    await App.api.post(`${API}/visits/${v.visit_id}/review`, {});
                    App.toast(`Marked ${first(v.name)}'s visit reviewed.`);
                    reload();
                  });
                } }, 'Time is right'),
                h('button', { class: 'btn', type: 'button', 'aria-label': `Fix time out for ${v.name}`, 'aria-expanded': 'false', onclick: e => {
                  fix.hidden = !fix.hidden;
                  e.currentTarget.setAttribute('aria-expanded', String(!fix.hidden));
                  if (!fix.hidden) time.focus();
                } }, 'Fix time out')));
          })));
      }

      function here(d) {
        return h('section', { class: 'card', 'aria-labelledby': 'ci-here-h' },
          h('h2', { id: 'ci-here-h' }, `Here · ${d.here.length}`),
          d.here.length ? h('ul', { class: 'list' }, d.here.map(v => h('li', null,
            h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(v.name)),
            h('div', { class: 'grow' }, h('strong', null, v.name),
              h('div', { class: 'muted small' }, `${v.session_name || 'No session'} · in at ${App.fmtTime(v.check_in_at, tz)} · ${inLine(v)}`)),
            h('button', { class: 'btn', type: 'button', 'aria-label': `Check out ${v.name}`, onclick: () => manualCheckout(v.visit_id, v.name, reload) }, 'Check out'))))
            : h('p', { class: 'empty', style: 'padding:1rem' }, d.left.length ? 'Nobody is in the building right now.' : "Nobody's checked in yet today."));
      }

      function expected(d) {
        return h('section', { class: 'card', 'aria-labelledby': 'ci-exp-h' },
          h('h2', { id: 'ci-exp-h' }, `Expected, not here yet · ${d.expected.length}`),
          d.expected.length ? h('ul', { class: 'list' }, d.expected.map(x => {
            const open = d.now >= x.start_at - EARLY_MS && d.now <= x.end_at;
            return h('li', null,
              h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(x.name)),
              h('div', { class: 'grow' }, h('strong', null, x.name),
                h('div', { class: 'muted small' }, `${x.session_name} · ${d.now >= x.start_at ? 'started' : 'starts'} ${App.fmtTime(x.start_at, tz)}`)),
              h('button', { class: 'btn', type: 'button', 'aria-label': `Check in ${x.name}`,
                onclick: () => manualCheckin({ id: x.student_id, name: x.name }, {
                  override: !open || !x.membership_active, after: reload,
                  warn: overrideWarn(x.name, x.membership_active, open ? null : `${first(x.name)}'s ${x.session_name} doesn't open for check-in until ${App.fmtTime(x.start_at - EARLY_MS, tz)}. You can still check them in now.`),
                }) }, 'Check in'));
          })) : h('p', { class: 'empty', style: 'padding:1rem' }, 'No one else is expected today.'));
      }

      function left(d) {
        return h('section', { class: 'card', 'aria-labelledby': 'ci-left-h' },
          h('h2', { id: 'ci-left-h' }, `Left today · ${d.left.length}`),
          d.left.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['Student', 'Session', 'In', 'Out', 'How they left'].map(c => h('th', { scope: 'col' }, c)))),
            h('tbody', null, d.left.map(v => h('tr', null,
              h('td', null, v.name), h('td', null, v.session_name || 'No session'),
              h('td', null, App.fmtTime(v.check_in_at, tz), v.checkin_method === 'staff' && h('div', { class: 'muted small' }, inLine(v))),
              h('td', null, App.fmtTime(v.check_out_at, tz)),
              h('td', null, v.checkout_method === 'auto' ? h('span', { class: 'badge badge-warn' }, outLabel(v.checkout_method)) : outLine(v)))))))
            : h('p', { class: 'empty', style: 'padding:1rem' }, 'No one has left yet today.'));
      }

      await reload();
      // Live list: refresh while this view is on screen, but never under someone who is
      // typing a time out, has a fix form open, or has a confirm sheet up.
      const editing = () => (live.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName))
        || !!live.querySelector('form.ci-hideable:not([hidden])')
        || !!document.querySelector('dialog.ci-dialog[open]');
      const tick = setInterval(() => {
        if (!el.isConnected) return clearInterval(tick);
        if (!document.hidden && !editing()) reload();
      }, 15000);
    },
  });

  // ---------- staff: Entrance QR (full screen, printable, refreshes itself) ----------
  App.register({
    id: 'entrance-qr', title: 'Entrance QR', icon: '🔳', roles: ['staff'], nav: false, order: 92,
    async render(el, params) {
      const locId = Number(params[0]) || App.me.user.location_id;
      if (!locId) {
        el.append(h('div', { class: 'card' }, h('h1', null, 'Entrance QR'), h('p', null, 'Choose a location in In the building first.'),
          h('a', { class: 'btn btn-primary', href: '#/building' }, 'Open In the building')));
        return;
      }
      let data = await App.api.get(`${API}/locations/${locId}/qr`);
      const stage = h('div', { class: 'ci-qr-stage' });
      const draw = () => {
        const tz = data.location.timezone;
        const until = `${fmtDay(data.valid_until, tz)}, ${App.fmtTime(data.valid_until, tz)}`;
        stage.replaceChildren(
          h('h1', null, data.location.name),
          h('p', { style: 'font-size:1.2rem;font-weight:600;margin:0' }, 'Students: scan to check in or out'),
          h('div', { class: 'ci-qr', role: 'img', 'aria-label': `Check-in code for ${data.location.name}, good until ${until}`, html: data.svg }),
          h('p', { style: 'margin:0' }, `Today's code · good until ${until}`),
          h('p', { class: 'muted small' }, 'The code changes every day. This screen updates on its own, so a printed copy only works until the time above.'));
      };
      draw();
      el.append(
        h('div', { class: 'row between ci-noprint', style: 'margin-bottom:12px' },
          h('a', { class: 'btn', href: '#/building/' + locId }, '← In the building'),
          h('div', { class: 'ci-actions' },
            stage.requestFullscreen && h('button', { class: 'btn btn-primary', type: 'button', onclick: () => stage.requestFullscreen().catch(e => App.toast(e.message, 'error')) }, 'Full screen'),
            h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print'))),
        stage);
      const tick = setInterval(async () => {
        if (!stage.isConnected) return clearInterval(tick);
        try {
          const next = await App.api.get(`${API}/locations/${locId}/qr`);
          if (next.code !== data.code || next.valid_until !== data.valid_until) { data = next; draw(); }
        } catch (_) { /* keep showing the last code; try again next minute */ }
      }, 60000);
    },
  });

  // ---------- Inbox links for check-in notifications (ref_type 'visit') ----------
  // The first route the signed-in role can open wins: a parent's check-out (or automatic
  // check-out) opens Hours, staff open In the building, and a parent's check-in opens Home,
  // whose Today card shows where the student is now.
  App.inboxLink('visit', n => (n.kind === 'checkin' ? null : 'hours'));
  App.inboxLink('visit', 'building');
  App.inboxLink('visit', 'home');

  // ---------- Home cards ----------
  App.card({
    id: 'checkin-student', roles: ['student'], order: 10,
    async render(box) {
      const { students, now } = await App.api.get(API + '/status');
      const s = students[0];
      if (!s) return;
      box.append(h('div', { class: 'card' },
        h('div', { class: 'ci-status', style: 'margin-bottom:.75rem' },
          h('div', { class: 'grow' }, h('strong', null, s.state === 'here' ? "You're checked in" : s.state === 'left' ? "You've checked out" : 'Not checked in'),
            h('div', { class: 'muted small' }, statusLine(s, true, now))),
          stateBadge(s)),
        h('a', { class: 'btn btn-primary btn-lg btn-block', href: '#/checkin' },
          h('span', { 'aria-hidden': 'true' }, '📷'), s.state === 'here' ? 'Scan to check out' : 'Scan to check in')));
    },
  });

  App.card({
    id: 'checkin-parent', roles: ['parent'], order: 10,
    async render(box) {
      const { students, now } = await App.api.get(API + '/status');
      if (!students.length) {
        box.append(h('div', { class: 'card' }, h('h2', null, 'Today'),
          h('p', { class: 'muted', style: 'margin:0' }, "Once your student's account is linked, you'll see here each time they check in and out.")));
        return;
      }
      box.append(h('section', { class: 'card', 'aria-labelledby': 'ci-today-h' }, h('h2', { id: 'ci-today-h' }, 'Today'),
        h('ul', { class: 'list' }, students.map(s => h('li', null,
          h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(s.name)),
          h('div', { class: 'grow' }, h('strong', null, s.name), h('div', { class: 'muted small' }, statusLine(s, false, now))),
          stateBadge(s))))));
    },
  });

  App.card({
    id: 'checkin-staff', roles: ['staff'], order: 10,
    async render(box) {
      const locId = App.me.user.location_id;
      if (!locId) {
        box.append(h('div', { class: 'card' }, h('h2', null, 'In the building'),
          h('p', { class: 'muted' }, "Pick a location to see who's there right now."),
          h('a', { class: 'btn', href: '#/building' }, 'Open In the building')));
        return;
      }
      const d = await App.api.get(`${API}/locations/${locId}/building`);
      box.append(h('section', { class: 'card', 'aria-labelledby': 'ci-home-h' },
        h('h2', { id: 'ci-home-h' }, 'In the building'),
        h('div', { class: 'ci-stats', style: 'margin-bottom:.75rem' },
          h('div', null, h('div', { class: 'stat' }, d.here.length), h('div', { class: 'stat-label' }, 'here now')),
          h('div', null, h('div', { class: 'stat' }, d.expected.length), h('div', { class: 'stat-label' }, 'still expected'))),
        d.needs_review.length ? h('p', null, h('span', { class: 'badge badge-warn' }, 'Needs review'), ' ',
          plural(d.needs_review.length, 'visit', 'visits') + " didn't scan out.") : null,
        h('a', { class: 'btn btn-primary', href: '#/building' }, 'Open In the building')));
    },
  });
})();
