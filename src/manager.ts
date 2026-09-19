import {
  InvalidIntervalError,
  InvalidModeError,
  LeaseReleasedError,
  LockCancelledError,
  ManagerClosedError,
  UpgradeConflictError,
} from './errors.js';
import { compatible, deferred, overlaps } from './internal.js';
import type { HolderRecord, WaiterRecord } from './internal.js';
import { LeaseImpl } from './lease.js';
import type {
  AcquireOptions,
  HolderSnapshot,
  Interval,
  Lease,
  LockManagerSnapshot,
  LockMode,
  WaiterSnapshot,
} from './types.js';

/**
 * 进程内区间锁管理器，协调同一逻辑文件上的并发读写。
 *
 * 授予规则（公平性）：
 *   请求按到达顺序进入 FIFO 等待队列。队列中的请求可被授予，当且仅当
 *   1. 与所有已持有租约不存在「区间重叠且模式不兼容」的冲突；
 *   2. 与队列中排在它前面的所有请求不存在「区间重叠且模式不兼容」的冲突。
 *   兼容 = 双方都是 shared。
 *   因此：等待中的 exclusive 会挡住后来的重叠 shared（防写饥饿），
 *   而不重叠的请求不受队列影响，仍可立即授予。
 *
 * 升级规则（防死锁）：
 *   升级请求排在所有普通等待者之前（升级者已持有 shared，若排在已排队
 *   exclusive 之后会互相等待）。同一重叠区域同一时刻只允许一个挂起升级，
 *   先到者胜，后到者立即以 UpgradeConflictError 失败并继续持有 shared。
 *
 * 每次释放/取消/降级/关闭后都会按队列顺序重判，取消不留占位状态。
 */
export class IntervalLockManager {
  private readonly holders = new Map<number, HolderRecord>();
  private readonly queue: WaiterRecord[] = [];
  private nextId = 1;
  private _closed = false;

  get closed(): boolean {
    return this._closed;
  }

  /**
   * 申请区间锁。
   * - 区间/模式非法：同步抛出（编程错误，不进 promise）。
   * - 关闭后申请 / 信号已中止：返回 rejected promise。
   * - 可立即授予时同步授予（promise 在微任务中 resolve）。
   */
  acquire(interval: Interval, mode: LockMode, options: AcquireOptions = {}): Promise<Lease> {
    const { start, end } = validateInterval(interval);
    validateMode(mode);
    const signal = options.signal;

    const d = deferred<LeaseImpl>();
    if (this._closed) {
      d.reject(new ManagerClosedError());
      return d.promise;
    }
    if (signal?.aborted) {
      d.reject(abortReason(signal));
      return d.promise;
    }

    const waiter: WaiterRecord = {
      id: this.nextId++,
      kind: 'acquire',
      start,
      end,
      mode,
      lease: null,
      signal,
      onAbort: null,
      settled: false,
      resolve: d.resolve,
      reject: d.reject,
    };
    // 入队即参与统一判定：可授予则同步授予，否则保持队尾位置等待
    this.queue.push(waiter);
    this._processQueue();
    this.armCancellation(waiter);
    return d.promise;
  }

