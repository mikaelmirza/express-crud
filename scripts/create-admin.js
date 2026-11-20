// Creates an admin user, or promotes an existing user to admin.
//
//   npm run user:create-admin -- admin@example.com
//
// The password is prompted for (not echoed), or read from ADMIN_PASSWORD for
// non-interactive use. It's never taken as an argument, which would leave it
// in shell history and process listings.
import { email as emailSchema, password as passwordSchema } from '../src/schemas/auth.schema.js';
import * as users from '../src/services/user.service.js';
import { hashPassword } from '../src/auth/password.js';
import { closePool } from '../src/db/pool.js';

const promptHidden = (question) =>
  new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);

    // Piped input (e.g. CI): read one line normally
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => (data += chunk));
      stdin.on('end', () => {
        stdout.write('\n');
        resolve(data.split('\n')[0]);
      });
      return;
    }

    let input = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    const onData = (char) => {
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        stdout.write('\n');
        resolve(input);
      } else if (char === '\u0003') {
        stdin.setRawMode(false);
        reject(new Error('Cancelled'));
      } else if (char === '\u007f' || char === '\b') {
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    stdin.on('data', onData);
  });

try {
  const parsedEmail = emailSchema.safeParse(process.argv[2] ?? '');
  if (!parsedEmail.success) {
    throw new Error('Usage: npm run user:create-admin -- <email>');
  }
  const email = parsedEmail.data;

  const existing = await users.findByEmailWithPassword(email);

  if (existing) {
    if (existing.role === 'admin') {
      console.log(`${email} is already an admin`);
    } else {
      await users.setRole(existing.id, 'admin');
      console.log(`Promoted ${email} to admin`);
    }
  } else {
    const password = process.env.ADMIN_PASSWORD ?? (await promptHidden('Password: '));
    const parsedPassword = passwordSchema.safeParse(password);
    if (!parsedPassword.success) {
      throw new Error('Password must be 8-128 characters');
    }
    await users.create({ email, passwordHash: await hashPassword(password), role: 'admin' });
    console.log(`Created admin ${email}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
