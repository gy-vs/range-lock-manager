/**
 * 测试公共工具：微任务/宏任务冲刷与 promise 状态跟踪。
 * 所有判定在管理器内部都是同步完成的，因此一次 setImmediate
 * 足以冲刷由它派生的全部 promise 回调，测试结果是确定的。
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 跟踪 promise 的 settle 状态，用于确定性断言「尚未授予 / 已失败」。 */
export class Tracker<T> {
  settled = false;
  rejected = false;
  value: T | undefined;
  error: unknown;

  constructor(readonly promise: Promise<T>) {
    promise.then(
      (v) => {
        this.settled = true;
        this.value = v;
      },
      (e) => {
        this.settled = true;
        this.rejected = true;
        this.error = e;
      },
    );
  }
}

export function track<T>(promise: Promise<T>): Tracker<T> {
  return new Tracker(promise);
}
