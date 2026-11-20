// An error with an HTTP status. The error handler sends its message for 4xx
// statuses and a generic message for 5xx.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
