import { Router } from 'express';
import * as controller from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { recordRoute } from '../logging/httpLogger.js';
import { authenticate } from '../middleware/authenticate.js';
import { registerBody, loginBody } from '../schemas/auth.schema.js';

export const createAuthRoutes = ({ limiters }) => {
  const router = Router();

  // The auth limit comes before validation, so malformed attempts count too
  router.post('/register', recordRoute, limiters.auth, validate({ body: registerBody }), controller.register);
  router.post('/login', recordRoute, limiters.auth, validate({ body: loginBody }), controller.login);
  router.get('/me', recordRoute, authenticate, controller.me);

  return router;
};