  /**
   * 关闭管理器：拒绝新申请，所有等待者以 ManagerClosedError 失败。
   * 已发出的租约仍可正常释放/降级。幂等。
   */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    const pending = this.queue.splice(0);
    for (const w of pending) {
      w.settled = true;
      this.detach(w);
      if (w.kind === 'upgrade' && w.lease) {
        w.lease._clearPendingUpgrade(w);
      }
      w.reject(new ManagerClosedError('Lock manager closed while waiting'));
    }
  }

  /** 只读诊断快照：深拷贝 + 深冻结，不暴露内部可变对象。 */
  snapshot(): LockManagerSnapshot {
    const holders: HolderSnapshot[] = [];
    for (const h of this.holders.values()) {
      holders.push(
        Object.freeze({
          id: h.id,
          mode: h.lease._mode,
          range: Object.freeze({ start: h.start, end: h.end }),
        }),
      );
    }
    const waiters: WaiterSnapshot[] = this.queue.map((w) =>
      Object.freeze({
        id: w.id,
        kind: w.kind,
        mode: w.mode,
        range: Object.freeze({ start: w.start, end: w.end }),
        ...(w.lease ? { leaseId: w.lease.id } : {}),
      }),
    );
    return Object.freeze({
      closed: this._closed,
      holders: Object.freeze(holders),
      waiters: Object.freeze(waiters),
    });
  }

  /** @internal 租约释放（租约自身与 holders 记录双重保证幂等）。 */
  _release(lease: LeaseImpl): void {
    const holder = this.holders.get(lease.id);
    if (!holder) return;
    // 释放时若仍有挂起升级，先让它失败并移出队列
    const pending = lease._pendingUpgradeWaiter;
    if (pending) {
      this.cancelWaiter(pending, new LeaseReleasedError(lease.id));
    }
    this.holders.delete(lease.id);
    this._processQueue();
  }

  /** @internal 租约升级请求（shared → exclusive）。 */
  _requestUpgrade(lease: LeaseImpl, signal: AbortSignal | undefined): Promise<Lease> {
    const d = deferred<LeaseImpl>();
    if (this._closed) {
      d.reject(new ManagerClosedError());
      return d.promise;
    }
    if (signal?.aborted) {
      d.reject(abortReason(signal));
      return d.promise;
    }

    // 确定性冲突规则：同一重叠区域只允许一个挂起升级，先到者胜。
    // 后到者立即失败并继续持有 shared，从根上消除双向等待（死锁）。
    for (const w of this.queue) {
      if (
        w.kind === 'upgrade' &&
        w.lease !== null &&
        w.lease !== lease &&
        overlaps(w.start, w.end, lease.range.start, lease.range.end)
      ) {
        d.reject(new UpgradeConflictError(lease.id, w.lease.id));
        return d.promise;
      }
    }

    const waiter: WaiterRecord = {
      id: this.nextId++,
      kind: 'upgrade',
      start: lease.range.start,
      end: lease.range.end,
      mode: 'exclusive',
      lease,
      signal,
      onAbort: null,
      settled: false,
      resolve: d.resolve,
      reject: d.reject,
    };
    lease._setPendingUpgrade(waiter, d.promise);

    // 升级排在所有普通等待者之前（多个升级之间仍按到达顺序）。
    // 升级者已持有 shared，若排在已排队 exclusive 之后会互相等待形成死锁。
    let insertAt = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i]!.kind === 'acquire') {
        insertAt = i;
        break;
      }
    }
    this.queue.splice(insertAt, 0, waiter);
    this._processQueue();
    this.armCancellation(waiter);
    return d.promise;
  }

  /**
   * @internal 队列重判：从头到尾扫描，授予所有当前可满足的请求。
   * 授予只会增加约束，单趟顺序扫描即可，结果确定。
   */
  _processQueue(): void {
    let i = 0;
    while (i < this.queue.length) {
      const w = this.queue[i]!;
      if (w.settled) {
        // 防御：已 settle 的记录不应留在队列中（取消路径都会移除）
        this.queue.splice(i, 1);
        continue;
      }
      if (this.canGrant(w, i)) {
        this.queue.splice(i, 1);
        this.grant(w);
        // 不递增 i：后续请求移入位置 i，继续检查
      } else {
        i++;
      }
    }
  }

  /** 判定位于队列 index 处的请求当前是否可授予。 */
  private canGrant(waiter: WaiterRecord, index: number): boolean {
    for (const h of this.holders.values()) {
      if (h.lease === waiter.lease) continue; // 升级时排除自己持有的 shared
      if (
        overlaps(h.start, h.end, waiter.start, waiter.end) &&
        !compatible(h.lease._mode, waiter.mode)
      ) {
        return false;
      }
    }
    for (let i = 0; i < index; i++) {
      const ahead = this.queue[i]!;
      if (ahead.settled) continue;
      if (
        overlaps(ahead.start, ahead.end, waiter.start, waiter.end) &&
        !compatible(ahead.mode, waiter.mode)
      ) {
        return false;
      }
    }
    return true;
  }

  private grant(waiter: WaiterRecord): void {
    waiter.settled = true;
    this.detach(waiter);
    if (waiter.kind === 'upgrade') {
      const lease = waiter.lease!;
      lease._mode = 'exclusive';
      lease._clearPendingUpgrade(waiter);
      waiter.resolve(lease);
    } else {
      const lease = new LeaseImpl(this, waiter.id, waiter.start, waiter.end, waiter.mode);
      this.holders.set(lease.id, {
        id: lease.id,
        start: waiter.start,
        end: waiter.end,
        lease,
      });
      waiter.resolve(lease);
    }
  }

  /** 取消等待者：立即移出队列并重判，不留占位状态。 */
  private cancelWaiter(waiter: WaiterRecord, err?: unknown): void {
    if (waiter.settled) return;
    waiter.settled = true;
    const idx = this.queue.indexOf(waiter);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.detach(waiter);
    if (waiter.kind === 'upgrade' && waiter.lease) {
      waiter.lease._clearPendingUpgrade(waiter);
    }
    waiter.reject(err ?? (waiter.signal ? abortReason(waiter.signal) : new LockCancelledError()));
    this._processQueue();
  }

  private armCancellation(waiter: WaiterRecord): void {
    if (waiter.settled || !waiter.signal) return;
    const onAbort = () => this.cancelWaiter(waiter);
    waiter.onAbort = onAbort;
    waiter.signal.addEventListener('abort', onAbort, { once: true });
  }

  private detach(waiter: WaiterRecord): void {
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.onAbort = null;
  }
}

function validateInterval(interval: Interval): { start: number; end: number } {
  const start = interval?.start;
  const end = interval?.end;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end)
  ) {
    throw new InvalidIntervalError(start, end, 'bounds must be finite safe integers');
  }
  if (start < 0) {
    throw new InvalidIntervalError(start, end, 'start must be >= 0');
  }
  if (start >= end) {
    throw new InvalidIntervalError(start, end, 'empty or reversed interval');
  }
  return { start, end };
}

function validateMode(mode: LockMode): void {
  if (mode !== 'shared' && mode !== 'exclusive') {
    throw new InvalidModeError(mode);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new LockCancelledError();
}
