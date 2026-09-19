# interval-lock

进程内（in-process）的**区间读写锁**，用于协调同一逻辑文件（或任意线性资源）上的并发读写。
纯 TypeScript，零运行时依赖，不使用任何锁库或区间树库，仅基于有序队列与半开区间重叠判定。

- 申请单位：半开整数区间 `[start, end)`，模式为 `shared`（读）或 `exclusive`（写）。
- 互不重叠的请求并行；重叠的 shared 并行；exclusive 与任何重叠请求互斥。
- 相邻区间不冲突：`[0,10)` 与 `[10,20)` 可并行。
- 申请返回一个 `Lease` 租约；`release()` **幂等**，空区间与反向区间**同步抛错拒绝**。
- 支持 shared → exclusive **升级** 与 exclusive → shared **降级**。
- 提供持有者 / 等待者的只读、冻结、深拷贝诊断快照。

要求 Node.js >= 18（内置 `AbortController`）；开发与 CI 使用 Node.js 20。

## 安装与构建

```bash
npm install
npm run build     # tsc -> dist/
npm test          # tsc + node --test
npm run typecheck # 测试与消费者侧类型检查
```

## 用法

```ts
import { IntervalLockManager } from 'interval-lock';
// 本仓库内：import { IntervalLockManager } from './src/index.js';

const locks = new IntervalLockManager();

// 读：重叠区间可共享
const r1 = await locks.acquire('shared', 0, 100);
const r2 = await locks.acquire('shared', 50, 150);

// 写：独占；这里会排队等 r1、r2 释放
const w = await locks.acquire('exclusive', 0, 150);

// 取消排队（已授予的锁不受影响）
const ac = new AbortController();
const late = locks.acquire('exclusive', 0, 10, { signal: ac.signal });
ac.abort(); // late 的 promise 以 abort reason reject，队列立即重新判定

// 升级 / 降级
const lease = await locks.acquire('shared', 0, 100);
await lease.upgrade();    // shared -> exclusive（保持区间，排队等待）
lease.downgrade();        // exclusive -> shared，立即放行兼容的等待读者
lease.release();          // 幂等；重复调用安全
lease.release();
```

关闭语义：

```ts
locks.close();                  // 新申请抛 LockClosedError；所有等待者以 LockClosedError 失败
locks.acquire('shared', 0, 1);  // throws LockClosedError
lease.release();                // 已发出的租约依然可以释放，且仍然幂等
```

## 队列与公平性规则

调度器是一个 FIFO 队列，在**每次**授予、释放、取消、升级、降级后跑一遍单趟扫描（`pump`）。
对队列中的每个请求，按到达顺序判断：

1. 与当前任何持有者在区间上重叠且模式不兼容 → 等待；
2. 或者与队列中**更早的、已经被迫等待的请求**重叠且不兼容 → 等待（防止插队）；
3. 否则立即授予。

由此得到的保证：

- **写者不饥饿**：一旦某 exclusive 在等待，后来与其重叠的 shared/exclusive 都不能越过它。
- **不相关区间不受牵连**：后来的请求若与等待中的写者区间不重叠，照常授予。
- **取消无占位残留**：取消等待请求后立即重新扫描全队列，后续兼容请求立刻被授予。

兼容性（区间重叠时）：

| 持有 \ 申请 | shared | exclusive |
| ----------- | ------ | --------- |
| shared      | ✓      | ✗         |
| exclusive   | ✗      | ✗         |

## 升级冲突的确定规则

两个 shared 持有者同时升级同一区间会死锁（各自等对方释放 shared）。规则定义为：

- 升级请求入队前，检查队列中是否存在**更早的、区间重叠的 exclusive 等待者**
  （包括另一个更早的升级请求）。
- 若存在，升级**立即、同步**抛 `UpgradeConflictError`，调用者**继续持有 shared**，
  可稍后重试或直接释放。
- 最早的那个 exclusive 等待者确定性获胜（FIFO，不依赖时序与 Promise 调度）。
- 不重叠的升级互不影响；升级等待期间仍作为屏障，后来的重叠请求不能插队。
- 每个租约同时至多有一个升级在等待，重复调用抛 `UpgradePendingError`。
- 已经是 exclusive 的租约调用 `upgrade()` 立即 resolve（no-op）。
- 升级等待中：
  - `release()`：释放租约，升级 promise 以 `LeaseReleasedError` reject；
  - `downgrade()`：放弃升级（promise 以 `UpgradeCanceledError` reject），保留 shared；
  - abort 升级所传的 `AbortSignal`：放弃升级、保留 shared、队列立即重新判定。

## 错误

所有错误都继承自 `LockError` 并带有稳定的 `code` 字符串：

| 错误 | code | 触发场景 |
| --- | --- | --- |
| `InvalidIntervalError` | `INVALID_INTERVAL` | `end <= start`、非安全整数、NaN/Infinity |
| `LockClosedError` | `LOCK_CLOSED` | `close()` 后新申请；等待者被关闭 |
| `InvalidLeaseError` | `INVALID_LEASE` | 租约不属于该 manager |
| `LeaseReleasedError` | `LEASE_RELEASED` | 升级等待期间租约被释放；对已释放租约 downgrade |
| `UpgradeConflictError` | `UPGRADE_CONFLICT` | 升级输给更早的重叠 exclusive 等待者 |
| `UpgradePendingError` | `UPGRADE_PENDING` | 同一租约重复升级 |
| `UpgradeCanceledError` | `UPGRADE_CANCELED` | 升级等待期间被 downgrade 取消 |

取消（abort）不使用上面的错误类：promise 以 `signal.reason` reject（未设置 reason 时为
`name === 'AbortError'` 的错误）。

## 诊断快照

```ts
const snap = locks.snapshot();
snap.closed;     // boolean
snap.holders;    // readonly LeaseSnapshot[]，按授予顺序
snap.waiters;    // readonly WaiterSnapshot[]，按 FIFO 顺序
```

快照是**冻结的纯数据深拷贝**（`Object.freeze` 递归到每个 DTO），不持有任何内部可变对象；
保留快照不会观察到后续状态变化。字段：

- holder：`id, mode, start, end, grantedAt, upgradePending`
- waiter：`kind('acquire'|'upgrade'), leaseId?(升级时), mode, start, end, queuedAt`

## 设计说明

- 所有状态变更都在同一个同步 tick 内完成并立即重新调度；事件循环单线程模型下无需原子操作。
- 没有使用区间树：授予判定为 O(holders + waiters) 的线性扫描；
  行为可证明、对测试确定性友好。
- 每个 waiter 的 promise 自带一个兜底 `catch`，取消与关闭竞速时不会产生 unhandled rejection。

## 项目结构

```
src/
  index.ts     公开导出
  manager.ts   队列、公平性泵、关闭、快照
  lease.ts     Lease 接口与内部实现
  errors.ts    LockError 层级
  types.ts     公共类型（模式、区间、快照 DTO）
test/          node:test 确定性测试（公平性 / 取消竞争 / 升级冲突 / 关闭 / 快照隔离）
type-tests/    消费者侧类型检查（公开面不含内部成员）
```

仅交付库与测试，没有命令行或界面。
