import { LeaseImpl } from './lease.js';
import type { Lease } from './lease.js';
import {
  InvalidIntervalError,
  InvalidLeaseError,
  LeaseReleasedError,
  LockClosedError,
  UpgradeCanceledError,
  UpgradeConflictError,
  UpgradePendingError,
} from './errors.js';
import type {
  AcquireOptions,
  LeaseSnapshot,
  LockMode,
  LockSnapshot,
  Offset,
  WaiterSnapshot,
} from './types.js';

/**
 * Internal queued request. Created for both fresh acquires and upgrades.
 * @internal
 */
export interface Waiter {
  readonly kind: 'acquire' | 'upgrade';
  /** Held lease for an upgrade; undefined for a fresh acquire. */
  readonly lease?: LeaseImpl;
  readonly resolve: (value: Lease | void) => void;
  readonly reject: (reason?: unknown) => void;
  readonly promise: Promise<Lease | void>;
  readonly mode: LockMode;
  readonly start: Offset;
  readonly end: Offset;
  readonly queuedAt: number;
  /** True once granted or canceled, i.e. once it is leaving the queue. */
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface IntervalLockManagerOptions {
  /** Clock used for `grantedAt` / `queuedAt` snapshots. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * In-process manager for shared/exclusive locks over half-open integer
 * intervals of a shared logical resource (e.g. a file).
 *
 * Intervals are treated as `[start, end)`: adjacent intervals such as
 * `[0, 10)` and `[10, 20)` do not overlap and may run in parallel.
 *
 * Compatibility matrix for overlapping intervals:
 *
 * | held \ requested | shared | exclusive |
 * | ---------------- | ------ | --------- |
 * | shared           | yes    | no        |
 * | exclusive        | no     | no        |
 *
 * Queueing is writer-fair but range-aware: a request waits while it would
 * either (a) conflict with a currently held lease, or (b) conflict with an
 * earlier request already forced to wait. Consequences:
 *
 * - A later overlapping shared request cannot slip past a waiting exclusive.
 * - A later request on a disjoint interval is never blocked by it.
 * - Granting is re-evaluated after every release, cancel, upgrade and
 *   downgrade, so canceled waiters never leave a phantom barrier behind.
 */
export interface IntervalLockManager {
  /** True after {@link IntervalLockManager.close} has been called. */
  readonly closed: boolean;
  /** Number of currently held (active) leases. */
  readonly holderCount: number;
  /** Number of requests currently waiting in the FIFO queue. */
  readonly waiterCount: number;

  /**
   * Request a lock over `[start, end)`.
   *
   * Resolves with a {@link Lease} once granted. Empty or reversed intervals
   * throw synchronously with `InvalidIntervalError`; after `close()` the
   * call throws `LockClosedError`.
   *
   * Pass an `AbortSignal` to cancel a queued request: the promise rejects
   * with the signal's abort reason and the rest of the queue is re-judged
   * immediately.
   */
  acquire(
    mode: LockMode,
    start: Offset,
    end: Offset,
    options?: AcquireOptions,
  ): Promise<Lease>;

  /**
   * Close the manager. New acquisitions throw `LockClosedError`; every
   * waiter already queued rejects with it. Held leases stay valid and can
   * still be released. Idempotent.
   */
  close(): void;

  /**
   * Detached, frozen point-in-time diagnostic view of holders and waiters.
   * Mutating the returned objects (or retaining them across state changes)
   * cannot affect manager internals.
   */
  snapshot(): LockSnapshot;
}

/** @internal Concrete implementation; only the interface is exported publicly. */
export class IntervalLockManagerImpl implements IntervalLockManager {
  readonly #holders: Set<LeaseImpl> = new Set();
  readonly #waiters: Waiter[] = [];
  #closed = false;
  #nextLeaseId = 1;
  readonly #clock: () => number;

  constructor(options: IntervalLockManagerOptions = {}) {
    this.#clock = options.now ?? Date.now;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get holderCount(): number {
    return this.#holders.size;
  }

  get waiterCount(): number {
    let n = 0;
    for (const w of this.#waiters) if (!w.settled) n++;
    return n;
  }

  acquire(
    mode: LockMode,
    start: Offset,
    end: Offset,
    options?: AcquireOptions,
  ): Promise<Lease> {
    if (mode !== 'shared' && mode !== 'exclusive') {
      throw new TypeError(`mode must be 'shared' or 'exclusive', got: ${String(mode)}`);
    }
    this.#validateInterval(start, end);
    if (this.#closed) throw new LockClosedError();

    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(this.#abortError(signal));

    const waiter = this.#makeWaiter('acquire', undefined, mode, start, end, signal);
    this.#waiters.push(waiter);
    this.#pump();
    return waiter.promise as Promise<Lease>;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters) {
      if (!w.settled) this.#settleRejection(w, new LockClosedError());
    }
    this.#pump();
  }

  snapshot(): LockSnapshot {
    const holders = [...this.#holders].map((h): LeaseSnapshot => {
      const dto: LeaseSnapshot = Object.freeze({
        id: h._id,
        mode: h._mode,
        start: h._start,
        end: h._end,
        grantedAt: h._grantedAt,
        upgradePending: h._pendingUpgrade !== undefined,
      });
      return dto;
    });
    const waiters = this.#waiters
      .filter((w) => !w.settled)
      .map((w): WaiterSnapshot => {
        const dto: WaiterSnapshot = Object.freeze({
          kind: w.kind,
          ...(w.lease !== undefined ? { leaseId: w.lease._id } : {}),
          mode: w.mode,
          start: w.start,
          end: w.end,
          queuedAt: w.queuedAt,
        });
        return dto;
      });
    return Object.freeze({
      closed: this.#closed,
      holders: Object.freeze(holders),
      waiters: Object.freeze(waiters),
    });
  }

  // ---------------------------------------------------------------------
  // Lease-facing internal API. Underscore-prefixed and absent from the
  // public IntervalLockManager interface.
  // ---------------------------------------------------------------------

  /** @internal */
  _releaseLease(lease: LeaseImpl): void {
    if (lease._manager !== this) throw new InvalidLeaseError();
    if (!lease._active) return;

    const pending = lease._pendingUpgrade;
    lease._pendingUpgrade = undefined;
    lease._active = false;
    lease._mode = 'shared';
    this.#holders.delete(lease);
    if (pending !== undefined) {
      this.#settleRejection(pending, new LeaseReleasedError());
    }
    this.#pump();
  }

  /** @internal */
  _upgradeLease(lease: LeaseImpl, options?: AcquireOptions): Promise<void> {
    if (lease._manager !== this) throw new InvalidLeaseError();
    if (!lease._active) throw new LeaseReleasedError();
    if (lease._pendingUpgrade !== undefined) throw new UpgradePendingError();
    if (lease._mode === 'exclusive') return Promise.resolve();
    if (this.#closed) throw new LockClosedError();

    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(this.#abortError(signal));

    // Deterministic deadlock arbitration (FIFO): any earlier queued
    // exclusive request overlapping this interval can never be granted
    // while this shared lease is held, and this upgrade cannot be granted
    // ahead of that waiter. The earliest such waiter wins; this upgrade is
    // rejected outright while the caller keeps its shared lease.
    for (const w of this.#waiters) {
      if (w.settled) continue;
      if (
        w.mode === 'exclusive' &&
        w.lease !== lease &&
        overlaps(w.start, w.end, lease._start, lease._end)
      ) {
        throw new UpgradeConflictError();
      }
    }

    const waiter = this.#makeWaiter(
      'upgrade',
      lease,
      'exclusive',
      lease._start,
      lease._end,
      signal,
    );
    lease._pendingUpgrade = waiter;
    this.#waiters.push(waiter);
    this.#pump();
    return waiter.promise as Promise<void>;
  }

  /** @internal */
  _downgradeLease(lease: LeaseImpl): void {
    if (lease._manager !== this) throw new InvalidLeaseError();
    if (!lease._active) throw new LeaseReleasedError();

    const pending = lease._pendingUpgrade;
    if (pending !== undefined) {
      // Abandon the queued upgrade; the shared lease itself stays held.
      lease._pendingUpgrade = undefined;
      this.#settleRejection(pending, new UpgradeCanceledError());
    }
    lease._mode = 'shared';
    this.#pump();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  #validateInterval(start: Offset, end: Offset): void {
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= end // covers both empty (start === end) and reversed (start > end)
    ) {
      throw new InvalidIntervalError();
    }
  }

  #abortError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error) return reason;
    const err = new Error(
      reason === undefined ? 'The operation was aborted' : String(reason),
    );
    err.name = 'AbortError';
    return err;
  }

  #makeWaiter(
    kind: Waiter['kind'],
    lease: LeaseImpl | undefined,
    mode: LockMode,
    start: Offset,
    end: Offset,
    signal: AbortSignal | undefined,
  ): Waiter {
    let resolve!: Waiter['resolve'];
    let reject!: Waiter['reject'];
    const promise = new Promise<Lease | void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Keep the promise observed so a rejection racing caller teardown never
    // surfaces as an unhandled rejection; the real caller also awaits it.
    promise.catch(() => {});

    const waiter: Waiter = {
      kind,
      ...(lease !== undefined ? { lease } : {}),
      resolve,
      reject,
      promise,
      mode,
      start,
      end,
      queuedAt: this.#clock(),
      settled: false,
    };

    if (signal !== undefined) {
      const listener = (): void => {
        if (!waiter.settled) this.#cancelWaiter(waiter, this.#abortError(signal));
      };
      waiter.signal = signal;
      waiter.onAbort = listener;
      signal.addEventListener('abort', listener, { once: true });
    }
    return waiter;
  }

  /**
   * Grant everything grantable, preserving FIFO fairness.
   *
   * A single left-to-right pass keeps `blocked`, the ordered list of earlier
   * requests that could not be granted yet. A waiter is granted iff it
   * conflicts with neither the current holders nor any member of `blocked`;
   * otherwise it joins `blocked`. The queue is rebuilt from `blocked`,
   * dropping any waiters settled concurrently (cancel/close).
   */
  #pump(): void {
    const blocked: Waiter[] = [];
    for (const w of this.#waiters) {
      if (w.settled) continue;

      if (this.#conflictsWithHolders(w) || this.#blockedByEarlier(w, blocked)) {
        blocked.push(w);
        continue;
      }
      this.#grant(w);
    }
    this.#waiters.length = 0;
    this.#waiters.push(...blocked);
  }

