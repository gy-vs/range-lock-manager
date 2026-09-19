import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntervalLockManager, ManagerClosedError } from '../src/index.js';
import { flush, track } from './helpers.js';

test('关闭后新申请被拒绝', async () => {
  const m = new IntervalLockManager();
  m.close();
  await assert.rejects(m.acquire({ start: 0, end: 5 }, 'shared'), ManagerClosedError);
  await assert.rejects(m.acquire({ start: 0, end: 5 }, 'exclusive'), ManagerClosedError);
});

test('关闭时所有等待者以 ManagerClosedError 失败', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 100 }, 'exclusive');

  const w1 = track(m.acquire({ start: 0, end: 10 }, 'exclusive'));
  const w2 = track(m.acquire({ start: 20, end: 30 }, 'shared'));
  await flush();
  assert.equal(m.snapshot().waiters.length, 2);

  m.close();
  await flush();
  assert.equal(w1.rejected, true);
  assert.equal(w2.rejected, true);
  assert.ok(w1.error instanceof ManagerClosedError);
  assert.ok(w2.error instanceof ManagerClosedError);
  assert.equal(m.snapshot().waiters.length, 0);

  holder.release();
});

test('关闭后已发出的租约仍可释放与降级', async () => {
  const m = new IntervalLockManager();
  const ex = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const sh = await m.acquire({ start: 100, end: 200 }, 'shared');

  m.close();
  assert.equal(m.closed, true);

  ex.downgrade(); // 关闭后降级仍可用（纯记账操作）
  assert.equal(ex.mode, 'shared');

  ex.release();
  sh.release();
  assert.equal(m.snapshot().holders.length, 0);
});

test('关闭时挂起的升级失败，但租约本身仍有效', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 0, end: 10 }, 'shared');

  const upgrading = track(a.upgrade());
  await flush();

  m.close();
  await flush();
  assert.equal(upgrading.rejected, true);
  assert.ok(upgrading.error instanceof ManagerClosedError);
  assert.equal(a.mode, 'shared', '升级失败不破坏原有租约');
  assert.equal(a.released, false);

  // 关闭后不允许新的升级
  await assert.rejects(b.upgrade(), ManagerClosedError);

  a.release();
  b.release();
  assert.equal(m.snapshot().holders.length, 0);
});

test('关闭是幂等的', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const waiter = track(m.acquire({ start: 0, end: 10 }, 'shared'));
  await flush();

  m.close();
  m.close();
  m.close();
  await flush();
  assert.equal(waiter.rejected, true);
  assert.equal(m.closed, true);

  holder.release();
});

test('关闭后快照仍可用且标记 closed', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'shared');
  m.close();

  const snap = m.snapshot();
  assert.equal(snap.closed, true);
  assert.equal(snap.holders.length, 1, '已发出的租约仍可见');
  assert.equal(snap.waiters.length, 0);

  holder.release();
  assert.equal(m.snapshot().holders.length, 0);
});
