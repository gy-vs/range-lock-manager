# range-lock-manager

进程内区间锁库：协调同一逻辑文件上的并发读写。调用者按**半开区间** `[start, end)`
申请 `shared` 或 `exclusive` 锁，获得租约（Lease）；支持公平排队、取消、
升级/降级与只读诊断快照。零运行时依赖，TypeScript + Node.js 20。

## 构建与测试

```bash
npm install
npm run build   # 编译到 dist/
npm test        # 编译并运行全部确定性测试（node:test）
```

## 快速上手

```ts
import { IntervalLockManager } from 'range-lock-manager';

const locks = new IntervalLockManager();

// 读 [0, 1024)：shared，可与其他 shared 并行
const reader = await locks.acquire({ start: 0, end: 1024 }, 'shared');
try {
  // ... 读取 ...
} finally {
  reader.release(); // 幂等，重复调用安全
}

// 写 [512, 2048)：exclusive，独占
const writer = await locks.acquire({ start: 512, end: 2048 }, 'exclusive');
// 原地降级为 shared，放行排队的读者
writer.downgrade();
writer.release();

// 取消等待中的申请
const ac = new AbortController();
const pending = locks.acquire({ start: 0, end: 100 }, 'exclusive', { signal: ac.signal });
ac.abort();
await pending.catch((err) => console.log('已取消', err));

// 诊断快照（深冻结，可安全留存/传递）
console.log(locks.snapshot());

locks.close(); // 拒绝新申请，等待者失败；已发出的租约仍可释放
```

## API

### `IntervalLockManager`

| 方法 | 说明 |
| --- | --- |
| `acquire(interval, mode, options?) => Promise<Lease>` | 申请锁。区间/模式非法**同步抛出**；关闭后或信号已中止则 reject。 |
| `snapshot() => LockManagerSnapshot` | 持有者与等待者的只读快照（深拷贝 + 深冻结）。 |
| `close() => void` | 关闭。幂等。等待者以 `ManagerClosedError` 失败。 |
| `closed => boolean` | 是否已关闭。 |

`interval` 为半开区间 `{ start, end }`：非负安全整数且 `start < end`。
空区间、反向区间、负数、非整数、非有限数一律抛出 `InvalidIntervalError`。
`options.signal`（`AbortSignal`）用于取消等待中的请求。

### `Lease`（租约）

| 成员 | 说明 |
| --- | --- |
| `id` / `range` / `mode` / `released` | 只读属性；`range` 为冻结副本，`mode` 随升级/降级变化。 |
| `release() => void` | 释放。**幂等**。 |
| `upgrade(options?) => Promise<Lease>` | shared → exclusive。成功时 resolve 为同一租约对象。 |
| `downgrade() => Lease` | exclusive → shared，同步生效；对 shared 为空操作。 |

## 语义规则

### 兼容矩阵

只有 `shared` + `shared` 兼容；涉及 `exclusive` 的组合在区间重叠时互斥。
不重叠的请求（含与等待者不重叠的）永远可以立即授予。

### 公平性（防写饥饿）

请求按到达顺序进入 FIFO 队列。队列中的请求可被授予，当且仅当：

1. 与所有**已持有**租约无「重叠且不兼容」冲突；
2. 与队列中**排在它前面**的所有请求无「重叠且不兼容」冲突。

因此等待中的 `exclusive` 会挡住后来的重叠 `shared`（写者不会饿死），
而不重叠的请求不受队列影响。每次释放/取消/降级后按队列顺序重判，
取消的请求立即移出队列，不留占位状态。

### 升级（防死锁）

- 升级请求排在所有**普通等待者之前**（升级者已持有 shared，若排在已排队
  `exclusive` 之后会互相等待形成死锁）；多个升级之间仍按到达顺序。
- 同一重叠区域同一时刻只允许一个挂起升级：**先到者胜**。后到者立即以
  `UpgradeConflictError` 失败，**继续持有 shared**，可稍后重试。
  两个 shared 同时升级因此不会死锁。
- 升级等待期间，后来的重叠请求（无论 shared 还是 exclusive）不得插队。
- 升级等待可用 `AbortSignal` 取消，租约保持 shared。

### 关闭

`close()` 后：新申请与升级以 `ManagerClosedError` 被拒绝，所有等待者立即失败；
已发出的租约仍可正常 `release()` / `downgrade()`。

### 快照

`snapshot()` 返回 `{ closed, holders, waiters }`，全部深拷贝并 `Object.freeze`，
不暴露任何内部可变对象；等待者按队列顺序排列，升级等待者带 `leaseId`。

## 错误类型

`IntervalLockError`（基类）、`InvalidIntervalError`、`InvalidModeError`、
`ManagerClosedError`、`UpgradeConflictError`、`LeaseReleasedError`、
`LockCancelledError`。取消时优先透传 `AbortSignal.reason`。

## 实现说明

- 无锁/区间树依赖：持有者为 `Map`，等待者为 FIFO 数组，授予判定为
  O(持有者 + 队列长度) 的重叠扫描，每次状态变更后单趟顺序重判。
- 所有判定在管理器内部同步完成，promise 仅作通知，行为完全确定。
