// Custom metrics, for what no library can see. Like tracing.js, this uses only
// @opentelemetry/api: with no SDK loaded every call is a no-op.
//
// Label (attribute) rule: every value comes from a small, fixed set. Each
// unique combination is a separate time series stored forever, so ids,
// emails, URLs or search text as labels would create one series per value.
// Per-user and per-request detail belongs in traces and logs.
import { metrics, ValueType } from '@opentelemetry/api';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const { name, version } = createRequire(import.meta.url)('../../package.json');

// Same switch as tracing.js, for the zero-code comparison only
const enabled = process.env.APP_CUSTOM_TELEMETRY !== 'false';

// Instruments are created on first use, not at import. Unlike tracing, the
// metrics API has no proxy: an instrument created before the SDK starts stays
// a no-op forever, so import order mistakes would silently lose metrics.
let instruments;
const get = () => {
  if (instruments) return instruments;
  const meter = metrics.getMeter(name, version);
  instruments = {
    loginAttempts: meter.createCounter('app.auth.login.attempts', {
      description: 'Login attempts, by outcome',
      unit: '{attempt}',
      valueType: ValueType.INT,
    }),
    passwordHashDuration: meter.createHistogram('app.auth.password_hash.duration', {
      description: 'Time to hash or verify a password, including waiting for a libuv thread',
      unit: 's',
      // Normal is ~0.3s; seconds means calls are queueing for the 4-thread pool
      advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 5, 10, 30] },
    }),
    passwordHashActive: meter.createUpDownCounter('app.auth.password_hash.active', {
      description: 'Password hashes or verifications in progress. Above the libuv pool size (4 by default), calls are queueing.',
      unit: '{operation}',
      valueType: ValueType.INT,
    }),
    listDuration: meter.createHistogram('app.items.list.duration', {
      description: 'Time to list items, by kind of search',
      unit: 's',
      advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 1, 2.5, 5] },
    }),
    usersRegistered: meter.createCounter('app.users.registered', {
      description: 'Users registered',
      unit: '{user}',
      valueType: ValueType.INT,
    }),
    itemsCreated: meter.createCounter('app.items.created', {
      description: 'Items created',
      unit: '{item}',
      valueType: ValueType.INT,
    }),
    rateLimited: meter.createCounter('app.rate_limit.rejections', {
      description: 'Requests rejected with 429, by which limit they hit',
      unit: '{request}',
      valueType: ValueType.INT,
    }),
  };
  return instruments;
};

export const LOGIN_OUTCOMES = ['success', 'wrong_password', 'unknown_email'];

// Called once at server startup. Reports every counter at 0 for each label
// value it can take. Otherwise a counter's series first appears already at
// its first value (say 3), and Prometheus's rate() needs to see an increase
// between two samples, so low-traffic events would read as zero.
export const RATE_LIMITERS = ['api', 'auth', 'short_search'];

export const initMetrics = () => {
  if (!enabled) return;
  const { loginAttempts, usersRegistered, itemsCreated, rateLimited } = get();
  for (const outcome of LOGIN_OUTCOMES) loginAttempts.add(0, { 'app.auth.outcome': outcome });
  for (const limiter of RATE_LIMITERS) rateLimited.add(0, { 'app.rate_limit.limiter': limiter });
  usersRegistered.add(0);
  itemsCreated.add(0);
};

export const recordRateLimited = (limiter) => {
  if (!enabled) return;
  if (!RATE_LIMITERS.includes(limiter)) throw new Error(`Unknown rate limiter: ${limiter}`);
  get().rateLimited.add(1, { 'app.rate_limit.limiter': limiter });
};

export const recordLoginAttempt = (outcome) => {
  if (!enabled) return;
  if (!LOGIN_OUTCOMES.includes(outcome)) throw new Error(`Unknown login outcome: ${outcome}`);
  get().loginAttempts.add(1, { 'app.auth.outcome': outcome });
};

// Times a password hash or verify, from the call until it completes, so the
// duration includes any wait for a libuv thread (that's the point)
export const timePasswordHash = async (operation, fn) => {
  if (!enabled) return fn();
  const { passwordHashDuration, passwordHashActive } = get();
  const attributes = { 'app.auth.operation': operation };
  const start = performance.now();
  passwordHashActive.add(1, attributes);
  try {
    return await fn();
  } finally {
    passwordHashActive.add(-1, attributes);
    passwordHashDuration.record((performance.now() - start) / 1000, attributes);
  }
};

// Three buckets instead of the actual length: 1-2 characters can't use the
// trigram index, 3+ can. The exact length is on the trace.
export const searchCategory = (q) => {
  if (!q) return 'none';
  return q.length < 3 ? 'short' : 'indexed';
};

export const recordListDuration = (seconds, q) => {
  if (!enabled) return;
  get().listDuration.record(seconds, { 'app.search.category': searchCategory(q) });
};

export const recordUserRegistered = () => {
  if (enabled) get().usersRegistered.add(1);
};

export const recordItemCreated = () => {
  if (enabled) get().itemsCreated.add(1);
};
