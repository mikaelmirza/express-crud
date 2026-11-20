import pg from 'pg';
import { logger } from '../logging/logger.js';
import { config } from '../config.js';

const { Pool, types } = pg;

// NUMERIC (oid 1700) is returned as a string by default to avoid precision loss.
// Prices here are small, so parse them to numbers for the JSON API.
types.setTypeParser(1700, (value) => parseFloat(value));

const { url: connectionString, poolMax, connectTimeoutMs, statementTimeoutMs } = config.db;

// host, port and database repeat what's in the connection string (pg gives the
// string precedence). They're here because the pg instrumentation names the
// pool in its metrics from these options, and shows "unknown_host:unknown_port/
// unknown_database" without them.
const url = new URL(connectionString);

export const pool = new Pool({
  connectionString,
  host: url.hostname,
  port: Number(url.port) || 5432,
  database: url.pathname.slice(1),
  max: poolMax,
  // pg waits forever for a connection by default. With the database
  // unreachable (not refusing, just silent), requests would hang indefinitely.
  connectionTimeoutMillis: connectTimeoutMs,
  // Postgres cancels statements running longer than this (error code 57014)
  statement_timeout: statementTimeoutMs || undefined,
});

// An idle client can error (e.g. the server restarts). Without a listener this crashes the process.
pool.on('error', (err) => {
  logger.error({ err, 'event.name': 'db.pool.idle_client_error' }, 'unexpected error on idle Postgres client');
});

export const query = (text, params) => pool.query(text, params);

// Resolves once every client has been released and closed. Safe to call twice.
let ending;
export const closePool = () => (ending ??= pool.end());
