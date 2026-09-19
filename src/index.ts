export { IntervalLockManager } from './manager.js';
export {
  IntervalLockError,
  InvalidIntervalError,
  InvalidModeError,
  LeaseReleasedError,
  LockCancelledError,
  ManagerClosedError,
  UpgradeConflictError,
} from './errors.js';
export type {
  AcquireOptions,
  HolderSnapshot,
  Interval,
  Lease,
  LockManagerSnapshot,
  LockMode,
  UpgradeOptions,
  WaiterSnapshot,
} from './types.js';
