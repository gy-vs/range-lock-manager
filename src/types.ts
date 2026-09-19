/**
 * 公开类型定义：区间、锁模式、租约、诊断快照。
 */

/** 锁模式：shared 可并发，exclusive 独占。 */
export type LockMode = 'shared' | 'exclusive';

/**
 * 半开区间 [start, end)。
 * 约束：start、end 均为非负安全整数，且 start < end。
 * 空区间（start === end）与反向区间（start > end）会被直接拒绝。
 */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

export interface AcquireOptions {
  /** 取消信号：等待期间触发则请求失败并立即触发队列重判。 */
  readonly signal?: AbortSignal;
}

export interface UpgradeOptions {
  /** 取消信号：升级等待期间触发则升级失败，租约保持 shared。 */
  readonly signal?: AbortSignal;
}

/**
 * 租约：一次成功授予的锁。
 * 升级/降级原地生效，对象身份不变；release 幂等。
 */
export interface Lease {
  /** 全局递增的唯一 id（与快照中的 id 对应）。 */
  readonly id: number;
  /** 冻结的半开区间副本。 */
  readonly range: Interval;
  /** 当前模式；升级/降级后会变化。 */
  readonly mode: LockMode;
  /** 是否已释放。 */
  readonly released: boolean;
  /** 释放租约。幂等：重复调用无副作用。 */
  release(): void;
  /**
   * shared → exclusive 升级。
   * - 立即可满足时同步授予（promise 直接 resolve）。
   * - 等待期间排在普通等待请求之前，后来的重叠请求不得插队。
   * - 与另一个挂起中的升级重叠时，本调用以 UpgradeConflictError 失败，
   *   当前租约继续持有 shared（先到先得，确定性强者胜）。
   * - 成功时 resolve 为本租约自身（mode 已变为 'exclusive'）。
   */
  upgrade(options?: UpgradeOptions): Promise<Lease>;
  /**
   * exclusive → shared 降级，同步生效；对 shared 租约为空操作。
   * 对已释放租约调用会抛出 LeaseReleasedError。
   */
  downgrade(): Lease;
}

export interface HolderSnapshot {
  readonly id: number;
  readonly range: Interval;
  readonly mode: LockMode;
}

export interface WaiterSnapshot {
  readonly id: number;
  /** acquire = 新申请；upgrade = 已有租约的升级请求。 */
  readonly kind: 'acquire' | 'upgrade';
  readonly mode: LockMode;
  readonly range: Interval;
  /** 仅 upgrade：发起升级的租约 id。 */
  readonly leaseId?: number;
}

/**
 * 某一时刻的只读诊断快照。
 * 所有对象与数组均已深冻结，不暴露管理器内部可变状态。
 */
export interface LockManagerSnapshot {
  readonly closed: boolean;
  readonly holders: readonly HolderSnapshot[];
  readonly waiters: readonly WaiterSnapshot[];
}
