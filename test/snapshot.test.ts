import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntervalLockManager } from '../src/index.js';
import { flush, track } from './helpers.js';

test('快照按确定顺序反映持有者与等待者', async () => {
  const m = new IntervalLockManager();
  const h1 = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const h2 = await m.acquire({ start: 100, end: 200 }, 'shared');

  const w1 = m.acquire({ start: 5, end: 15 }, 'shared');
  const w2 = m.acquire({ start: 0, end: 10 }, 'exclusive');
  await flush();

  const snap = m.snapshot();
  assert.equal(snap.closed, false);
  assert.deepEqual(
    snap.holders.map((h) => h.id),
    [h1.id, h2.id],
  );
  assert.deepEqual(
    snap.waiters.map((w) => [w.kind, w.mode] as const),
    [
      ['acquire', 'shared'],
      ['acquire', 'exclusive'],
    ],
  );
  assert.deepEqual(snap.waiters[0]!.range, { start: 5, end: 15 });

  h1.release();
  h2.release();
  (await w1).release();
  (await w2).release();
});

test('快照深度冻结：任何层级的修改都会抛错', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'shared');
  const waiter = track(m.acquire({ start: 0, end: 10 }, 'exclusive'));
  await flush();

  const snap = m.snapshot();
  assert.equal(Object.isFrozen(snap), true);
  assert.equal(Object.isFrozen(snap.holders), true);
  assert.equal(Object.isFrozen(snap.waiters), true);
  assert.equal(Object.isFrozen(snap.holders[0]), true);
  assert.equal(Object.isFrozen(snap.holders[0]!.range), true);
  assert.equal(Object.isFrozen(snap.waiters[0]), true);
  assert.equal(Object.isFrozen(snap.waiters[0]!.range), true);

  // ES 模块为严格模式，修改冻结对象抛 TypeError
  assert.throws(() => {
    (snap as { closed: boolean }).closed = true;
  }, TypeError);
  assert.throws(() => {
    (snap.holders as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (snap.holders[0]!.range as { start: number }).start = 99;
  }, TypeError);

  holder.release();
  (await waiter.promise).release();
});

test('快照是时间点拷贝：之后的内部变化不影响已取快照', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const waiter = track(m.acquire({ start: 0, end: 10 }, 'shared'));
  await flush();

  const before = m.snapshot();
  assert.equal(before.holders.length, 1);
  assert.equal(before.waiters.length, 1);

  holder.release(); // 触发授予，内部状态变化
  await flush();

  assert.equal(before.holders.length, 1, '旧快照不随内部状态变化');
  assert.equal(before.waiters.length, 1);
  assert.equal(before.holders[0]!.mode, 'exclusive');

  const after = m.snapshot();
  assert.equal(after.holders.length, 1);
  assert.equal(after.waiters.length, 0);
  assert.equal(after.holders[0]!.id, (await waiter.promise).id);

  (await waiter.promise).release();
});

test('快照不暴露内部可变对象：与租约、后续快照均为不同引用', async () => {
  const m = new IntervalLockManager();
  const lease = await m.acquire({ start: 0, end: 10 }, 'shared');

  const s1 = m.snapshot();
  const s2 = m.snapshot();
  assert.notEqual(s1, s2);
  assert.notEqual(s1.holders, s2.holders);
  assert.notEqual(s1.holders[0], s2.holders[0]);
  assert.notEqual(s1.holders[0]!.range, s2.holders[0]!.range);
  assert.notEqual(s1.holders[0]!.range, lease.range, '快照区间不得与租约共享引用');

  lease.release();
});

test('升级等待者的快照包含 kind 与 leaseId', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const upgrading = track(a.upgrade());
  await flush();

  const snap = m.snapshot();
  assert.equal(snap.waiters.length, 1);
  assert.equal(snap.waiters[0]!.kind, 'upgrade');
  assert.equal(snap.waiters[0]!.mode, 'exclusive');
  assert.equal(snap.waiters[0]!.leaseId, a.id);
  // 挂起升级的租约仍是 shared 持有者
  assert.deepEqual(
    snap.holders.map((h) => h.mode),
    ['shared', 'shared'],
  );

  b.release();
  (await upgrading.promise).release();
});
