import { LeaseReleasedError } from './errors.js';
import type { WaiterRecord } from './internal.js';
import type { IntervalLockManager } from './manager.js';
import type { Interval, Lease, LockMode, UpgradeOptions } from './types.js';

/**
 * 租约实现。升级/降级原地修改 _mode，对象身份不变。
 * 所有状态变更都委托给管理器，保证与队列判定在同一点上发生。
 */
export class LeaseImpl implements Lease {
  /** 当前模式（唯一事实来源，管理器与快照都读它）。 */
  _mode: LockMode;

  private _released = false;
  private _pendingUpgrade: { waiter: WaiterRecord; promise: Promise<Lease> } | null = null;

  readonly range: Interval;

  constructor(
    private readonly manager: IntervalLockManager,
    readonly id: number,
    start: number,
    end: number,
    mode: LockMode,
  ) {
    this._mode = mode;
    this.range = Object.freeze({ start, end });
  }

  get mode(): LockMode {
    return this._mode;
  }

  get released(): boolean {
    return this._released;
  }

  /** 幂等释放：重复调用无副作用。 */
  release(): void {
    if (this._released) return;
    this._released = true;
    this.manager._release(this);
  }

  upgrade(options: UpgradeOptions = {}): Promise<Lease> {
    if (this._released) {
      return Promise.reject(new LeaseReleasedError(this.id));
    }
    if (this._mode === 'exclusive') {
      return Promise.resolve(this); // 已是独占，空操作
    }
    // 同一租约重复 upgrade：返回同一个挂起中的 promise，避免重复排队
    if (this._pendingUpgrade) {
      return this._pendingUpgrade.promise;
    }
    return this.manager._requestUpgrade(this, options.signal);
  }

  downgrade(): Lease {
    if (this._released) {
      throw new LeaseReleasedError(this.id);
    }
    if (this._mode === 'shared') {
      return this; // 已是共享，空操作
    }
    this._mode = 'shared';
    // 降级可能放行排队的 shared 请求，立即重判
    this.manager._processQueue();
    return this;
  }

  /** @internal 管理器登记挂起升级（用于去重与关闭/释放时的清理）。 */
  _setPendingUpgrade(waiter: WaiterRecord, promise: Promise<Lease>): void {
    this._pendingUpgrade = { waiter, promise };
  }

  /** @internal 授予/取消/关闭时清除挂起升级登记。 */
  _clearPendingUpgrade(waiter: WaiterRecord): void {
    if (this._pendingUpgrade?.waiter === waiter) {
      this._pendingUpgrade = null;
    }
  }

  /** @internal */
  get _pendingUpgradeWaiter(): WaiterRecord | null {
    return this._pendingUpgrade?.waiter ?? null;
  }
}
