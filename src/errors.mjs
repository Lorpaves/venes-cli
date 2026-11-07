// A failure a client is told about, with a code it can act on.
export class HelperError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
