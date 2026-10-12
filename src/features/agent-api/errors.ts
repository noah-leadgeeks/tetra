export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenScopeError extends Error {
  constructor(message = "Insufficient scope") {
    super(message);
    this.name = "ForbiddenScopeError";
  }
}

/** Request refused because the DISABLE_AUTH bypass is active (403 `auth_bypass`). */
export class AuthBypassError extends Error {
  constructor(message = "Disabled while DISABLE_AUTH is on") {
    super(message);
    this.name = "AuthBypassError";
  }
}

/** State conflict (409); `action` carries the current pending-action row when relevant. */
export class ConflictError extends Error {
  readonly action: unknown;

  constructor(message: string, action?: unknown) {
    super(message);
    this.name = "ConflictError";
    this.action = action;
  }
}

/** Invalid request input raised by the agent layer itself (400 `bad_request`). */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
