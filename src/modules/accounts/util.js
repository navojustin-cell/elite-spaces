'use strict';
// Shared helpers for the accounts module: input checks, one-time invite codes
// and temporary passwords. Signing in goes through the foundation (auth.startSession).

const crypto = require('crypto');
const { IANAZone } = require('luxon');
const { bad } = require('../../errors');

const PW_MIN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Required text, trimmed. `label` reads naturally after "Add ...".
function text(v, field, label, max = 80) {
  const s = String(v ?? '').trim();
  if (!s) throw bad(field, `Add ${label}.`);
  if (s.length > max) throw bad(field, `Keep ${label} to ${max} characters or fewer.`);
  return s;
}

// Optional text: null when blank.
function optText(v, field, label, max = 200) {
  const s = String(v ?? '').trim();
  return s ? text(s, field, label, max) : null;
}

// Emails are stored lower-case so one address can never belong to two accounts.
function email(v, required = true) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) {
    if (required) throw bad('email', 'Add an email address.');
    return null;
  }
  if (!EMAIL_RE.test(s) || s.length > 254) throw bad('email', 'Enter a valid email address, like name@example.com.');
  return s;
}

function phone(v, required = false) {
  const s = String(v ?? '').trim();
  if (!s) {
    if (required) throw bad('phone', 'Add a phone number.');
    return null;
  }
  if (s.replace(/\D/g, '').length < 7 || s.length > 30) throw bad('phone', 'Enter a phone number with at least 7 digits.');
  return s;
}

function password(v, field = 'password') {
  const s = String(v ?? '');
  if (s.length < PW_MIN) throw bad(field, `Choose a password with at least ${PW_MIN} characters.`);
  if (s.length > 200) throw bad(field, 'Keep the password to 200 characters or fewer.');
  return s;
}

function hhmm(v, field, label) {
  const s = String(v ?? '').trim();
  if (!HHMM_RE.test(s)) throw bad(field, `Enter ${label} as a time, like 09:00.`);
  return s;
}

function timezone(v) {
  const s = String(v ?? '').trim();
  if (!s || !IANAZone.isValidZone(s)) throw bad('timezone', 'Choose a valid time zone, like America/Los_Angeles.');
  return s;
}

function number(v, field, label, min, max, integer = false) {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw bad(field, `Enter ${label} between ${min} and ${max}.`);
  }
  return n;
}

function emailTaken(db, addr, exceptId = 0) {
  return !!db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?) AND id != ?').get(addr, exceptId);
}

// "j•••@example.com": enough to recognise your own address, not enough to learn someone else's.
function maskEmail(addr) {
  if (!addr) return null;
  const [name, domain] = String(addr).split('@');
  return name.slice(0, 1) + '•••@' + (domain || '');
}
function maskPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  return '•••' + digits.slice(-2);
}

// ---- one-time invite codes (D-20) ----
// 8 characters from 32 unambiguous ones (no 0/O, 1/I): about 10^12 codes.
// Only the SHA-256 of the normalised code is stored.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += CODE_ALPHABET[b & 31];
  return s.slice(0, 4) + '-' + s.slice(4);
}
const normCode = c => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = c => crypto.createHash('sha256').update(normCode(c)).digest('hex');

// ---- temporary passwords for staff and directors (D-21) ----
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function tempPassword() {
  let s = '';
  for (let i = 0; i < 12; i++) s += PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}

const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'They';

module.exports = {
  PW_MIN, text, optText, email, phone, password, hhmm, timezone, number, emailTaken, maskEmail, maskPhone,
  newCode, normCode, hashCode, tempPassword, firstName,
};
