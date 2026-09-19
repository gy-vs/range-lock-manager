/** 库内所有错误的基类。 */
export class IntervalLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 区间非法：空区间、反向区间、负数、非整数或非有限数。同步抛出。 */
export class InvalidIntervalError extends IntervalLockError {
  constructor(
    readonly start: unknown,
    readonly end: unknown,
    reason: string,
  ) {
    super(`Invalid interval [${String(start)}, ${String(end)}): ${reason}`);
  }
}

/** 锁模式非法（运行时防御，TS 调用者由类型系统保证）。同步抛出。 */
export class InvalidModeError extends IntervalLockError {
  constructor(readonly mode: unknown) {
    super(`Invalid lock mode: ${String(mode)}, expected 'shared' | 'exclusive'`);
  }
}

/** 管理器已关闭：新申请被拒绝 / 等待者以此失败。 */
export class ManagerClosedError extends IntervalLockError {
  constructor(message = 'Lock manager is closed') {
    super(message);
  }
}

/**
 * 升级冲突：同一重叠区域已存在挂起中的升级。
 * 先到者胜；收到本错误的一方继续持有 shared 租约，可稍后重试。
 */
export class UpgradeConflictError extends IntervalLockError {
  constructor(
    readonly leaseId: number,
    readonly conflictingLeaseId: number,
  ) {
    super(
      `Upgrade of lease ${leaseId} rejected: lease ${conflictingLeaseId} ` +
        `already has a pending upgrade on an overlapping interval`,
    );
  }
}

/** 对已释放租约执行了非法操作（升级/降级），或租约在升级完成前被释放。 */
export class LeaseReleasedError extends IntervalLockError {
  constructor(readonly leaseId: number) {
    super(`Lease ${leaseId} has been released`);
  }
}

/** 等待被取消（AbortSignal 未携带 reason 时的兜底错误）。 */
export class LockCancelledError extends IntervalLockError {
  constructor(message = 'Lock wait was cancelled') {
    super(message);
  }
}
