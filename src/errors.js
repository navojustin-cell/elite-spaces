'use strict';
// Throw these from services; the app turns them into JSON responses.
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (code, msg) => new AppError(400, code, msg);
const forbidden = (msg = 'You do not have access to that.') => new AppError(403, 'forbidden', msg);
const notFound = (msg = 'Not found.') => new AppError(404, 'not_found', msg);
const conflict = (code, msg) => new AppError(409, code, msg);

module.exports = { AppError, bad, forbidden, notFound, conflict };
