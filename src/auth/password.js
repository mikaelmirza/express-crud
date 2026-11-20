// Password hashing with Node's built-in scrypt (memory-hard, no native modules).
// Stored format: scrypt$N$r$p$salt$hash — parameters travel with the hash, so the
// cost can be raised later without breaking existing passwords.
import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { authConfig } from './config.js';
import { withSpan } from '../telemetry/tracing.js';
import { timePasswordHash } from '../telemetry/metrics.js';

const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const BLOCK_SIZE = 8; // r
const PARALLELISM = 1; // p

// scrypt needs ~128 * N * r bytes; Node's default limit (32MB) is too low for N = 2^17
const options = (N, r, p) => ({ N, r, p, maxmem: 256 * N * r });

// scrypt runs on libuv's thread pool, which no automatic instrumentation sees.
// These spans are what explain a ~330ms login in a trace. Only the cost
// parameter is recorded, never the password, salt or hash.

export const hashPassword = (password) => {
  const N = authConfig.scryptN;
  return withSpan('auth.hash_password', { 'auth.scrypt.cost': N }, () =>
    timePasswordHash('hash', async () => {
      const salt = randomBytes(SALT_LENGTH);
      const hash = await scrypt(password, salt, KEY_LENGTH, options(N, BLOCK_SIZE, PARALLELISM));
      return ['scrypt', N, BLOCK_SIZE, PARALLELISM, salt.toString('base64'), hash.toString('base64')].join('$');
    })
  );
};

const verify = async (password, stored) => {
  const [algorithm, N, r, p, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt') return false;

  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(
    password,
    Buffer.from(salt, 'base64'),
    expected.length,
    options(Number(N), Number(r), Number(p))
  );
  return timingSafeEqual(actual, expected);
};

export const verifyPassword = (password, stored) =>
  withSpan('auth.verify_password', { 'auth.scrypt.cost': Number(stored.split('$')[1]) || undefined }, () =>
    timePasswordHash('verify', () => verify(password, stored))
  );

// Used when a login email doesn't exist, so the response takes as long as a
// real password check and timing can't reveal which emails are registered.
let dummyHash;

// Called at server startup. Building the dummy hash lazily would make the very
// first unknown-email login slower (hash + verify), which is itself a timing leak.
export const prepareDummyHash = async () => {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
};

// Same span name as a real check, so the two paths look identical in a trace too
export const verifyAgainstDummy = async (password) => {
  await prepareDummyHash();
  await verifyPassword(password, dummyHash);
  return false;
};
