import type { IntervalLockManagerImpl, Waiter } from './manager.js';
import type { AcquireOptions, LockMode, Offset } from './types.js';

/**
 * A handle to a held interval lock.
 *
 * Leases are created by `IntervalLockManager.acquire` and must be
 * returned to the same manager that issued them. `release()` is idempotent:
 * calling it any number of times, including after a manager shutdown, is
 * safe and has no effect after the first call.
 */
export interface Lease {
  /** Monotonic, manager-scoped lease identifier. */
  readonly id: number;
  /** Mode the lease is currently held in. */
  readonly mode: LockMode;
  /** Start of the held half-open interval. */
  readonly start: Offset;
  /** End of the held half-open interval. */
  readonly end: Offset;
  /** Epoch-millisecond timestamp recorded when the lease was first granted. */
  readonly grantedAt: number;
  /** False once {@link release} has completed. */
  readonly active: boolean;
  /** True while an {@link upgrade} call is queued and waiting to be granted. */
  readonly upgradePending: boolean;

  /**
   * Release the lease. Idempotent: releases after the first are no-ops and
   * never throw (even after the manager has been closed).
   *
   * If an upgrade is queued when this is called, the upgrade promise rejects
   * with `LeaseReleasedError`, the shared lease is released, and the queue
   * is re-evaluated immediately.
   */
  release(): void;

  /**
   * Upgrade this shared lease to exclusive over the same interval.
   *
   * The current shared lease remains held while the request is queued.
   * Requests are granted in FIFO arrival order: the upgrade is admitted as
   * soon as every conflicting earlier request has cleared. Later overlapping
   * requests cannot overtake it.
   *
   * If an earlier queued exclusive request conflicts with this interval, the
   * upgrade rejects immediately with `UpgradeConflictError` — this is the
   * deterministic rule that prevents two shared holders upgrading each
   * other into a deadlock. The caller keeps holding the shared lease.
   *
   * At most one upgrade may be pending per lease; concurrent calls reject
   * synchronously with `UpgradePendingError`. Calling upgrade on an already
   * exclusive lease resolves immediately (no-op).
   */
  upgrade(options?: AcquireOptions): Promise<void>;

  /**
   * Convert an exclusive lease (or one queued for exclusive) back to shared.
   *
   * - Exclusive → shared: immediately admits compatible shared waiters.
   * - Shared with a pending upgrade: cancels the upgrade (its promise rejects
   *   with `UpgradeCanceledError`) and keeps the shared lease.
   * - Shared without a pending upgrade: no-op.
   */
  downgrade(): void;
}

/**
 * Concrete lease used internally by the manager; not exported from the
 * package entry point so the public typings only expose {@link Lease}.
 * @internal
 */
export class LeaseImpl implements Lease {
  readonly _manager: IntervalLockManagerImpl;
  readonly _id: number;
  readonly _start: Offset;
  readonly _end: Offset;
  readonly _grantedAt: number;
  /** Currently held mode (shared after a downgrade, exclusive after an upgrade). */
  _mode: LockMode;
  _active = true;
  /** Queued upgrade waiter, if any. */
  _pendingUpgrade: Waiter | undefined;

  constructor(
    manager: IntervalLockManagerImpl,
    id: number,
    start: Offset,
    end: Offset,
    mode: LockMode,
    grantedAt: number,
  ) {
    this._manager = manager;
    this._id = id;
    this._start = start;
    this._end = end;
    this._mode = mode;
    this._grantedAt = grantedAt;
  }

  get id(): number {
    return this._id;
  }

  get mode(): LockMode {
    return this._mode;
  }

  get start(): Offset {
    return this._start;
  }

  get end(): Offset {
    return this._end;
  }

  get grantedAt(): number {
    return this._grantedAt;
  }

  get active(): boolean {
    return this._active;
  }

  get upgradePending(): boolean {
    return this._pendingUpgrade !== undefined;
  }

  release(): void {
    if (!this._active) return;
    this._manager._releaseLease(this);
  }

  upgrade(options?: AcquireOptions): Promise<void> {
    return this._manager._upgradeLease(this, options);
  }

  downgrade(): void {
    this._manager._downgradeLease(this);
  }
}
