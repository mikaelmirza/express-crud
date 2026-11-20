import { Router } from 'express';
import { createAuthRoutes } from './auth.routes.js';
import { createItemRoutes } from './item.routes.js';

// Built per app (not at import) so each app gets its own rate limiters,
// which lets tests use small limits without affecting other tests.
export const createRoutes = ({ limiters }) => {
  const router = Router();

  // Register resource routers here
  router.use('/auth', createAuthRoutes({ limiters }));
  router.use('/items', createItemRoutes({ limiters }));

  return router;
};
