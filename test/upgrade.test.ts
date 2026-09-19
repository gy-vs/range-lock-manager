import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IntervalLockManager,
  LeaseReleasedError,
  UpgradeConflictError,
} from '../src/index.js';
import { flush, track } from './helpers.js';

test('无竞争升级立即生效，租约身份不变', async () => {
  const m = new IntervalLockManager();
  const lease = await m.acquire({ start: 0, end: 10 }, 'shared');

  const upgraded = await lease.upgrade();
  assert.equal(upgraded, lease, '升级 resolve 为同一租约对象');
  assert.equal(lease.mode, 'exclusive');
  assert.deepEqual(
    m.snapshot().holders.map((h) => ({ id: h.id, mode: h.mode })),
    [{ id: lease.id, mode: 'exclusive' }],
  );
  lease.release();
});

test('升级等待其他 shared 持有者释放后完成', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const upgrading = track(a.upgrade());
  await flush();
  assert.equal(upgrading.settled, false, 'b 仍持有 shared，升级必须等待');
  assert.equal(a.mode, 'shared', '等待期间仍是 shared');

  b.release();
  const upgraded = await upgrading.promise;
  assert.equal(upgraded, a);
  assert.equal(a.mode, 'exclusive');
  a.release();
});

test('升级冲突：两个 shared 同时升级，先到者胜，后者明确报错且保留 shared', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 5, end: 15 }, 'shared');

  const winnerUpgrade = track(a.upgrade()); // 先到者进入等待（b 还持有 shared）
  await flush();
  assert.equal(winnerUpgrade.settled, false);

  // 后到者立即失败，不死锁
  await assert.rejects(b.upgrade(), UpgradeConflictError);
  assert.equal(b.mode, 'shared', '失败方继续持有 shared');
  assert.equal(b.released, false);

  // 失败方让路后，先到者完成升级
  b.release();
  const winner = await winnerUpgrade.promise;
  assert.equal(winner, a);
  assert.equal(a.mode, 'exclusive');
  a.release();
});

test('升级冲突错误包含双方租约 id，且失败方保留 shared 可稍后重试成功', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const ac = new AbortController();
  const winnerUpgrade = track(a.upgrade({ signal: ac.signal })); // 先到者
  await flush();

  const err: UpgradeConflictError = await b.upgrade().then(
    () => assert.fail('应当拒绝'),
    (e) => e as UpgradeConflictError,
  );
  assert.equal(err.leaseId, b.id);
  assert.equal(err.conflictingLeaseId, a.id);
  assert.equal(b.mode, 'shared', '失败方继续持有 shared');

  // 先到者取消升级后冲突消失，失败方重试可正常排队并最终成功
  ac.abort();
  await flush();
  const retry = track(b.upgrade());
  await flush();
  assert.equal(retry.settled, false, 'a 仍持有 shared，b 的升级正常等待');

  a.release();
  const upgraded = await retry.promise;
  assert.equal(upgraded, b);
  assert.equal(b.mode, 'exclusive');
  b.release();
  await assert.rejects(winnerUpgrade.promise);
});

test('升级失败方保留 shared 并可继续正常使用', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const winnerUpgrade = track(a.upgrade());
  await flush();
  await assert.rejects(b.upgrade(), UpgradeConflictError);

  // b 仍是有效 shared 持有者：与新的 shared 请求兼容……
  // 但新 shared 不得越过 a 的挂起升级，所以这里验证 b 自身状态
  assert.equal(b.mode, 'shared');
  assert.equal(b.released, false);
  const snap = m.snapshot();
  assert.equal(snap.holders.length, 2);
  assert.equal(snap.waiters.length, 1);
  assert.equal(snap.waiters[0]!.kind, 'upgrade');
  assert.equal(snap.waiters[0]!.leaseId, a.id);

  b.release();
  await winnerUpgrade.promise;
  a.release();
});

test('升级等待期间，后来的重叠请求不得插队', async () => {
  const m = new IntervalLockManager();
  const events: string[] = [];
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const upgrading = a.upgrade();
  void upgrading.then(() => events.push('upgrade'));

  const lateReader = m.acquire({ start: 0, end: 10 }, 'shared');
  void lateReader.then(() => events.push('lateReader'));
  const lateWriter = m.acquire({ start: 0, end: 10 }, 'exclusive');
  void lateWriter.then(() => events.push('lateWriter'));

  await flush();
  assert.deepEqual(events, [], '升级挂起期间，后来的重叠请求一律不得插队');

  b.release(); // 放行升级
  await flush();
  assert.deepEqual(events, ['upgrade']);

  a.release(); // 升级后的 exclusive 释放 → lateReader（shared）授予
  await flush();
  assert.deepEqual(events, ['upgrade', 'lateReader']);
  // lateWriter 是 exclusive，必须等 lateReader 释放
  (await lateReader).release();
  await flush();
  assert.deepEqual(events, ['upgrade', 'lateReader', 'lateWriter']);

  (await lateWriter).release();
});

