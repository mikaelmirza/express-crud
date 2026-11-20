import { Router } from 'express';
import { query } from '../db/pool.js';
import { lifecycle as defaultLifecycle } from '../lifecycle.js';
import { logger as defaultLogger } from '../logging/logger.js';

// How long the database check may take before readiness reports failure.
// Short, so a hung database fails the check instead of hanging it.
const CHECK_TIMEOUT_MS = 2000;

const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export const checkDatabase = () => withTimeout(query('SELECT 1'), CHECK_TIMEOUT_MS);

// Two checks, the standard split:
//
// - Liveness (/health/live): is the process up and serving? An orchestrator
//   restarts the app when this fails, so it must NOT depend on the database:
//   a database outage would otherwise restart every instance in a loop.
// - Readiness (/health/ready): should this instance get traffic? Fails while
//   the database is unreachable or the server is shutting down, so a load
//   balancer routes around it.
//
// Health requests are left out of request logs, traces and metrics (they'd
// bury real traffic), so readiness logs only when its state changes.
export const createHealthRoutes = ({
  readinessCheck = checkDatabase,
  lifecycle = defaultLifecycle,
  logger = defaultLogger,
} = {}) => {
  const router = Router();
  let lastReady = null;

  const logChange = (ready, err) => {
    if (ready === lastReady) return;
    if (ready) {
      if (lastReady === false) logger.info({ 'event.name': 'health.ready' }, 'readiness check passing again');
    } else if (!lifecycle.shuttingDown) {
      logger.warn({ 'event.name': 'health.not_ready', err }, 'readiness check failing: database unavailable');
    }
    lastReady = ready;
  };

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const live = (req, res) => res.json({ status: 'ok' });
  router.get('/', live); // kept for existing clients
  router.get('/live', live);

  router.get('/ready', async (req, res) => {
    if (lifecycle.shuttingDown) {
      return res.status(503).json({ status: 'shutting_down' });
    }
    try {
      await readinessCheck();
      logChange(true);
      res.json({ status: 'ok', checks: { database: 'ok' } });
    } catch (err) {
      logChange(false, err);
      // No error details: this endpoint is often reachable without auth
      res.status(503).json({ status: 'unavailable', checks: { database: 'failed' } });
    }
  });

  return router;
};
