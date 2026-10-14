/* accounts views (AC-1..AC-6).
   - Sign-in screen extras: "New family? Create an account" and "Have an invite code?",
     plus #/invite/<code> links opened while signed out.
   - Family (parents): students and their link state, invite a student, approve,
     invite a second guardian, change password.
   - People (staff, directors, HQ): the roster of students with their parents,
     staff accounts (directors and HQ), a director's own location settings, my account.
   - Locations (HQ): every location, its settings and its directors.
   - Home cards: students waiting for a parent's approval; a nudge to replace a
     temporary password. */
(function () {
  'use strict';
  const { h } = App;
  const A = '/api/accounts';

  // ---------- small helpers ----------
  let seq = 0;
  const nid = p => 'ac-' + p + '-' + (++seq);
  const first = name => String(name || '').trim().split(/\s+/)[0] || '';
  const initial = name => (String(name || '?').trim()[0] || '?').toUpperCase();
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const input = (type, attrs) => h('input', Object.assign({ type }, attrs || {}));
  const avatar = name => h('div', { class: 'avatar', 'aria-hidden': 'true' }, initial(name));
  const badge = (cls, text) => h('span', { class: 'badge' + (cls ? ' ' + cls : '') }, text);

  // A labelled control; the hint is tied to it with aria-describedby.
  function field(label, control, hint) {
    const id = control.id || (control.id = nid('f'));
    const kids = [h('span', null, h('label', { for: id }, label)), control];
    if (hint) {
      control.setAttribute('aria-describedby', id + '-hint');
      kids.push(h('div', { class: 'hint', id: id + '-hint' }, hint));
    }
    return h('div', { class: 'field' }, ...kids);
  }

  function pageHead(title, sub, ...actions) {
    return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub && h('p', null, sub)), ...actions);
  }

  // Form submit: the submit button is disabled while it runs, and an API error
  // is shown inside the form (role=alert) where the person is looking.
  function onSubmit(form, err, fn) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.replaceChildren();
      const btn = form.querySelector('button[type=submit]');
      if (btn) btn.disabled = true;
      try { await fn(); } catch (x) { err.replaceChildren(h('div', { class: 'notice notice-danger' }, x.message)); }
      finally { if (btn) btn.disabled = false; }
    });
  }
  const alertBox = () => h('div', { role: 'alert' });

  function copyButton(label, text) {
    return h('button', { class: 'btn', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(text); App.toast('Copied.'); }
      catch (_) { App.toast("Couldn't copy. Select the text and copy it yourself.", 'error'); }
    } }, label);
  }

  // Buttons that each open their own form into one shared slot (one at a time).
  function slotButtons(slot, defs) {
    const btns = defs.map(([label, build, cls]) => h('button', { class: 'btn' + (cls ? ' ' + cls : ''), type: 'button', 'aria-expanded': 'false' }, label));
    btns.forEach((b, i) => b.addEventListener('click', () => {
      const open = b.getAttribute('aria-expanded') === 'true';
      btns.forEach(x => x.setAttribute('aria-expanded', 'false'));
      slot.replaceChildren();
      if (open) return;
      b.setAttribute('aria-expanded', 'true');
      slot.append(defs[i][1](() => { b.setAttribute('aria-expanded', 'false'); slot.replaceChildren(); b.focus(); }));
      const f = slot.querySelector('input, select, textarea');
      if (f) f.focus();
    }));
    return btns;
  }

  // Swap `slot`'s content for a one-sentence confirmation that names the consequence.
  function confirmIn(slot, message, yesLabel, noLabel, fn) {
    const before = [...slot.childNodes];
    const yes = h('button', { class: 'btn btn-danger', type: 'button', onclick: e => App.run(e.currentTarget, fn) }, yesLabel);
    const no = h('button', { class: 'btn', type: 'button', onclick: () => { slot.replaceChildren(...before); } }, noLabel);
    slot.replaceChildren(h('div', { class: 'notice notice-warn', role: 'group', 'aria-label': yesLabel },
      h('p', null, message), h('div', { class: 'row' }, yes, no)));
    yes.focus();
  }

  // A few things survive one re-render (an invite code, a temporary password):
  // they are shown once, right after the action that made them.
  let flash = null;
  const takeFlash = kind => { if (!flash || flash.kind !== kind) return null; const f = flash; flash = null; return f; };
  const focusSoon = id => setTimeout(() => { const n = document.getElementById(id); if (n) n.focus(); }, 0);

  // Small layout rules app.css doesn't have: a facts list and a monospace code.
  if (!document.getElementById('ac-style')) {
    document.head.append(h('style', { id: 'ac-style' }, `
      .ac-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: .6rem 1rem; margin: 0 0 1rem; }
      .ac-facts dt { font-size: .8rem; color: var(--muted); }
      .ac-facts dd { margin: 0; font-weight: 600; }
      .ac-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .08em; overflow-wrap: anywhere; margin: .25rem 0 .75rem; }
      .ac-section { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: 1rem; }
    `));
  }

  // ---------- time zones offered when HQ sets up a location ----------
  const ZONES = [
    ['America/Los_Angeles', 'Pacific time (Los Angeles)'], ['America/Vancouver', 'Pacific time (Vancouver)'],
    ['America/Phoenix', 'Arizona time (Phoenix)'], ['America/Denver', 'Mountain time (Denver)'],
    ['America/Edmonton', 'Mountain time (Calgary, Edmonton)'], ['America/Chicago', 'Central time (Chicago, Dallas)'],
    ['America/Winnipeg', 'Central time (Winnipeg)'], ['America/New_York', 'Eastern time (New York, Atlanta)'],
    ['America/Toronto', 'Eastern time (Toronto, Montreal)'], ['America/Halifax', 'Atlantic time (Halifax)'],
    ['America/St_Johns', "Newfoundland time (St. John's)"], ['America/Anchorage', 'Alaska time (Anchorage)'],
    ['Pacific/Honolulu', 'Hawaii time (Honolulu)'],
  ];
  const zoneLabel = z => (ZONES.find(x => x[0] === z) || [z, z])[1];

  // =====================================================================
  // Signed out: create a family account, or open an invite
  // =====================================================================

  function enterApp(view) {
    history.replaceState(null, '', '#/' + view);
    App.boot();
  }

  App.signInExtras.push(wrap => {
    const form = wrap.querySelector('form');
    if (!form) return;
    const panel = h('div');
    const more = h('div', { class: 'card stack' },
      h('button', { class: 'btn btn-block', type: 'button', onclick: () => open(signupPanel) }, 'New family? Create an account'),
      h('button', { class: 'btn btn-block', type: 'button', onclick: () => open(back => invitePanel('', back)) }, 'Have an invite code?'));
    form.after(panel, more);
    function open(build) {
      form.style.display = 'none';
      more.style.display = 'none';
      panel.replaceChildren(build(back));
      const f = panel.querySelector('input, select');
      if (f && panel.isConnected) f.focus();
    }
    function back() {
      form.style.display = '';
      more.style.display = '';
      panel.replaceChildren();
      if (/^#\/invite\//.test(location.hash)) history.replaceState(null, '', '#/');
      const f = form.querySelector('input');
      if (f) f.focus();
    }
    const m = location.hash.match(/^#\/invite\/([^/?#]+)/);
    if (m) open(b => invitePanel(decodeURIComponent(m[1]), b));
  });

  function signupPanel(back) {
    const name = input('text', { autocomplete: 'name', required: true, maxlength: 80 });
    const email = input('email', { autocomplete: 'email', required: true });
    const phone = input('tel', { autocomplete: 'tel', required: true });
    const pw = input('password', { autocomplete: 'new-password', required: true, minlength: 8 });
    const loc = h('select', { required: true }, h('option', { value: '' }, 'Loading locations…'));
    App.api.get(A + '/public/locations')
      .then(({ locations }) => loc.replaceChildren(
        h('option', { value: '' }, locations.length ? 'Choose a location' : 'No locations are open yet'),
        ...locations.map(l => h('option', { value: l.id }, l.name))))
      .catch(() => loc.replaceChildren(h('option', { value: '' }, "Couldn't load locations. Go back and try again.")));
    const err = alertBox();
    const form = h('form', { class: 'card' },
      h('h2', null, 'Create your family account'),
      h('p', { class: 'muted small' }, "You'll be the account holder. Next you'll invite your students, and you can add a second guardian any time."),
      err,
      field('Your full name', name),
      field('Email', email, "You'll sign in with this."),
      field('Mobile phone', phone, 'So your location can reach you.'),
      field('Password', pw, 'At least 8 characters.'),
      field('Home location', loc, 'The ELITE Spaces center your students attend.'),
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create account'),
      h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: back }, 'Back to sign in'));
    onSubmit(form, err, async () => {
      await App.api.post(A + '/signup', { name: name.value, email: email.value, phone: phone.value, password: pw.value, location_id: Number(loc.value) || null });
      flash = { kind: 'welcome' };
      enterApp('family');
    });
    return form;
  }

  function invitePanel(code, back) {
    const box = h('div');
    const codeIn = input('text', { autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', required: true, maxlength: 20, value: code || '' });
    const err = alertBox();
    const form = h('form', { class: 'card' },
      h('h2', null, 'Open your invite'),
      h('p', { class: 'muted small' }, 'Enter the code a parent or guardian shared with you.'),
      err,
      field('Invite code', codeIn, 'It looks like ABCD-EFGH.'),
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Continue'),
      h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: back }, 'Back to sign in'));
    async function look() {
      const c = codeIn.value.trim();
      const { invite } = await App.api.get(A + '/invites/' + encodeURIComponent(c));
      box.replaceChildren(acceptPanel(c, invite, back));
      const f = box.querySelector('input');
      if (f) f.focus();
    }
    onSubmit(form, err, look);
    box.append(form);
    if (code) look().catch(x => err.replaceChildren(h('div', { class: 'notice notice-danger' }, x.message)));
    return box;
  }

  function acceptPanel(code, inv, back) {
    const student = inv.kind === 'student';
    const where = inv.location ? ' at ' + inv.location : '';
    const err = alertBox();
    const pw = input('password', { autocomplete: 'new-password', required: true, minlength: 8 });
    const email = student && inv.needs_email ? input('email', { autocomplete: 'email', required: true }) : null;
    const name = student ? null : input('text', { autocomplete: 'name', required: true, maxlength: 80, value: inv.name });
    const phone = student ? null : input('tel', { autocomplete: 'tel' });
    const form = h('form', { class: 'card' },
      h('h2', null, student ? 'Welcome, ' + first(inv.name) : 'Join ' + first(inv.invited_by) + "'s family"),
      h('p', null, student
        ? `${inv.invited_by} invited you to ELITE Spaces${where}. Choose a password to finish your account.`
        : `${inv.invited_by} invited you to ELITE Spaces${where}. You'll see the same students and records they do, and get the same notifications.`),
      inv.email && h('p', { class: 'muted small' }, 'Your account uses the email this invite was sent to: ' + inv.email),
      err,
      name && field('Your full name', name),
      email && field('Your email', email, "You'll sign in with this."),
      phone && field('Mobile phone (optional)', phone, 'So your location can reach you.'),
      field('Choose a password', pw, 'At least 8 characters.'),
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, student ? 'Finish my account' : 'Join the family'),
      !student && h('p', { class: 'muted small', style: 'margin:.75rem 0' }, 'Already have an ELITE Spaces account with that email? Sign in first, then open this invite link again.'),
      h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: back }, 'Back to sign in'));
    onSubmit(form, err, async () => {
      const body = { code, password: pw.value };
      if (email) body.email = email.value;
      if (name) { body.name = name.value; body.phone = phone.value; }
      const r = await App.api.post(A + '/invites/accept', body);
      if (r.kind === 'guardian') { flash = { kind: 'joined' }; return enterApp('family'); }
      const done = h('div', { class: 'card', role: 'status', tabindex: '-1' },
        h('h2', null, "You're almost in"),
        h('p', null, `We've let ${first(inv.invited_by)} know. Once they approve your account, sign in with ${r.email} and the password you just chose.`),
        h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: back }, 'Go to sign in'));
      form.replaceWith(done);
      done.focus();
    });
    return form;
  }

  // Signed in and opening an invite link: an existing parent can join that family.
  App.register({
    id: 'invite', title: 'Invite', icon: '✉️', order: 99, nav: false,
    async render(el, params) {
      const code = params[0] || '';
      el.append(pageHead('Your invite'));
      let inv;
      try { inv = (await App.api.get(A + '/invites/' + encodeURIComponent(code))).invite; }
      catch (e) { el.append(h('div', { class: 'card' }, h('p', null, e.message), h('a', { class: 'btn', href: '#/home' }, 'Go to Home'))); return; }
      const me = App.me.user;
      if (inv.kind === 'guardian' && me.role === 'parent') {
        const join = h('button', { class: 'btn btn-primary', type: 'button', onclick: async e => {
          const r = await App.run(e.currentTarget, () => App.api.post(A + '/invites/join', { code }));
          if (r) { flash = { kind: 'joined' }; App.go('family'); }
        } }, 'Join the family');
        el.append(h('div', { class: 'card' },
          h('h2', null, 'Join ' + first(inv.invited_by) + "'s family"),
          h('p', null, `You'll see the same students and records as ${inv.invited_by}, and get the same notifications. Students already on your account stay as they are.`),
          h('p', { class: 'muted small' }, 'This invite was sent to ' + inv.email + '.'),
          h('div', { class: 'row' }, join, h('a', { class: 'btn btn-ghost', href: '#/home' }, 'Not now'))));
        return;
      }
      const forStudent = inv.kind === 'student';
      el.append(h('div', { class: 'card' },
        h('p', null, forStudent
          ? `This invite is for ${inv.name}. They should open it on their own phone. You're signed in as ${me.name}.`
          : `This invite is for a parent or guardian. You're signed in as ${me.name}, so sign out first to use it.`),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: async () => { await App.api.post('/api/auth/logout').catch(() => {}); location.reload(); } }, 'Sign out and use this invite'),
          h('a', { class: 'btn btn-ghost', href: '#/home' }, 'Go to Home'))));
    },
  });

  // =====================================================================
  // Parents: Family
  // =====================================================================

  const FAMILY_STATES = {
    active: ['badge-ok', 'Active'],
    awaiting_approval: ['badge-warn', 'Waiting for your approval'],
    invite_expired: ['badge-danger', 'Invite expired'],
  };

  async function approve(btn, s) {
    const r = await App.run(btn, () => App.api.post(A + '/students/' + s.id + '/approve'));
    if (r) { App.toast(first(s.name) + ' can sign in now.'); App.refresh(); }
  }
  async function resend(btn, id) {
    const r = await App.run(btn, () => App.api.post(A + '/invites/' + id + '/resend'));
    if (r) { flash = { kind: 'share', res: r }; App.refresh(); }
  }
  async function cancelInvite(id, done) {
    await App.api.post(A + '/invites/' + id + '/cancel');
    App.toast(done);
    App.refresh();
  }

  function shareBox(res) {
    const inv = res.invite;
    const who = first(inv.name);
    const url = location.origin + '/#/invite/' + res.code;
    const until = App.fmtDate(inv.expires_at, { weekday: 'long', month: 'long', day: 'numeric' });
    const msg = inv.kind === 'student'
      ? `${App.me.user.name} invited you to ELITE Spaces. Open ${url} on your phone, or enter the code ${res.code}. It works once and expires ${until}.`
      : `${App.me.user.name} invited you to join their family on ELITE Spaces. Open ${url}, or enter the code ${res.code}. It works once and expires ${until}.`;
    const sms = inv.phone && 'sms:' + inv.phone.replace(/[^\d+]/g, '') + '?&body=' + encodeURIComponent(msg);
    const mail = inv.email && 'mailto:' + inv.email + '?subject=' + encodeURIComponent('Your ELITE Spaces invite') + '&body=' + encodeURIComponent(msg);
    return h('section', { class: 'card', role: 'status', tabindex: '-1', id: 'ac-share', 'aria-labelledby': 'ac-share-h' },
      h('h2', { id: 'ac-share-h' }, 'Send ' + who + ' this invite'),
      h('p', null, `The code works once and expires ${until}. It's shown only now, so send it before you leave this page. If it gets lost, use Resend for a new one.`),
      h('div', { class: 'stat ac-code' }, res.code),
      h('div', { class: 'row' },
        copyButton('Copy invite message', msg),
        sms && h('a', { class: 'btn', href: sms }, 'Text it'),
        mail && h('a', { class: 'btn', href: mail }, 'Email it')),
      inv.kind === 'student' && h('p', { class: 'muted small', style: 'margin:.75rem 0 0' },
        `When ${who} sets a password, you'll get a notification. Approve them here and they can sign in.`));
  }

  function studentItem(s) {
    const actions = h('div', { class: 'row', style: 'margin-top:.5rem' });
    const name1 = first(s.name);
    const invId = s.invite && s.invite.id;
    let state = FAMILY_STATES[s.state];
    if (s.state === 'invited') state = ['', s.invite ? 'Invited ' + App.fmtDate(s.invite.created_at, { weekday: undefined }) : 'Invited'];
    if (s.state === 'awaiting_approval') {
      actions.append(
        h('button', { class: 'btn btn-primary', type: 'button', onclick: e => approve(e.currentTarget, s) }, 'Approve ' + name1),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => confirmIn(actions,
          `Decline ${name1}? Their account won't be created and the invite stops working.`, 'Decline ' + name1, 'Keep waiting',
          () => cancelInvite(invId, name1 + ' was declined.')) }, 'Decline'));
    } else if ((s.state === 'invited' || s.state === 'invite_expired') && invId) {
      actions.append(
        h('button', { class: 'btn', type: 'button', onclick: e => resend(e.currentTarget, invId) }, s.state === 'invite_expired' ? 'Send a new code' : 'Resend'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => confirmIn(actions,
          `Cancel ${name1}'s invite? The code stops working and ${name1} won't be added.`, 'Cancel invite', 'Keep invite',
          () => cancelInvite(invId, name1 + "'s invite was cancelled.")) }, 'Cancel invite'));
    }
    const contact = s.email || (s.invite && (s.invite.email || s.invite.phone)) || s.phone;
    return h('li', null, avatar(s.name), h('div', { class: 'grow' },
      h('div', { class: 'row between' }, h('strong', null, s.name), badge(state[0], state[1])),
      contact && h('div', { class: 'muted small' }, contact),
      s.state === 'awaiting_approval' && h('p', { class: 'small', style: 'margin:.35rem 0 0' }, `${name1} accepted your invite. Approve them so they can sign in.`),
      s.state === 'invite_expired' && h('p', { class: 'small', style: 'margin:.35rem 0 0' }, 'The code expired before it was used. Send a new one.'),
      actions.childNodes.length ? actions : null));
  }

  function inviteStudentForm(close) {
    const name = input('text', { autocomplete: 'off', required: true, maxlength: 80 });
    const email = input('email', { autocomplete: 'off' });
    const phone = input('tel', { autocomplete: 'off' });
    const err = alertBox();
    const form = h('form', { class: 'ac-section' },
      h('h3', null, 'Invite a student'),
      h('p', { class: 'muted small' }, "Your student sets their own password on their phone. They can't sign in until you approve them."),
      err,
      field("Student's full name", name),
      field("Student's email", email, "They'll sign in with this. If you only have a phone number, they add an email when they accept."),
      field("Student's mobile phone", phone, 'Optional if you added an email.'),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create invite'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Not now')));
    onSubmit(form, err, async () => {
      const res = await App.api.post(A + '/students/invite', { name: name.value, email: email.value, phone: phone.value });
      flash = { kind: 'share', res };
      App.refresh();
    });
    return form;
  }

  function inviteGuardianForm(close) {
    const name = input('text', { autocomplete: 'off', required: true, maxlength: 80 });
    const email = input('email', { autocomplete: 'off', required: true });
    const err = alertBox();
    const form = h('form', { class: 'ac-section' },
      h('h3', null, 'Invite a guardian'),
      h('p', { class: 'muted small' }, 'A second parent or guardian gets the same access you have: every student, check-in, note and attendance record, and the same notifications.'),
      err,
      field("Guardian's full name", name),
      field("Guardian's email", email, "They'll sign in with this. If they already have an ELITE Spaces account, use that email."),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create invite'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Not now')));
    onSubmit(form, err, async () => {
      const res = await App.api.post(A + '/guardians/invite', { name: name.value, email: email.value });
      flash = { kind: 'share', res };
      App.refresh();
    });
    return form;
  }

  function passwordForm(onDone) {
    const cur = input('password', { autocomplete: 'current-password', required: true });
    const next = input('password', { autocomplete: 'new-password', required: true, minlength: 8 });
    const err = alertBox();
    const form = h('form', null, err,
      field('Current password', cur),
      field('New password', next, 'At least 8 characters.'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save new password'));
    onSubmit(form, err, async () => {
      await App.api.post(A + '/password', { current_password: cur.value, new_password: next.value });
      App.toast('Your password is updated.');
      onDone();
    });
    return form;
  }

  function accountCard() {
    const me = App.me.user;
    const slot = h('div');
    const [btn] = slotButtons(slot, [['Change password', close => h('div', { class: 'ac-section' }, passwordForm(close))]]);
    return h('section', { class: 'card', 'aria-labelledby': 'ac-acct' },
      h('div', { class: 'row between' }, h('h2', { id: 'ac-acct', style: 'margin:0' }, 'Your account'), btn),
      h('p', { class: 'muted small', style: 'margin:.35rem 0 0' }, [me.name, me.email, me.phone].filter(Boolean).join(' · ')),
      slot);
  }

  App.register({
    id: 'family', title: 'Family', icon: '👪', roles: ['parent'], order: 80,
    async render(el) {
      const data = await App.api.get(A + '/family');
      el.append(pageHead('Family', data.location ? 'Your students and guardians at ' + data.location.name + '.' : 'Your students and guardians.'));

      const welcome = takeFlash('welcome');
      if (welcome) el.append(h('div', { class: 'notice notice-ok', role: 'status' }, 'Welcome to ELITE Spaces! Next, invite your student so they can set up their account.'));
      const joined = takeFlash('joined');
      if (joined) el.append(h('div', { class: 'notice notice-ok', role: 'status' }, "You've joined the family. You now see the same students and records."));
      const share = takeFlash('share');
      if (share) { el.append(shareBox(share.res)); focusSoon('ac-share'); }

      // Students
      const stSlot = h('div');
      const [inviteBtn] = slotButtons(stSlot, [['Invite a student', inviteStudentForm, 'btn-primary']]);
      const stList = h('ul', { class: 'list' }, ...data.students.map(studentItem));
      el.append(h('section', { class: 'card', 'aria-labelledby': 'ac-st' },
        h('div', { class: 'row between' }, h('h2', { id: 'ac-st', style: 'margin:0' }, 'Students'), inviteBtn),
        data.students.length ? stList
          : h('p', { class: 'muted', style: 'margin:.75rem 0 0' }, "No students yet. Invite your student by email or phone. They'll set their own password, and you approve them before they can sign in."),
        stSlot));
      if (welcome) setTimeout(() => inviteBtn.click(), 0);

      // Guardians
      const gSlot = h('div');
      const [gBtn] = slotButtons(gSlot, [['Invite a guardian', inviteGuardianForm]]);
      const gList = h('ul', { class: 'list' });
      for (const g of data.guardians) {
        gList.append(h('li', null, avatar(g.name), h('div', { class: 'grow' },
          h('div', { class: 'row between' }, h('strong', null, g.name), g.you ? badge('', 'You') : badge('badge-ok', 'Guardian')),
          h('div', { class: 'muted small' }, [g.email, g.phone].filter(Boolean).join(' · ')))));
      }
      for (const inv of data.invites) {
        const actions = h('div', { class: 'row', style: 'margin-top:.5rem' },
          h('button', { class: 'btn', type: 'button', onclick: e => resend(e.currentTarget, inv.id) }, inv.expired ? 'Send a new code' : 'Resend'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => confirmIn(actions,
            `Cancel the invite to ${inv.name}? The code stops working.`, 'Cancel invite', 'Keep invite',
            () => cancelInvite(inv.id, 'Invite to ' + first(inv.name) + ' cancelled.')) }, 'Cancel invite'));
        gList.append(h('li', null, avatar(inv.name), h('div', { class: 'grow' },
          h('div', { class: 'row between' }, h('strong', null, inv.name),
            inv.expired ? badge('badge-danger', 'Invite expired') : badge('', 'Invited ' + App.fmtDate(inv.created_at, { weekday: undefined }))),
          h('div', { class: 'muted small' }, inv.email), actions)));
      }
      el.append(h('section', { class: 'card', 'aria-labelledby': 'ac-gu' },
        h('div', { class: 'row between' }, h('h2', { id: 'ac-gu', style: 'margin:0' }, 'Guardians'), gBtn),
        h('p', { class: 'muted small', style: 'margin:.35rem 0 0' }, 'Every guardian sees the same students, check-ins, notes and attendance, and gets the same notifications.'),
        gList, gSlot));

      el.append(accountCard());
    },
  });

  // Home: students waiting for approval, or a first step for a brand-new family.
  App.card({
    id: 'accounts-family', roles: ['parent'], order: 20,
    async render(box) {
      const data = await App.api.get(A + '/family');
      const waiting = data.students.filter(s => s.state === 'awaiting_approval');
      if (waiting.length) {
        box.append(h('section', { class: 'card', 'aria-labelledby': 'ac-wait' },
          h('h2', { id: 'ac-wait' }, waiting.length === 1 ? first(waiting[0].name) + ' is waiting for your approval' : 'Students are waiting for your approval'),
          h('ul', { class: 'list' }, ...waiting.map(s => h('li', null, avatar(s.name),
            h('div', { class: 'grow' }, h('strong', null, s.name), h('div', { class: 'muted small' }, 'Accepted your invite' + (s.email ? ' · ' + s.email : ''))),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: e => approve(e.currentTarget, s) }, 'Approve'))))));
      } else if (!data.students.length) {
        box.append(h('section', { class: 'card', 'aria-labelledby': 'ac-first' },
          h('h2', { id: 'ac-first' }, 'Add your first student'),
          h('p', null, "Invite your student by email or phone. They set their own password, then you approve them."),
          h('a', { class: 'btn btn-primary', href: '#/family' }, 'Invite a student')));
      }
    },
  });

  // Home: staff and directors still on a temporary password.
  App.card({
    id: 'accounts-password', roles: ['staff'], order: 1,
    async render(box) {
      const { temp_password: temp } = await App.api.get(A + '/me');
      if (!temp) return;
      box.append(h('section', { class: 'card', 'aria-labelledby': 'ac-temp' },
        h('div', { class: 'row between' }, h('h2', { id: 'ac-temp', style: 'margin:0' }, 'Choose your own password'), badge('badge-warn', 'Temporary password')),
        h('p', { style: 'margin:.5rem 0 .75rem' }, 'You signed in with a temporary password someone set for you. Replace it with one only you know.'),
        passwordForm(() => App.refresh())));
    },
  });

  // =====================================================================
  // Staff, directors, HQ: People
  // =====================================================================

  let hqLoc = ''; // HQ's location filter on People ('' = every location)

  async function locationPicker(onChange) {
    const { locations } = await App.api.get('/api/locations');
    const sel = h('select', null, h('option', { value: '' }, 'All locations'),
      ...locations.map(l => h('option', { value: l.id, selected: String(l.id) === String(hqLoc) }, l.name)));
    sel.addEventListener('change', () => { hqLoc = sel.value; onChange(); });
    return field('Location', sel);
  }

  function tabBar(tabs, current, go) {
    const bar = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'People sections' });
    const btns = tabs.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', id: 'ac-tab-' + id, 'aria-selected': String(id === current), 'aria-controls': 'ac-panel',
      tabindex: id === current ? '0' : '-1', onclick: () => go(id),
    }, label));
    btns.forEach((b, i) => b.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      btns[(i + d + btns.length) % btns.length].focus();
    }));
    bar.append(...btns);
    return bar;
  }

  const ROSTER_STATES = {
    active: ['badge-ok', 'Active'],
    awaiting_approval: ['badge-warn', 'Waiting for parent approval'],
    invited: ['', 'Invited, not set up yet'],
  };

  async function familiesTab(panel, rest) {
    const isHq = App.role() === 'hq';
    const focusId = Number(rest[0]) || null;
    const search = input('search', { autocomplete: 'off' });
    const controls = h('div', { class: 'grid' }, field('Find a student or parent', search, 'Search by name, email or phone.'));
    const out = h('div');
    panel.append(controls, out);
    let students = [];
    async function load() {
      out.replaceChildren(h('p', { class: 'muted', 'aria-busy': 'true' }, 'Loading…'));
      students = (await App.api.get(A + '/roster' + (isHq && hqLoc ? '?location_id=' + hqLoc : ''))).students;
      draw();
    }
    if (isHq) controls.append(await locationPicker(() => load().catch(e => App.toast(e.message, 'error'))));
    function draw() {
      const q = search.value.trim().toLowerCase();
      const hay = s => [s.name, s.email, s.phone, ...s.parents.flatMap(p => [p.name, p.email, p.phone])].filter(Boolean).join(' ').toLowerCase();
      let rows = students.filter(s => (!focusId || s.id === focusId) && (!q || hay(s).includes(q)));
      const where = isHq ? (hqLoc ? 'this location' : 'any location') : (App.me.location ? App.me.location.name : 'your location');
      if (!students.length) {
        out.replaceChildren(h('div', { class: 'card empty' }, `No students at ${where} yet. Students appear here once a parent signs up and invites them.`));
        return;
      }
      const head = h('div', { class: 'row between', style: 'margin-bottom:.5rem' },
        h('p', { class: 'muted', style: 'margin:0', role: 'status' }, focusId ? 'Showing one student.' : plural(rows.length, 'student', 'students') + (q ? ' match your search.' : '.')),
        focusId && h('a', { class: 'btn btn-ghost', href: '#/people/families' }, 'Show everyone'));
      if (!rows.length) {
        out.replaceChildren(head, h('div', { class: 'card empty' }, focusId ? "That student isn't on this roster." : `Nobody matches “${search.value.trim()}”. Check the spelling or try a phone number.`));
        return;
      }
      const tbody = h('tbody');
      for (const s of rows) {
        const st = ROSTER_STATES[s.state] || ['', s.state];
        tbody.append(h('tr', null,
          h('td', null, h('strong', null, s.name), h('div', { class: 'muted small' }, [s.email, s.phone].filter(Boolean).join(' · '))),
          isHq && h('td', null, s.location_name),
          h('td', null, badge(st[0], st[1])),
          h('td', null, s.parents.length ? h('ul', { class: 'list' }, ...s.parents.map(p => h('li', { style: 'padding:.25rem 0;border:0;display:block' },
            h('div', null, p.name, p.link_status === 'pending' ? h('span', { class: 'muted small' }, ' (not approved yet)') : null),
            h('div', { class: 'small' },
              p.phone && h('a', { href: 'tel:' + p.phone.replace(/[^\d+]/g, ''), 'aria-label': 'Call ' + p.name + ' at ' + p.phone }, p.phone),
              p.phone && p.email ? ' · ' : '',
              p.email && h('a', { href: 'mailto:' + p.email, 'aria-label': 'Email ' + p.name + ' at ' + p.email }, p.email)))))
            : h('span', { class: 'muted small' }, 'No parent linked'))));
      }
      out.replaceChildren(head, h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
        h('caption', { class: 'sr-only' }, 'Students and their parents or guardians'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Student'), isHq && h('th', { scope: 'col' }, 'Location'),
          h('th', { scope: 'col' }, 'Account'), h('th', { scope: 'col' }, 'Parents and guardians'))),
        tbody)));
    }
    search.addEventListener('input', draw);
    await load();
  }

  function tempPasswordBox(r, heading) {
    return h('section', { class: 'card', role: 'status', tabindex: '-1', id: 'ac-temp-pw', 'aria-labelledby': 'ac-temp-pw-h' },
      h('h2', { id: 'ac-temp-pw-h' }, heading),
      h('p', null, `Give ${first(r.user.name)} this temporary password. It's shown only once. They sign in with ${r.user.email}, then choose their own password.`),
      h('div', { class: 'stat ac-code' }, r.temp_password),
      h('div', { class: 'row' }, copyButton('Copy password', r.temp_password)));
  }

  async function staffTab(panel) {
    const isHq = App.role() === 'hq';
    const me = App.me.user;
    const addSlot = h('div');
    const shown = h('div');
    const out = h('div');
    const [addBtn] = slotButtons(addSlot, [['Add a staff member', close => addStaffForm(close, r => {
      close();
      shown.replaceChildren(tempPasswordBox(r, r.user.name + ' can sign in now'));
      focusSoon('ac-temp-pw');
      load();
    }), 'btn-primary']]);
    const top = h('div', { class: 'row between', style: 'align-items:flex-end;margin-bottom:12px' });
    if (isHq) top.append(h('div', { style: 'min-width:220px' }, await locationPicker(() => load())));
    else top.append(h('p', { class: 'muted', style: 'margin:0' }, 'You manage staff accounts at ' + (App.me.location ? App.me.location.name : 'your location') + '.'));
    top.append(addBtn);
    panel.append(top, addSlot, shown, out);

    async function load() {
      const { staff } = await App.api.get(A + '/staff' + (isHq && hqLoc ? '?location_id=' + hqLoc : ''));
      if (!staff.length) {
        out.replaceChildren(h('div', { class: 'card empty' }, 'No staff accounts here yet. Add your first staff member above.'));
        return;
      }
      const tbody = h('tbody');
      for (const s of staff) {
        const status = !s.active ? badge('', 'Deactivated') : s.temp_password ? badge('badge-warn', 'Temporary password') : badge('badge-ok', 'Active');
        const cell = h('td');
        const canManage = s.id !== me.id && (isHq || s.role === 'staff');
        if (s.id === me.id) cell.append(h('span', { class: 'muted small' }, 'This is you'));
        else if (!canManage) cell.append(h('span', { class: 'muted small' }, 'HQ manages directors'));
        else {
          const row = h('div', { class: 'row' });
          row.append(h('button', { class: 'btn', type: 'button', 'aria-label': 'Reset password for ' + s.name, onclick: () => confirmIn(row,
            `Reset ${first(s.name)}'s password? Their current password stops working and they get a new temporary one.`, 'Reset password', 'Keep it',
            async () => {
              const r = await App.api.post(A + '/staff/' + s.id + '/reset-password');
              shown.replaceChildren(tempPasswordBox(r, 'New temporary password for ' + s.name));
              focusSoon('ac-temp-pw');
              await load();
            }) }, 'Reset password'));
          if (s.active) {
            row.append(h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Deactivate ' + s.name, onclick: () => confirmIn(row,
              `Deactivate ${s.name}? They're signed out now and can't sign in until the account is reactivated.`, 'Deactivate', 'Keep active',
              async () => { await App.api.post(A + '/staff/' + s.id + '/deactivate'); App.toast(s.name + ' was deactivated.'); await load(); }) }, 'Deactivate'));
          } else {
            row.append(h('button', { class: 'btn', type: 'button', 'aria-label': 'Reactivate ' + s.name, onclick: async e => {
              const r = await App.run(e.currentTarget, () => App.api.post(A + '/staff/' + s.id + '/reactivate'));
              if (r) { App.toast(s.name + ' can sign in again.'); await load(); }
            } }, 'Reactivate'));
          }
          cell.append(row);
        }
        tbody.append(h('tr', null,
          h('td', null, h('strong', null, s.name), h('div', { class: 'muted small' }, [s.email, s.phone].filter(Boolean).join(' · '))),
          isHq && h('td', null, s.location_name || '—'),
          h('td', null, s.role === 'director' ? 'Director' : 'Staff'),
          h('td', null, status),
          cell));
      }
      out.replaceChildren(h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
        h('caption', { class: 'sr-only' }, 'Staff accounts'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Name'), isHq && h('th', { scope: 'col' }, 'Location'),
          h('th', { scope: 'col' }, 'Role'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Actions'))),
        tbody)));
    }
    await load();
  }

  function addStaffForm(close, done) {
    const isHq = App.role() === 'hq';
    const name = input('text', { autocomplete: 'off', required: true, maxlength: 80 });
    const email = input('email', { autocomplete: 'off', required: true });
    const phone = input('tel', { autocomplete: 'off' });
    const loc = isHq ? h('select', { required: true }, h('option', { value: '' }, 'Choose a location')) : null;
    if (loc) App.api.get('/api/locations').then(({ locations }) => loc.append(...locations.filter(l => l.active)
      .map(l => h('option', { value: l.id, selected: String(l.id) === String(hqLoc) }, l.name)))).catch(() => {});
    const err = alertBox();
    const form = h('form', { class: 'card' },
      h('h2', null, 'Add a staff member'),
      h('p', { class: 'muted small' }, "We'll make a temporary password for you to give them. They choose their own after signing in."),
      err,
      field('Full name', name),
      field('Work email', email, 'They sign in with this.'),
      field('Mobile phone (optional)', phone),
      loc && field('Location', loc),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create account'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Not now')));
    onSubmit(form, err, async () => {
      const body = { name: name.value, email: email.value, phone: phone.value };
      if (loc) body.location_id = Number(loc.value) || null;
      done(await App.api.post(A + '/staff', body));
    });
    return form;
  }

  // A director's own location: radius, QR change time and hours (D-5).
  async function locationTab(panel) {
    const { locations } = await App.api.get(A + '/locations');
    const l = locations[0];
    if (!l) { panel.append(h('div', { class: 'card empty' }, "Your account isn't linked to a location yet. Ask HQ to assign you.")); return; }
    panel.append(h('section', { class: 'card', 'aria-labelledby': 'ac-loc-h' },
      h('h2', { id: 'ac-loc-h' }, l.name),
      facts(l),
      h('p', { class: 'muted small' }, 'HQ manages the name, address, time zone and map position. You can change these settings:'),
      settingsForm(l, false, () => App.refresh())));
  }

  function facts(l) {
    const fact = (k, v) => h('div', null, h('dt', null, k), h('dd', null, v));
    return h('dl', { class: 'ac-facts' },
      fact('Time zone', zoneLabel(l.timezone)),
      fact('Hours', App.hhmm(l.open_time) + '–' + App.hhmm(l.close_time)),
      fact('Check-in radius', l.geofence_m + ' m'),
      fact('New QR code each day at', App.hhmm(l.qr_rotate_at)),
      fact('Accounts', plural(l.student_count, 'student', 'students') + ' · ' + plural(l.staff_count, 'staff member', 'staff members')));
  }

  // Location form. full = HQ (every field); otherwise a director's four settings.
  function settingsForm(l, full, done, close) {
    const v = l || {};
    const radius = input('number', { min: 25, max: 2000, step: 5, required: true, value: v.geofence_m ?? 150, inputmode: 'numeric' });
    const rotate = input('time', { required: true, value: v.qr_rotate_at || '04:00' });
    const open = input('time', { required: true, value: v.open_time || '09:00' });
    const shut = input('time', { required: true, value: v.close_time || '20:00' });
    const err = alertBox();
    const parts = [err];
    let name, address, zone, lat, lng, active;
    if (full) {
      name = input('text', { required: true, maxlength: 80, value: v.name || '' });
      address = input('text', { maxlength: 200, value: v.address || '', autocomplete: 'off' });
      zone = h('select', { required: true }, h('option', { value: '' }, 'Choose a time zone'),
        ...ZONES.concat(v.timezone && !ZONES.some(z => z[0] === v.timezone) ? [[v.timezone, v.timezone]] : [])
          .map(([z, label]) => h('option', { value: z, selected: z === v.timezone }, label)));
      lat = input('number', { step: 'any', min: -90, max: 90, required: true, value: v.lat ?? '', inputmode: 'decimal' });
      lng = input('number', { step: 'any', min: -180, max: 180, required: true, value: v.lng ?? '', inputmode: 'decimal' });
      parts.push(field('Location name', name), field('Street address', address),
        field('Time zone', zone, 'Sessions, closing time and the daily QR code all follow this zone.'),
        h('div', { class: 'grid' }, field('Latitude', lat), field('Longitude', lng)),
        h('p', { class: 'hint muted small', style: 'margin-top:-.5rem' }, 'In Google Maps, right-click the building and click the two numbers at the top to copy them.'));
      if (l) {
        active = h('select', null, h('option', { value: '1', selected: !!v.active }, 'Open'), h('option', { value: '0', selected: !v.active }, 'Closed'));
        parts.push(field('Status', active, 'A closed location no longer appears when families sign up.'));
      }
    }
    parts.push(
      field('Check-in radius (meters)', radius, 'Students must be this close to the building to check in. 150 m suits most buildings.'),
      field('New QR code each day at', rotate, "Yesterday's entrance code stops working at this time, local to the location."),
      h('div', { class: 'grid' }, field('Opens at', open), field('Closes at', shut, 'Anyone still checked in is checked out automatically at closing time.')),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, l ? 'Save changes' : 'Add location'),
        close && h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Not now')));
    const form = h('form', full && l ? { class: 'ac-section' } : null, ...parts);
    onSubmit(form, err, async () => {
      const body = { geofence_m: Number(radius.value), qr_rotate_at: rotate.value, open_time: open.value, close_time: shut.value };
      if (full) Object.assign(body, { name: name.value, address: address.value, timezone: zone.value, lat: lat.value, lng: lng.value });
      if (active) body.active = active.value === '1';
      const r = l ? await App.api.patch(A + '/locations/' + l.id, body) : await App.api.post(A + '/locations', body);
      App.toast(l ? r.location.name + ' is updated.' : r.location.name + ' was added.');
      done(r);
    });
    return form;
  }

  async function accountTab(panel) {
    panel.append(accountCard());
  }

  App.register({
    id: 'people', title: 'People', icon: '👥', roles: ['staff'], order: 80,
    async render(el, params) {
      const role = App.role();
      const tabs = [['families', 'Families']];
      if (role !== 'staff') tabs.push(['staff', 'Staff']);
      if (role === 'director') tabs.push(['location', 'Location settings']);
      tabs.push(['account', 'My account']);
      const tab = tabs.some(t => t[0] === params[0]) ? params[0] : role === 'director' ? 'staff' : 'families';
      const where = App.me.location ? App.me.location.name : null;
      el.append(pageHead('People', role === 'hq' ? 'Students, families and staff across every location.' : `Students, families and staff at ${where || 'your location'}.`));
      el.append(tabBar(tabs, tab, id => App.go('people', id)));
      const panel = h('div', { role: 'tabpanel', id: 'ac-panel', 'aria-labelledby': 'ac-tab-' + tab });
      el.append(panel);
      await ({ families: familiesTab, staff: staffTab, location: locationTab, account: accountTab })[tab](panel, params.slice(1));
    },
  });

  // =====================================================================
  // HQ: Locations and directors
  // =====================================================================

  function addDirectorForm(l, close) {
    const name = input('text', { autocomplete: 'off', required: true, maxlength: 80 });
    const email = input('email', { autocomplete: 'off', required: true });
    const phone = input('tel', { autocomplete: 'off' });
    const err = alertBox();
    const form = h('form', { class: 'ac-section' },
      h('h3', null, 'Add a director for ' + l.name),
      h('p', { class: 'muted small' }, 'Directors manage staff, sessions and announcements at their location. You get a temporary password to give them.'),
      err, field('Full name', name), field('Work email', email, 'They sign in with this.'), field('Mobile phone (optional)', phone),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create director'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Not now')));
    onSubmit(form, err, async () => {
      const r = await App.api.post(A + '/directors', { name: name.value, email: email.value, phone: phone.value, location_id: l.id });
      flash = { kind: 'director', locId: l.id, res: r };
      App.refresh();
    });
    return form;
  }

  function assignDirectorForm(l, close) {
    const box = h('div', { class: 'ac-section' }, h('h3', null, 'Make someone director of ' + l.name), h('p', { class: 'muted', 'aria-busy': 'true' }, 'Loading staff…'));
    App.api.get(A + '/staff').then(({ staff }) => {
      const people = staff.filter(s => s.active && !(s.role === 'director' && s.location_id === l.id));
      if (!people.length) {
        box.replaceChildren(box.firstChild, h('p', { class: 'muted' }, 'There is nobody to choose yet. Add a new director instead.'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Close'));
        return;
      }
      const who = h('select', { required: true }, h('option', { value: '' }, 'Choose a person'),
        ...people.map(s => h('option', { value: s.id }, `${s.name} (${s.role === 'director' ? 'director' : 'staff'} at ${s.location_name || 'no location'})`)));
      const err = alertBox();
      const form = h('form', null, err,
        field('Person', who, `They become a director and move to ${l.name} if they work somewhere else.`),
        h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Make director'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Not now')));
      onSubmit(form, err, async () => {
        const r = await App.api.post(A + '/directors/assign', { user_id: Number(who.value) || null, location_id: l.id });
        App.toast(r.user.name + ' now leads ' + l.name + '.');
        App.refresh();
      });
      box.replaceChildren(box.firstChild, form);
      who.focus();
    }).catch(e => box.replaceChildren(box.firstChild, h('div', { class: 'notice notice-danger', role: 'alert' }, e.message)));
    return box;
  }

  function locationCard(l, shownDirector) {
    const slot = h('div');
    if (shownDirector) slot.append(tempPasswordBox(shownDirector, shownDirector.user.name + ' now leads ' + l.name));
    const [edit, addDir, assign] = slotButtons(slot, [
      ['Edit details', close => settingsForm(l, true, () => App.refresh(), close)],
      ['Add a director', close => addDirectorForm(l, close)],
      ['Make someone director', close => assignDirectorForm(l, close)],
    ]);
    edit.setAttribute('aria-label', 'Edit details for ' + l.name);
    addDir.setAttribute('aria-label', 'Add a director for ' + l.name);
    assign.setAttribute('aria-label', 'Make someone director of ' + l.name);
    return h('section', { class: 'card', 'aria-labelledby': 'ac-l-' + l.id },
      h('div', { class: 'row between' }, h('h2', { id: 'ac-l-' + l.id, style: 'margin:0' }, l.name), l.active ? badge('badge-ok', 'Open') : badge('', 'Closed')),
      h('p', { class: 'muted small', style: 'margin:.25rem 0 .75rem' }, l.address || 'No street address yet.'),
      facts(l),
      h('h3', null, l.directors.length > 1 ? 'Directors' : 'Director'),
      l.directors.length
        ? h('ul', { class: 'list' }, ...l.directors.map(d => h('li', null, avatar(d.name), h('div', { class: 'grow' },
          h('strong', null, d.name), h('div', { class: 'muted small' }, [d.email, d.phone].filter(Boolean).join(' · '))),
          !d.active && badge('', 'Deactivated'))))
        : h('p', { class: 'muted' }, 'No director yet. Add one so this location can manage its own staff and schedule.'),
      h('div', { class: 'row', style: 'margin-top:.5rem' }, edit, addDir, assign),
      slot);
  }

  App.register({
    id: 'locations', title: 'Locations', icon: '📍', roles: ['hq'], order: 81,
    async render(el) {
      const { locations } = await App.api.get(A + '/locations');
      const addSlot = h('div');
      const [addBtn] = slotButtons(addSlot, [['Add a location', close => h('section', { class: 'card', 'aria-label': 'New location' },
        h('h2', null, 'Add a location'), settingsForm(null, true, () => App.refresh(), close)), 'btn-primary']]);
      el.append(pageHead('Locations', plural(locations.length, 'location', 'locations') + ' in the network. Each runs on its own time zone.', addBtn), addSlot);
      const shown = takeFlash('director');
      if (!locations.length) el.append(h('div', { class: 'card empty' }, 'No locations yet. Add the first one, then give it a director.'));
      for (const l of locations) el.append(locationCard(l, shown && shown.locId === l.id ? shown.res : null));
      if (shown) focusSoon('ac-temp-pw');
    },
  });
})();
