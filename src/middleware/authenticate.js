import { verifyToken } from '../auth/tokens.js';
import { findById } from '../services/user.service.js';
import { setRequestAttributes } from '../telemetry/tracing.js';

const unauthorized = (res) =>
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer')
    .json({ error: 'Authentication required' });

// Requires `Authorization: Bearer <token>` and sets req.user = { id, email, role, createdAt }.
export const authenticate = async (req, res, next) => {
  const [scheme, token] = req.get('authorization')?.split(' ') ?? [];
  if (scheme !== 'Bearer' || !token) return unauthorized(res);

  let payload;
  try {
    payload = await verifyToken(token);
  } catch {
    // Expired, tampered, wrong secret, wrong algorithm: all the same 401
    return unauthorized(res);
  }

  try {
    // Look the user up on every request so deleted users and role changes take
    // effect immediately instead of when the token expires
    const user = await findById(payload.sub);
    if (!user) return unauthorized(res);
    req.user = user;
    setRequestAttributes({ 'user.id': user.id, 'user.roles': [user.role] });
    next();
  } catch (err) {
    next(err); // a database failure is a 500, not a 401
  }
};
