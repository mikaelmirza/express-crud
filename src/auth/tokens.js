import { SignJWT, jwtVerify } from 'jose';
import { authConfig } from './config.js';

const secret = new TextEncoder().encode(authConfig.jwtSecret);
const ALGORITHM = 'HS256';

// The token only identifies the user. Role and existence are read from the
// database on each request, so role changes and deleted users apply immediately.
export const signToken = (userId) =>
  new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(authConfig.jwtExpiresIn)
    .sign(secret);

// Throws if the signature, expiry or algorithm is wrong.
// Pinning the algorithm rejects `alg: none` and algorithm-confusion attacks.
export const verifyToken = async (token) => {
  const { payload } = await jwtVerify(token, secret, { algorithms: [ALGORITHM] });
  return payload;
};
