import { z } from 'zod';
import { formatIssues } from '../config.js';

const GENERATE_HINT =
  'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"';

const schema = z.object({
  JWT_SECRET: z
    .string({ error: `JWT_SECRET is required. ${GENERATE_HINT}` })
    .min(32, `JWT_SECRET must be at least 32 characters. ${GENERATE_HINT}`),
  JWT_EXPIRES_IN: z.string().default('15m'),
  // scrypt cost (N). OWASP recommends 2^17; tests lower it for speed.
  SCRYPT_N: z.coerce
    .number()
    .int()
    .refine((n) => n > 1 && (n & (n - 1)) === 0, 'SCRYPT_N must be a power of 2')
    .default(2 ** 17),
});

const result = schema.safeParse(process.env);

// Fail at startup, not on the first login
if (!result.success) {
  throw new Error(`Invalid auth configuration:\n${formatIssues(result.error.issues)}`);
}

export const authConfig = {
  jwtSecret: result.data.JWT_SECRET,
  jwtExpiresIn: result.data.JWT_EXPIRES_IN,
  scryptN: result.data.SCRYPT_N,
};
