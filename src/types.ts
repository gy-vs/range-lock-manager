/**
 * Lock mode for a request or held lease.
 *
 * - `'shared'` permits concurrent shared holders over overlapping intervals.
 * - `'exclusive'` requires no overlapping holder of either mode.
 */
export type LockMode = 'shared' | 'exclusive';

/** A finite, safe-integer coordinate on the logical file. */
export type Offset = number;

/**
 * A half-open interval `[start, end)` on the logical file.
 *
 * Valid intervals satisfy `Number.isSafeInteger(start) &&
 * Number.isSafeInteger(end) && start < end`.
 */
export interface Interval {
  readonly start: Offset;
  readonly end: Offset;
}

export interface AcquireOptions {
  /**
   * Aborting this signal while the request is still queued rejects the
   * acquire promise (with `signal.reason` when set) and immediately
   * re-evaluates the rest of the queue. Already granted locks are not
   * affected.
   */
  signal?: AbortSignal;
}

/** Read-only diagnostic view of a currently held lease. */
export interface LeaseSnapshot {
  readonly id: number;
  readonly mode: LockMode;
  readonly start: Offset;
  readonly end: Offset;
  readonly grantedAt: number;
  /** True while this lease is queued for an upgrade to exclusive. */
  readonly upgradePending: boolean;
}

/** Read-only diagnostic view of a queued request. */
export interface WaiterSnapshot {
  /** `'acquire'` for fresh requests, `'upgrade'` for shared→exclusive upgrades. */
  readonly kind: 'acquire' | 'upgrade';
  /** Lease id for upgrades; absent for fresh acquires (the lease does not exist yet). */
  readonly leaseId?: number;
  readonly mode: LockMode;
  readonly start: Offset;
  readonly end: Offset;
  readonly queuedAt: number;
}

/** Immutable, detached point-in-time view of manager state. */
export interface LockSnapshot {
  readonly closed: boolean;
  /** Held leases, in grant order. */
  readonly holders: readonly LeaseSnapshot[];
  /** Queued requests, in FIFO arrival order. */
  readonly waiters: readonly WaiterSnapshot[];
}
