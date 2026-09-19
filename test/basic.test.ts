import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntervalLockManager } from '../src/index.js';
import type { Lease } from '../src/index.js';
import { flush, track } from './helpers.js';

test('exclusive 立即可授予，快照可见', async () => {
  const m = new IntervalLockManager();
  const lease = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  assert.equal(lease.mode, 'exclusive');
  assert.equal(lease.released, false);
  assert.deepEqual(lease.range, { start: 0, end: 10 });

  const snap = m.snapshot();
  assert.equal(snap.holders.length, 1);
  assert.equal(snap.holders[0]!.id, lease.id);
  assert.equal(snap.holders[0]!.mode, 'exclusive');
});

test('重叠 exclusive 互斥：后者等待，释放后授予', async () => {
  const m = new IntervalLockManager();
  const first = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const second = track(m.acquire({ start: 5, end: 15 }, 'exclusive'));

  await flush();
  assert.equal(second.settled, false, '重叠 exclusive 不应授予');

  first.release();
  const lease2 = await second.promise;
  assert.equal(lease2.mode, 'exclusive');
  assert.equal(m.snapshot().holders.length, 1);
});

test('重叠 shared 可并行', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'shared');
  const b = await m.acquire({ start: 5, end: 15 }, 'shared');
  assert.equal(m.snapshot().holders.length, 2);
  a.release();
  b.release();
  assert.equal(m.snapshot().holders.length, 0);
});

test('shared 与 exclusive 重叠时互斥', async () => {
  const m = new IntervalLockManager();
  const reader = await m.acquire({ start: 0, end: 10 }, 'shared');
  const writer = track(m.acquire({ start: 5, end: 15 }, 'exclusive'));
  await flush();
  assert.equal(writer.settled, false);

  reader.release();
  const w = await writer.promise;
  assert.equal(w.mode, 'exclusive');
});

test('半开区间相邻不重叠：[0,10) 与 [10,20) 可同时独占', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const b = track(m.acquire({ start: 10, end: 20 }, 'exclusive'));
  await flush();
  assert.equal(b.settled, true, '相邻区间不应互相阻塞');
  a.release();
  (await b.promise).release();
});

test('不重叠的 exclusive 可并行', async () => {
  const m = new IntervalLockManager();
  const a = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const b = await m.acquire({ start: 100, end: 200 }, 'exclusive');
  assert.equal(m.snapshot().holders.length, 2);
  a.release();
  b.release();
});

test('释放幂等：重复 release 无副作用，等待者只被授予一次', async () => {
  const m = new IntervalLockManager();
  const first = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const waiter = track(m.acquire({ start: 0, end: 10 }, 'exclusive'));
  await flush();

  first.release();
  first.release();
  first.release();
  assert.equal(first.released, true);

  const second: Lease = await waiter.promise;
  assert.equal(m.snapshot().holders.length, 1, '只应有一个持有者');
  assert.equal(m.snapshot().holders[0]!.id, second.id);

  second.release();
  second.release();
  assert.equal(m.snapshot().holders.length, 0);
});

test('lease.range 是冻结副本', async () => {
  const m = new IntervalLockManager();
  const lease = await m.acquire({ start: 1, end: 5 }, 'shared');
  assert.equal(Object.isFrozen(lease.range), true);
  assert.throws(() => {
    (lease.range as { start: number }).start = 99;
  }, TypeError);
  assert.equal(lease.range.start, 1);
  lease.release();
});
