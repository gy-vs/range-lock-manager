/**
 * 内部共享结构：持有者记录、等待者记录与小工具。
 * 不对外导出（index.ts 不 re-export 本文件）。
 */
import type { LeaseImpl } from './lease.js';
import type { LockMode } from './types.js';

/** 已授予的持有者记录。模式以 lease._mode 为唯一事实来源（升级/降级原地修改）。 */
export interface HolderRecord {
  readonly id: number;
  readonly start: number;
  readonly end: number;
  readonly lease: LeaseImpl;
}

export type WaiterKind = 'acquire' | 'upgrade';

/** 排队中的请求。mode 为请求目标模式（upgrade 恒为 'exclusive'）。 */
export interface WaiterRecord {
  readonly id: number;
  readonly kind: WaiterKind;
  readonly start: number;
  readonly end: number;
  readonly mode: LockMode;
  /** 仅 upgrade：发起升级的租约（授予判定中需排除自身）。 */
  readonly lease: LeaseImpl | null;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  settled: boolean;
  resolve: (lease: LeaseImpl) => void;
  reject: (err: unknown) => void;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 半开区间重叠判定：[aStart, aEnd) 与 [bStart, bEnd)。 */
export function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 兼容 = 双方都是 shared。 */
export function compatible(a: LockMode, b: LockMode): boolean {
  return a === 'shared' && b === 'shared';
}
