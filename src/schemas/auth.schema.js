import { z } from 'zod';

// Trimmed and lowercased before the format check, so "  Bob@Example.COM " is stored as "bob@example.com"
export const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// The max bounds hashing cost, so huge passwords can't be used to burn CPU
export const password = z.string().min(8).max(128);

export const registerBody = z.object({ email, password });

// No minimum length on login: a policy change shouldn't lock out existing users
export const loginBody = z.object({
  email,
  password: z.string().min(1).max(128),
});
