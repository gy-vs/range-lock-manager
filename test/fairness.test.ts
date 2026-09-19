import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntervalLockManager } from '../src/index.js';
import { flush, track } from './helpers.js';

test('防写饥饿：等待中的 exclusive 挡住后来的重叠 shared', async () => {
  const m = new IntervalLockManager();
  const events: string[] = [];

  const reader = await m.acquire({ start: 0, end: 10 }, 'shared');

  const writer = m.acquire({ start: 0, end: 10 }, 'exclusive');
  void writer.then(() => events.push('writer'));
  const lateReader = m.acquire({ start: 0, end: 10 }, 'shared');
  void lateReader.then(() => events.push('lateReader'));

  await flush();
  // 后来的 shared 与现有持有者兼容，但不得越过等待中的 exclusive
  assert.deepEqual(events, []);
  // 队列顺序确定：writer 在前，lateReader 在后
  const snap = m.snapshot();
  assert.deepEqual(
    snap.waiters.map((w) => w.mode),
    ['exclusive', 'shared'],
  );

  reader.release();
  await flush();
  assert.deepEqual(events, ['writer'], 'writer 必须先于 lateReader 授予');

  const writerLease = await writer;
  writerLease.release();
  await flush();
  assert.deepEqual(events, ['writer', 'lateReader']);

  (await lateReader).release();
  assert.equal(m.snapshot().holders.length, 0);
});

test('持续的 shared 流无法饿死已排队的 exclusive', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'shared');
  const writer = track(m.acquire({ start: 0, end: 10 }, 'exclusive'));

  // 写者排队后再来一批 shared，全部必须排在写者后面
  const lateReaders = Array.from({ length: 5 }, () =>
    track(m.acquire({ start: 0, end: 10 }, 'shared')),
  );
  await flush();
  for (const r of lateReaders) assert.equal(r.settled, false);
  assert.equal(m.snapshot().waiters.length, 6);

  holder.release();
  const writerLease = await writer.promise;
  assert.equal(writerLease.mode, 'exclusive');
  // 写者持有时，shared 继续等待
  await flush();
  for (const r of lateReaders) assert.equal(r.settled, false);

  writerLease.release();
  await flush();
  for (const r of lateReaders) assert.equal(r.settled, true, '写者释放后 shared 批量放行');
  for (const r of lateReaders) r.value!.release();
});

test('不重叠请求不受等待队列影响，仍可立即授予', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'exclusive');
  const blocked = track(m.acquire({ start: 5, end: 15 }, 'exclusive'));

  // 与等待者及持有者都不重叠：立即授予
  const free = track(m.acquire({ start: 100, end: 200 }, 'exclusive'));
  await flush();
  assert.equal(blocked.settled, false);
  assert.equal(free.settled, true);

  (await free.promise).release();
  holder.release();
  (await blocked.promise).release();
});

test('同模式等待者按 FIFO 顺序授予', async () => {
  const m = new IntervalLockManager();
  const events: string[] = [];
  const holder = await m.acquire({ start: 0, end: 100 }, 'exclusive');

  const w1 = m.acquire({ start: 0, end: 10 }, 'exclusive');
  void w1.then(() => events.push('w1'));
  const w2 = m.acquire({ start: 20, end: 30 }, 'exclusive');
  void w2.then(() => events.push('w2'));
  const w3 = m.acquire({ start: 40, end: 50 }, 'exclusive');
  void w3.then(() => events.push('w3'));

  await flush();
  assert.deepEqual(events, []);

  holder.release();
  await flush();
  // 三者互不重叠，但授予顺序仍按队列顺序确定
  assert.deepEqual(events, ['w1', 'w2', 'w3']);
  for (const p of [w1, w2, w3]) (await p).release();
});

test('共享段在 exclusive 之后批量放行，且保持确定性顺序', async () => {
  const m = new IntervalLockManager();
  const events: string[] = [];
  const holder = await m.acquire({ start: 0, end: 100 }, 'exclusive');

  const w = m.acquire({ start: 0, end: 100 }, 'exclusive');
  void w.then(() => events.push('W'));
  const s1 = m.acquire({ start: 0, end: 50 }, 'shared');
  void s1.then(() => events.push('S1'));
  const s2 = m.acquire({ start: 25, end: 75 }, 'shared');
  void s2.then(() => events.push('S2'));

  holder.release();
  await flush();
  assert.deepEqual(events, ['W']);

  (await w).release();
  await flush();
  assert.deepEqual(events, ['W', 'S1', 'S2'], '两个重叠 shared 应同批放行且按入队顺序');
  for (const p of [s1, s2]) (await p).release();
});
