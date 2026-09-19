import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidIntervalError, InvalidModeError, IntervalLockManager } from '../src/index.js';

test('空区间被直接拒绝（同步抛出）', () => {
  const m = new IntervalLockManager();
  assert.throws(() => m.acquire({ start: 5, end: 5 }, 'shared'), InvalidIntervalError);
  assert.throws(() => m.acquire({ start: 0, end: 0 }, 'exclusive'), InvalidIntervalError);
});

test('反向区间被直接拒绝', () => {
  const m = new IntervalLockManager();
  assert.throws(() => m.acquire({ start: 10, end: 5 }, 'shared'), InvalidIntervalError);
  assert.throws(() => m.acquire({ start: 1, end: 0 }, 'exclusive'), InvalidIntervalError);
});

test('负数、非整数、非有限数边界被拒绝', () => {
  const m = new IntervalLockManager();
  assert.throws(() => m.acquire({ start: -1, end: 5 }, 'shared'), InvalidIntervalError);
  assert.throws(() => m.acquire({ start: 0.5, end: 5 }, 'shared'), InvalidIntervalError);
  assert.throws(() => m.acquire({ start: 0, end: 2.5 }, 'shared'), InvalidIntervalError);
  assert.throws(() => m.acquire({ start: Number.NaN, end: 5 }, 'shared'), InvalidIntervalError);
  assert.throws(() => m.acquire({ start: 0, end: Number.POSITIVE_INFINITY }, 'shared'), InvalidIntervalError);
  // @ts-expect-error 运行时防御非数值输入
  assert.throws(() => m.acquire({ start: '0', end: 5 }, 'shared'), InvalidIntervalError);
});

test('非法锁模式被拒绝', () => {
  const m = new IntervalLockManager();
  // @ts-expect-error 运行时防御非法模式
  assert.throws(() => m.acquire({ start: 0, end: 5 }, 'read'), InvalidModeError);
});

test('非法区间不会留下任何内部状态', () => {
  const m = new IntervalLockManager();
  assert.throws(() => m.acquire({ start: 3, end: 3 }, 'shared'), InvalidIntervalError);
  const snap = m.snapshot();
  assert.equal(snap.holders.length, 0);
  assert.equal(snap.waiters.length, 0);
});
