import { IntervalLockManagerImpl } from './manager.js';
import type {
  IntervalLockManager as IntervalLockManagerInterface,
  IntervalLockManagerOptions,
} from './manager.js';

/**
 * Public interface of a manager; obtained via the
 * {@link IntervalLockManager} constructor.
 */
export type IntervalLockManager = IntervalLockManagerInterface;
export type { IntervalLockManagerOptions } from './manager.js';

/**
 * Construct an in-process interval lock manager.
 *
 * The static type of this binding is only the public
 * {@link IntervalLockManagerInterface} interface; the implementation class
 * is not part of the supported API.
 */
export const IntervalLockManager: new (
  options?: IntervalLockManagerOptions,
) => IntervalLockManagerInterface = IntervalLockManagerImpl;

export type { Lease } from './lease.js';
export {
  LockError,
  InvalidIntervalError,
  LockClosedError,
  InvalidLeaseError,
  LeaseReleasedError,
  UpgradeConflictError,
  UpgradePendingError,
  UpgradeCanceledError,
} from './errors.js';
export type { LockErrorCode } from './errors.js';
export type {
  LockMode,
  Offset,
  Interval,
  AcquireOptions,
  LeaseSnapshot,
  WaiterSnapshot,
  LockSnapshot,
} from './types.js';
