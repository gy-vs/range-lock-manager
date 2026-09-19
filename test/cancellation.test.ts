import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntervalLockManager } from '../src/index.js';
import { flush, track } from './helpers.js';

test('取消等待中的请求：拒绝且队列不留占位', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'exclusive');

  const ac = new AbortController();
  const pending = track(m.acquire({ start: 0, end: 10 }, 'exclusive', { signal: ac.signal }));
  await flush();
  assert.equal(m.snapshot().waiters.length, 1);

  ac.abort();
  await flush();
  assert.equal(pending.settled, true);
  assert.equal(pending.rejected, true);
  assert.equal((pending.error as DOMException).name, 'AbortError');
  assert.equal(m.snapshot().waiters.length, 0, '取消后不得留下占位状态');

  holder.release();
});

test('取消后立即重判：被挡在取消者后面的 shared 立刻放行', async () => {
  const m = new IntervalLockManager();
  const reader = await m.acquire({ start: 0, end: 10 }, 'shared');

  const ac = new AbortController();
  const writer = track(m.acquire({ start: 0, end: 10 }, 'exclusive', { signal: ac.signal }));
  const lateReader = track(m.acquire({ start: 0, end: 10 }, 'shared'));
  await flush();
  assert.equal(lateReader.settled, false, '被等待中的 exclusive 挡住');

  ac.abort(); // 取消写者 → 立即重判 → lateReader 与持有者兼容，应授予
  await flush();
  assert.equal(writer.rejected, true);
  assert.equal(lateReader.settled, true, '取消后必须立即重判后续队列');
  assert.equal(m.snapshot().waiters.length, 0);

  (await lateReader.promise).release();
  reader.release();
});

test('取消竞争：授予先发生时，之后的 abort 无效', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'exclusive');

  const ac = new AbortController();
  const pending = track(m.acquire({ start: 0, end: 10 }, 'exclusive', { signal: ac.signal }));
  await flush();

  holder.release(); // 同步授予
  ac.abort(); // 此时请求已 settle，abort 不应产生影响
  await flush();

  assert.equal(pending.settled, true);
  assert.equal(pending.rejected, false, '授予在取消之前完成，租约必须有效');
  const lease = await pending.promise;
  assert.equal(lease.released, false);
  lease.release();
});

test('取消竞争：abort 先发生时，之后的释放不会复活请求', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'exclusive');

  const ac = new AbortController();
  const pending = track(m.acquire({ start: 0, end: 10 }, 'exclusive', { signal: ac.signal }));
  await flush();

  ac.abort();
  holder.release(); // 队列已空，无事发生
  await flush();

  assert.equal(pending.rejected, true);
  assert.equal(m.snapshot().holders.length, 0);
  assert.equal(m.snapshot().waiters.length, 0);
});

test('已中止信号立即拒绝，不进入队列', async () => {
  const m = new IntervalLockManager();
  const ac = new AbortController();
  ac.abort();

  const pending = track(m.acquire({ start: 0, end: 5 }, 'shared', { signal: ac.signal }));
  await flush();
  assert.equal(pending.rejected, true);
  assert.equal(m.snapshot().waiters.length, 0);
  assert.equal(m.snapshot().holders.length, 0);
});

test('自定义 abort reason 原样透传', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'exclusive');

  const ac = new AbortController();
  const pending = track(m.acquire({ start: 0, end: 10 }, 'shared', { signal: ac.signal }));
  await flush();

  const reason = new Error('调用方主动取消');
  ac.abort(reason);
  await flush();
  assert.equal(pending.rejected, true);
  assert.equal(pending.error, reason);

  holder.release();
});

test('取消多个等待者中的一个，其余顺序不变', async () => {
  const m = new IntervalLockManager();
  const events: string[] = [];
  const holder = await m.acquire({ start: 0, end: 100 }, 'exclusive');

  const ac = new AbortController();
  const w1 = m.acquire({ start: 0, end: 10 }, 'exclusive', { signal: ac.signal });
  void w1.catch(() => events.push('w1:cancelled'));
  const w2 = m.acquire({ start: 20, end: 30 }, 'exclusive');
  void w2.then(() => events.push('w2'));
  const w3 = m.acquire({ start: 40, end: 50 }, 'exclusive');
  void w3.then(() => events.push('w3'));

  await flush();
  assert.equal(m.snapshot().waiters.length, 3);

  ac.abort();
  await flush();
  assert.deepEqual(events, ['w1:cancelled']);
  assert.equal(m.snapshot().waiters.length, 2);

  holder.release();
  await flush();
  assert.deepEqual(events, ['w1:cancelled', 'w2', 'w3']);
  for (const p of [w2, w3]) (await p).release();
  await assert.rejects(w1);
});

test('重复 abort 幂等，只拒绝一次', async () => {
  const m = new IntervalLockManager();
  const holder = await m.acquire({ start: 0, end: 10 }, 'exclusive');

  const ac = new AbortController();
  const pending = track(m.acquire({ start: 0, end: 10 }, 'shared', { signal: ac.signal }));
  await flush();

  ac.abort();
  ac.abort(); // AbortController 本身只触发一次，这里验证管理器侧也无重复副作用
  await flush();
  assert.equal(pending.rejected, true);
  assert.equal(m.snapshot().waiters.length, 0);

  holder.release();
});
