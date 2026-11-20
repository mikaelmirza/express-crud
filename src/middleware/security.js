import helmet from 'helmet';
import cors from 'cors';
import { REQUEST_ID_HEADER } from '../logging/requestId.js';

// Security headers. This is a JSON API, so most of helmet's defaults matter
// little for its own responses, but they cost nothing and protect any browser
// that renders one: no MIME sniffing, no framing, HSTS, no X-Powered-By.
export const securityHeaders = () => helmet();

// CORS for the origins listed in CORS_ORIGINS. With none listed, no CORS
// headers are sent and browsers block cross-origin calls (non-browser clients
// are unaffected). Tokens travel in the Authorization header, not cookies, so
// credentials mode isn't needed.
export const corsPolicy = (origins) => {
  if (origins.length === 0) return null;
  return cors({
    origin: origins.includes('*') ? '*' : origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', REQUEST_ID_HEADER, 'traceparent', 'tracestate'],
    // Let browser code read these: the request id for bug reports, and the
    // rate-limit headers to back off
    exposedHeaders: [REQUEST_ID_HEADER, 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600,
  });
};
