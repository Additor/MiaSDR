/** Errors the application layer raises. Route handlers map them to HTTP; nothing here knows about HTTP. */
export class NotFoundError extends Error {
  constructor(what = "Not found") {
    super(what);
  }
}

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to do this.") {
    super(message);
  }
}

export class ConflictError extends Error {
  /** Extra JSON for the response body, such as the rows that changed under an edit. */
  constructor(
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The request body or upload is larger than the endpoint accepts. Answers 413. */
export class PayloadTooLargeError extends Error {}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ step?: number | null; message: string }> = [],
  ) {
    super(message);
  }
}

export interface Actor {
  userId: string;
  organizationId: string;
  /** Stored role string, possibly comma-separated. */
  role: string;
}