test('升级等待期间，不重叠请求照常授予', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const upgrading = track(a.upgrade());
  const elsewhere = track(m.acquire({ start: 100, end: 200 }, 'exclusive'));
  await flush();
  assert.equal(upgrading.settled, false);
  assert.equal(elsewhere.settled, true, '不重叠区间不受挂起升级影响');

  (await elsewhere.promise).release();
  b.release();
  (await upgrading.promise).release();
});

test('升级优先于已排队的普通 exclusive，避免互相等待死锁', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');

  // 普通 exclusive 排队等 a 释放
  const writer = track(m.acquire({ start: 0, end: 10 }, 'exclusive'));
  await flush();

  // a 发起升级：若排在 writer 之后，双方互相等待即死锁；本库规定升级优先
  const upgrading = track(a.upgrade());
  await flush();
  assert.equal(upgrading.settled, true, '升级应越过已排队请求立即授予，避免死锁');
  assert.equal(writer.settled, false);

  a.release();
  const w = await writer.promise;
  w.release();
});

test('降级：exclusive → shared 后排队的 shared 立即放行', async () => {
  const m = new IntervalLockManager();
  const writer = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const r1 = track(m.acquire({ start: 0, end: 10 }, 'shared'));
  const r2 = track(m.acquire({ start: 5, end: 15 }, 'shared'));
  await flush();
  assert.equal(r1.settled, false);
  assert.equal(r2.settled, false);

  const downgraded = writer.downgrade();
  assert.equal(downgraded, writer);
  assert.equal(writer.mode, 'shared');
  await flush();
  assert.equal(r1.settled, true, '降级后 shared 等待者应放行');
  assert.equal(r2.settled, true);

  writer.release();
  (await r1.promise).release();
  (await r2.promise).release();
});

test('对 shared 租约降级是空操作', async () => {
  const m = new IntervalLockManager();
  const lease = await m.acquire({ start: 0, end: 10 }, 'shared');
  assert.equal(lease.downgrade(), lease);
  assert.equal(lease.mode, 'shared');
  lease.release();
});

test('同一租约重复 upgrade 返回同一个 promise', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const p1 = a.upgrade();
  const p2 = a.upgrade();
  assert.equal(p1, p2, '挂起期间重复调用必须去重');

  b.release();
  await p1;
  // 已是 exclusive，再调用为空操作
  const p3 = await a.upgrade();
  assert.equal(p3, a);
  a.release();
});

test('升级等待中释放租约：升级以 LeaseReleasedError 失败，队列无残留', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const upgrading = track(a.upgrade());
  await flush();
  assert.equal(m.snapshot().waiters.length, 1);

  a.release();
  await flush();
  assert.equal(upgrading.rejected, true);
  assert.ok(upgrading.error instanceof LeaseReleasedError);
  assert.equal(m.snapshot().waiters.length, 0, '升级等待者必须随释放移除');

  b.release();
});

test('升级等待可被 AbortSignal 取消，租约保持 shared', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const ac = new AbortController();
  const upgrading = track(a.upgrade({ signal: ac.signal }));
  await flush();

  ac.abort();
  await flush();
  assert.equal(upgrading.rejected, true);
  assert.equal(a.mode, 'shared', '取消升级后租约仍是 shared');
  assert.equal(a.released, false);
  assert.equal(m.snapshot().waiters.length, 0);

  // 取消后 b 可以发起自己的升级（无冲突残留）
  const bUpgrade = track(b.upgrade());
  await flush();
  assert.equal(bUpgrade.settled, false, 'a 仍持有 shared，b 的升级正常排队');

  a.release();
  (await bUpgrade.promise).release();
});

test('已释放租约：upgrade 拒绝，downgrade 抛错', async () => {
  const m = new IntervalLockManager();
  const lease = await m.acquire({ start: 0, end: 10 }, 'shared');
  lease.release();

  await assert.rejects(lease.upgrade(), LeaseReleasedError);
  assert.throws(() => lease.downgrade(), LeaseReleasedError);
});

test('不重叠的多个升级可同时进行', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 10, end: 20 }, 'shared');
  const other = await m.acquire({ start: 0, end: 20 }, 'shared');

  const upA = track(a.upgrade());
  const upB = track(b.upgrade());
  await flush();
  assert.equal(upA.settled, false, '被 other 挡住');
  assert.equal(upB.settled, false, '被 other 挡住');

  other.release();
  await flush();
  assert.equal(upA.settled, true);
  assert.equal(upB.settled, true);
  a.release();
  b.release();
});
