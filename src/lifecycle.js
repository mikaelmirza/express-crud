// Process-wide shutdown state. Readiness reports "shutting down" once this is
// set, so load balancers stop sending traffic while in-flight requests finish.
let shuttingDown = false;

export const lifecycle = {
  get shuttingDown() {
    return shuttingDown;
  },
  beginShutdown() {
    shuttingDown = true;
  },
};
