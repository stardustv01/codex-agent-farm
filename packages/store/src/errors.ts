export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export class ScopeError extends StoreError {
  constructor(message = "The requested Agent Farm resource is not available in this scope") {
    super("SCOPE_DENIED", message);
    this.name = "ScopeError";
  }
}

export class NotFoundError extends StoreError {
  constructor(message = "Agent Farm resource was not found") {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class ConstraintError extends StoreError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ConstraintError";
  }
}

export class IdempotencyConflictError extends StoreError {
  constructor(message = "The idempotency key was already used with a different request") {
    super("IDEMPOTENCY_CONFLICT", message);
    this.name = "IdempotencyConflictError";
  }
}

export class EventReplayConflictError extends StoreError {
  constructor(message = "A replayed event key has a different sanitized payload hash") {
    super("EVENT_REPLAY_CONFLICT", message);
    this.name = "EventReplayConflictError";
  }
}
