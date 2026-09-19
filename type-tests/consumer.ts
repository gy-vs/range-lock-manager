/* Consumer-side type checks compiled with the public package entry only.
   This file is excluded from the shipped build; it exists to prove the
   public typings hide implementation internals. */
import {
  IntervalLockManager,
  type Lease,
  InvalidIntervalError,
  LockError,
} from '../src/index.js';

const m = new IntervalLockManager();

async function usage(): Promise<void> {
  const lease: Lease = await m.acquire('shared', 0, 10);
  const id: number = lease.id;
  void id;
  if (lease.mode === 'shared') {
    await lease.upgrade();
    lease.downgrade();
  }
  lease.release();
  lease.release(); // idempotent

  const snap = m.snapshot();
  const first = snap.holders[0];
  if (first) void first.upgradePending;
  void snap.waiters.length;
  void m.closed;
  void m.holderCount;
  void m.waiterCount;
  m.close();
}

try {
  m.acquire('shared', 5, 5);
} catch (e) {
  if (e instanceof LockError) {
    const code: string = e.code;
    if (e instanceof InvalidIntervalError) void code;
  }
}

void usage;
