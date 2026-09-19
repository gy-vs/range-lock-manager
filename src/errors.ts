/**
 * Error codes emitted by the interval lock manager.
 */
export type LockErrorCode =
  | 'INVALID_INTERVAL'
  | 'LOCK_CLOSED'
  | 'INVALID_LEASE'
  | 'LEASE_RELEASED'
  | 'UPGRADE_CONFLICT'
  | 'UPGRADE_PENDING'
  | 'UPGRADE_CANCELED';

/**
 * Base class for every error thrown by this library so callers can
 * distinguish lock failures with a single `instanceof` check.
 */
export class LockError extends Error {
  readonly code: LockErrorCode;

  constructor(code: LockErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LockError';
    this.code = code;
  }
}

/** The requested interval is empty (`end <= start`) or reversed (`start > end`). */
export class InvalidIntervalError extends LockError {
  constructor(message = 'lock interval must be a non-empty half-open range [start, end)') {
    super('INVALID_INTERVAL', message);
    this.name = 'InvalidIntervalError';
  }
}

/** The manager has been closed; new acquisitions and pending waiters fail with this error. */
export class LockClosedError extends LockError {
  constructor(message = 'lock manager is closed') {
    super('LOCK_CLOSED', message);
    this.name = 'LockClosedError';
  }
}

/** The lease does not belong to this manager or is not usable for the attempted operation. */
export class InvalidLeaseError extends LockError {
  constructor(message = 'lease is invalid for this lock manager') {
    super('INVALID_LEASE', message);
    this.name = 'InvalidLeaseError';
  }
}

/** An operation was attempted against a lease that was already released. */
export class LeaseReleasedError extends LockError {
  constructor(message = 'lease has already been released') {
    super('LEASE_RELEASED', message);
    this.name = 'LeaseReleasedError';
  }
}

/**
 * An upgrade lost the deterministic arbitration: another earlier exclusive
 * waiter already covers the same interval. The caller keeps holding the
 * shared lease and may release or retry later.
 */
export class UpgradeConflictError extends LockError {
  constructor(message = 'upgrade to exclusive conflicts with an earlier exclusive waiter') {
    super('UPGRADE_CONFLICT', message);
    this.name = 'UpgradeConflictError';
  }
}

/** The lease already has an upgrade request in flight. */
export class UpgradePendingError extends LockError {
  constructor(message = 'an upgrade is already pending for this lease') {
    super('UPGRADE_PENDING', message);
    this.name = 'UpgradePendingError';
  }
}

/**
 * A pending upgrade was abandoned (the lease was downgraded back to shared
 * while the upgrade was queued). The lease remains held in shared mode.
 */
export class UpgradeCanceledError extends LockError {
  constructor(message = 'pending upgrade was canceled by a downgrade') {
    super('UPGRADE_CANCELED', message);
    this.name = 'UpgradeCanceledError';
  }
}