  #conflictsWithHolders(w: Waiter): boolean {
    for (const h of this.#holders) {
      if (w.kind === 'upgrade' && h === w.lease) continue; // upgrade keeps its own S
      if (
        overlaps(w.start, w.end, h._start, h._end) &&
        (w.mode === 'exclusive' || h._mode === 'exclusive')
      ) {
        return true;
      }
    }
    return false;
  }

  #blockedByEarlier(w: Waiter, blocked: readonly Waiter[]): boolean {
    for (const b of blocked) {
      if (
        overlaps(w.start, w.end, b.start, b.end) &&
        (w.mode === 'exclusive' || b.mode === 'exclusive')
      ) {
        return true;
      }
    }
    return false;
  }

  #grant(w: Waiter): void {
    w.settled = true;
    this.#detachSignal(w);
    if (w.kind === 'acquire') {
      const lease = new LeaseImpl(
        this,
        this.#nextLeaseId++,
        w.start,
        w.end,
        w.mode,
        this.#clock(),
      );
      this.#holders.add(lease);
      w.resolve(lease);
    } else {
      const lease = w.lease;
      if (lease === undefined) return; // unreachable: upgrades always carry a lease
      lease._mode = 'exclusive';
      lease._pendingUpgrade = undefined;
      w.resolve();
    }
  }

  #cancelWaiter(w: Waiter, reason: unknown): void {
    if (w.settled) return;
    this.#settleRejection(w, reason);
    this.#pump();
  }

  #settleRejection(w: Waiter, reason: unknown): void {
    if (w.settled) return;
    w.settled = true;
    this.#detachSignal(w);
    if (w.kind === 'upgrade' && w.lease !== undefined) {
      w.lease._pendingUpgrade = undefined;
    }
    w.reject(reason);
  }

  #detachSignal(w: Waiter): void {
    if (w.signal !== undefined && w.onAbort !== undefined) {
      w.signal.removeEventListener('abort', w.onAbort);
    }
  }
}

/** Half-open overlap test: true iff `[aStart, aEnd)` and `[bStart, bEnd)` intersect. */
function overlaps(
  aStart: Offset,
  aEnd: Offset,
  bStart: Offset,
  bEnd: Offset,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
