import * as users from '../services/user.service.js';
import { hashPassword, verifyPassword, verifyAgainstDummy } from '../auth/password.js';
import { signToken } from '../auth/tokens.js';
import { recordLoginAttempt, recordUserRegistered } from '../telemetry/metrics.js';

// Auth events are logged with req.log, so they carry the request_id and can be
// matched to the request's own log line. Emails are deliberately never logged:
// they're personal data, and people sometimes type a password into that field.

export const register = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await users.create({ email, passwordHash: await hashPassword(password) });
    req.log.info({ 'event.name': 'user.registered', 'user.id': user.id }, 'user registered');
    recordUserRegistered();
    res.status(201).json({ user, token: await signToken(user.id) });
  } catch (err) {
    next(err);
  }
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const found = await users.findByEmailWithPassword(email);

    const valid = found
      ? await verifyPassword(password, found.passwordHash)
      : await verifyAgainstDummy(password); // same timing whether or not the email exists

    // Same response for unknown email and wrong password, so emails can't be probed.
    // The log says which it was, since only operators can see it.
    // A spike in failures (the metric) is what you'd alert on; the log line
    // says which user, for investigating once the alert fires.
    if (!valid) {
      const reason = found ? 'wrong_password' : 'unknown_email';
      recordLoginAttempt(reason);
      req.log.info({ 'event.name': 'auth.login_failed', reason, 'user.id': found?.id }, 'login failed');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const { passwordHash, ...user } = found; // eslint-disable-line no-unused-vars
    recordLoginAttempt('success');
    req.log.info({ 'event.name': 'auth.login_succeeded', 'user.id': user.id }, 'login succeeded');
    res.json({ user, token: await signToken(user.id) });
  } catch (err) {
    next(err);
  }
};

export const me = (req, res) => {
  res.json(req.user);
};
