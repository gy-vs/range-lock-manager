import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IntervalLockManager,
  Lease,
  InvalidIntervalError,
  LockClosedError,
  InvalidLeaseError,
  LeaseReleasedError,
  UpgradeCanceledError,
  UpgradeConflictError,
  UpgradePendingError,
  LockError,
} from '../src/index.js';
import { LeaseImpl } from '../src/lease.js';
import type { IntervalLockManagerImpl } from '../src/manager.js';

/**
 * Flush the microtask queue exactly as Node does before setImmediate
 * callbacks: every already-settled promise chain runs to completion. No
 * timers, no polling -> the tests are fully deterministic.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Normalise synchronous throws and rejected promises into one assertion. */
async function assertRejectsWith<T extends Error>(
  fn: () => unknown,
  ctor: new () => T,
): Promise<void> {
  await assert.rejects(async () => {
    await Promise.resolve().then(fn);
  }, ctor);
}

async function assertNotSettled(p: Promise<unknown>): Promise<void> {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  assert.equal(settled, false, 'promise was expected to stay pending');
}

test('empty, reversed and malformed intervals are rejected synchronously', () => {
  const m = new IntervalLockManager();
  const emptyOrReversed: Array<[number, number]> = [
    [10, 10], // empty
    [10, 5], // reversed
    [0, 0], // empty at origin
  ];
  for (const [s, e] of emptyOrReversed) {
    assert.throws(() => m.acquire('shared', s, e), InvalidIntervalError);
    assert.throws(() => m.acquire('exclusive', s, e), InvalidIntervalError);
  }
  const malformed: Array<[number, number]> = [
    [Number.NaN, 10],
    [0, Number.POSITIVE_INFINITY],
    [1.5, 10],
    [Number.MIN_SAFE_INTEGER - 1, 0],
  ];
  for (const [s, e] of malformed) {
    assert.throws(() => m.acquire('shared', s, e), InvalidIntervalError);
  }
  assert.throws(
    () => m.acquire('write' as string as 'shared', 0, 1),
    TypeError,
  );
});

test('disjoint exclusive requests are granted in parallel', async () => {
  const m = new IntervalLockManager();
  const x1 = await m.acquire('exclusive', 0, 10);
  const x2 = await m.acquire('exclusive', 10, 20); // adjacent, half-open
  const x3 = await m.acquire('exclusive', 20, 40); // gap away
  assert.equal(m.holderCount, 3);
  x1.release();
  x2.release();
  x3.release();
  assert.equal(m.holderCount, 0);
});

test('overlapping exclusive queues and proceeds in FIFO order after release', async () => {
  const m = new IntervalLockManager();
  const x1 = await m.acquire('exclusive', 0, 100);
  const x2p = m.acquire('exclusive', 50, 150);
  const x3p = m.acquire('exclusive', 120, 200);
  await assertNotSettled(x2p);
  await assertNotSettled(x3p);

  x1.release();
  const x2 = await x2p;
  await assertNotSettled(x3p); // x3 overlaps x2 at [120,150)
  x2.release();
  const x3 = await x3p;
  x3.release();
});

test('overlapping shared requests run together; exclusive waits for all of them', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const s2 = await m.acquire('shared', 50, 150);
  const xp = m.acquire('exclusive', 0, 150);
  await assertNotSettled(xp);
  s1.release();
  await assertNotSettled(xp); // s2 still held
  s2.release();
  const x = await xp;
  x.release();
});

test('released exclusive wakes queued shared waiters', async () => {
  const m = new IntervalLockManager();
  const x = await m.acquire('exclusive', 0, 100);
  const s1p = m.acquire('shared', 0, 50);
  const s2p = m.acquire('shared', 50, 100);
  await assertNotSettled(s1p);
  await assertNotSettled(s2p);
  x.release();
  const [s1, s2] = await Promise.all([s1p, s2p]);
  assert.equal(m.holderCount, 2);
  s1.release();
  s2.release();
});

test('writer fairness: waiting exclusive blocks later overlapping shared but not disjoint shared', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const xp = m.acquire('exclusive', 0, 100); // writer waiting
  const sOverlap = m.acquire('shared', 50, 60); // must not overtake
  const sDisjoint = m.acquire('shared', 200, 300); // unaffected range
  await assertNotSettled(xp);
  await assertNotSettled(sOverlap);
  const sFar = await sDisjoint;
  assert.deepEqual(
    m.snapshot().waiters.map((w) => [w.mode, w.start, w.end]),
    [
      ['exclusive', 0, 100],
      ['shared', 50, 60],
    ],
  );

  s1.release();
  const x = await xp;
  await assertNotSettled(sOverlap); // exclusive now owns it
  x.release();
  const s = await sOverlap;
  s.release();
  sFar.release();
});

test('cancelling a queued writer immediately re-judges the queue', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const x1c = new AbortController();
  const x1p = m.acquire('exclusive', 0, 100, { signal: x1c.signal });
  const s2p = m.acquire('shared', 0, 40); // parked behind the writer
  await assertNotSettled(x1p);
  await assertNotSettled(s2p);
  assert.equal(m.waiterCount, 2);

  x1c.abort(new Error('give up'));
  // No placeholder remains; the shared behind it is granted at once.
  await assert.rejects(x1p, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /give up/);
    return true;
  });
  const s2 = await s2p;
  assert.equal(m.waiterCount, 0);
  assert.equal(m.holderCount, 2);

  s1.release();
  s2.release();
});

test('cancelling a middle waiter does not leave a phantom barrier', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const x1c = new AbortController();
  const x1p = m.acquire('exclusive', 0, 100, { signal: x1c.signal });
  // Blocked behind x1 by fairness AND by s1 as a holder.
  const x2p = m.acquire('exclusive', 0, 50);
  await assertNotSettled(x2p);

  x1c.abort();
  await assert.rejects(x1p);
  await assertNotSettled(x2p); // still held up by s1, not accidentally granted
  assert.equal(m.waiterCount, 1); // x1 is gone, no placeholder

  s1.release();
  const x2 = await x2p; // immediately judged again
  x2.release();
});

test('an already-aborted signal rejects without queueing; abort after grant is harmless', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const pre = new AbortController();
  pre.abort(new Error('late to the party'));
  await assert.rejects(
    m.acquire('exclusive', 0, 100, { signal: pre.signal }),
    /late to the party/,
  );
  assert.equal(m.waiterCount, 0);

  const c = new AbortController();
  const x = await m.acquire('exclusive', 300, 400, { signal: c.signal });
  c.abort(); // after grant: lease must be untouched
  assert.equal(x.active, true);
  x.release();
  s1.release();
});

test('upgrade shared -> exclusive grants when the interval is clear', async () => {
  const m = new IntervalLockManager();
  const s = await m.acquire('shared', 0, 100);
  await s.upgrade();
  assert.equal(s.mode, 'exclusive');
  // Upgrading an exclusive lease is a no-op, and release still works.
  await s.upgrade();
  s.release();
  assert.equal(s.active, false);
});

test('two overlapping shared upgrades: FIFO arbitration, loser keeps shared', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const s2 = await m.acquire('shared', 0, 100);

  // First upgrade call deterministically owns the claim.
  const up1 = s1.upgrade();
  await assertNotSettled(up1);
  const snap = m.snapshot();
  assert.deepEqual(
    snap.waiters.map((w) => [w.kind, w.leaseId, w.mode]),
    [['upgrade', s1.id, 'exclusive']],
  );

  // The loser receives an explicit error and keeps its shared lease.
  await assertRejectsWith(() => s2.upgrade(), UpgradeConflictError);
  assert.equal(s2.active, true);
  assert.equal(s2.mode, 'shared');
  assert.equal(m.waiterCount, 1);

  s2.release();
  await up1;
  assert.equal(s1.mode, 'exclusive');
  s1.release();
});

test('upgrade conflicts deterministically with an earlier exclusive acquire waiter', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const sFar = await m.acquire('shared', 0, 100); // ensure no grant can sneak
  const xp = m.acquire('exclusive', 0, 50); // queued earlier, overlaps s1
  await assertNotSettled(xp);
  sFar.release();
  await assertRejectsWith(() => s1.upgrade(), UpgradeConflictError);
  assert.equal(s1.mode, 'shared'); // keeps shared

  // A disjoint upgrade against that same waiter is fine.
  const sOther = await m.acquire('shared', 200, 300);
  await sOther.upgrade();
  assert.equal(sOther.mode, 'exclusive');

  s1.release();
  const x = await xp;
  x.release();
  sOther.release();
});

test('a waiting upgrade cannot be overtaken by later overlapping shared', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const s2 = await m.acquire('shared', 0, 100);
  const up1 = s1.upgrade();
  const s3p = m.acquire('shared', 0, 100); // parked behind the upgrade
  const s4 = await m.acquire('shared', 500, 600); // disjoint still flows
  await assertNotSettled(up1);
  await assertNotSettled(s3p);

  s2.release();
  await up1;
  assert.equal(s1.mode, 'exclusive');
  await assertNotSettled(s3p);
  s1.release();
  const s3 = await s3p;
  s3.release();
  s4.release();
});

test('only one pending upgrade per lease is allowed', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const s2 = await m.acquire('shared', 0, 100);
  const up1 = s1.upgrade();
  assert.throws(() => s1.upgrade(), UpgradePendingError); // synchronous
  s2.release();
  await up1; // the first, queued upgrade is unaffected by the rejected duplicate
  assert.equal(s1.mode, 'exclusive');
  s1.release();
});

test('aborting a pending upgrade keeps the shared lease and re-judges the queue', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const s2 = await m.acquire('shared', 0, 100);
  const c = new AbortController();
  const up = s1.upgrade({ signal: c.signal });
  const xp = m.acquire('exclusive', 0, 100); // behind the upgrade + s2
  await assertNotSettled(up);
  await assertNotSettled(xp);

  c.abort();
  await assert.rejects(up, (err: unknown) => (err as Error).name === 'AbortError');
  assert.equal(s1.active, true);
  assert.equal(s1.mode, 'shared');
  assert.equal(s1.upgradePending, false);
  await assertNotSettled(xp); // s1 still blocks the writer

  s2.release();
  await assertNotSettled(xp); // and s1 still blocks it
  s1.release();
  const x = await xp;
  x.release();
});

test('releasing a lease with a pending upgrade rejects the upgrade with LeaseReleasedError', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const s2 = await m.acquire('shared', 0, 100);
  const up = s1.upgrade();
  const xp = m.acquire('exclusive', 0, 100);

  s1.release();
  await assert.rejects(up, LeaseReleasedError);
  assert.equal(s1.active, false);
  s1.release(); // idempotent, no throw
  await assertNotSettled(xp); // s2 still present

  s2.release();
  const x = await xp;
  x.release();
});

test('downgrade exclusive -> shared admits waiting shared waiters', async () => {
  const m = new IntervalLockManager();
  const x = await m.acquire('exclusive', 0, 100);
  const s1p = m.acquire('shared', 0, 60);
  const s2p = m.acquire('shared', 60, 100);
  await assertNotSettled(s1p);
  x.downgrade();
  assert.equal(x.mode, 'shared');
  const [s1, s2] = await Promise.all([s1p, s2p]);
  x.downgrade(); // already shared: no-op
  s1.release();
  s2.release();
  x.release();
});

test('downgrade during a pending upgrade cancels it but keeps the shared lease', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const s2 = await m.acquire('shared', 0, 100);
  const up = s1.upgrade();
  await assertNotSettled(up);

  s1.downgrade();
  await assert.rejects(up, UpgradeCanceledError);
  assert.equal(s1.active, true);
  assert.equal(s1.mode, 'shared');
  assert.equal(s1.upgradePending, false);

  // Queue moves on: once s2 is gone an exclusive acquire over s1 still waits.
  s2.release();
  const xp = m.acquire('exclusive', 0, 100);
  await assertNotSettled(xp);
  s1.release();
  const x = await xp;
  x.release();

  const released = await m.acquire('shared', 0, 1);
  released.release();
  assert.throws(() => released.downgrade(), LeaseReleasedError);
});

test('close() rejects waiters, refuses new requests, but existing leases still release', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const wp1 = m.acquire('exclusive', 0, 100);
  const wp2 = m.acquire('shared', 0, 10);

  m.close();
  assert.equal(m.closed, true);
  await assert.rejects(wp1, LockClosedError);
  await assert.rejects(wp2, LockClosedError);
  assert.throws(() => m.acquire('shared', 0, 1), LockClosedError);
  assert.throws(() => s1.upgrade(), LockClosedError);

  // Held leases remain usable for release.
  assert.equal(s1.active, true);
  s1.release();
  assert.equal(s1.active, false);
  s1.release(); // still idempotent
  m.close(); // idempotent
});

test('snapshot is a detached, frozen read-only view', async () => {
  const m = new IntervalLockManager();
  const s1 = await m.acquire('shared', 0, 100);
  const s2 = await m.acquire('shared', 0, 30);
  void s2.upgrade();
  const xp = m.acquire('exclusive', 90, 110);
  await tick();

  const snap = m.snapshot();
  assert.equal(snap.closed, false);
  assert.deepEqual(
    snap.holders.map((h) => [h.id, h.mode, h.start, h.end, h.upgradePending]),
    [
      [s1.id, 'shared', 0, 100, false],
      [s2.id, 'shared', 0, 30, true],
    ],
  );
  assert.deepEqual(
    snap.waiters.map((w) => [w.kind, w.leaseId, w.mode, w.start, w.end]),
    [
      ['upgrade', s2.id, 'exclusive', 0, 30],
      ['acquire', undefined, 'exclusive', 90, 110],
    ],
  );

  // Everything reachable is frozen.
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.holders));
  assert.ok(Object.isFrozen(snap.waiters));
  assert.ok(Object.isFrozen(snap.holders[0]));
  assert.ok(Object.isFrozen(snap.waiters[0]));
  assert.throws(() => {
    (snap as { closed: boolean }).closed = true;
  }, TypeError);
  assert.throws(() => {
    (snap.holders as unknown as { push: (v: unknown) => void }).push({});
  }, TypeError);

  // Detached: later state changes do not mutate the captured snapshot.
  const before = JSON.stringify(snap);
  s1.release(); // the upgrade of s2 can now grant
  await tick();
  s2.release();
  const x = await xp; // queued behind the upgrade; granted once that released
  x.release();
  assert.equal(m.holderCount, 0);
  assert.equal(JSON.stringify(snap), before);
});

test('half-open adjacency does not conflict at the touching point', async () => {
  const m = new IntervalLockManager();
  const s = await m.acquire('shared', 0, 10);
  const x = await m.acquire('exclusive', 10, 20); // touches s exactly at 10
  const tail = m.acquire('exclusive', 5, 10); // overlaps s over [5,10); waits
  await assertNotSettled(tail);
  s.release();
  const x2 = await tail;
  assert.equal(x2.mode, 'exclusive');
  x.release();
  x2.release();
});

test('a lease from one manager is rejected by another', async () => {
  const a = new IntervalLockManager();
  const b = new IntervalLockManager();
  const lease = (await a.acquire('shared', 0, 10)) as LeaseImpl;
  const bi = b as unknown as IntervalLockManagerImpl;
  assert.throws(() => bi._releaseLease(lease), InvalidLeaseError);
  assert.throws(() => bi._upgradeLease(lease), InvalidLeaseError);
  assert.throws(() => bi._downgradeLease(lease), InvalidLeaseError);
  lease.release(); // its real owner can still release it
  assert.equal(a.holderCount, 0);
});

test('lease is a Lease instance and exposes read-only metadata', async () => {
  const m = new IntervalLockManager({ now: () => 1234 });
  const s = await m.acquire('shared', 7, 9);
  assert.ok(s instanceof LeaseImpl);
  assert.equal(s.start, 7);
  assert.equal(s.end, 9);
  assert.equal(s.mode, 'shared');
  assert.equal(s.grantedAt, 1234);
  assert.equal(typeof s.id, 'number');
  s.release();
});

test('deterministic randomized stress: mutual exclusion never violated', async () => {
  // Small xorshift PRNG -> the run is fully reproducible, no real timers.
  let seed = 0x1234_5678;
  const rnd = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };

  const m = new IntervalLockManager();
  // Reconstruct the active-set invariant from every snapshot we observe.
  const checkInvariant = (): void => {
    const { holders } = m.snapshot();
    for (let i = 0; i < holders.length; i++) {
      for (let j = i + 1; j < holders.length; j++) {
        const a = holders[i]!;
        const b = holders[j]!;
        const overlap = a.start < b.end && b.start < a.end;
        if (overlap) {
          assert.notEqual(a.mode, 'exclusive', `exclusive ${a.id} overlaps ${b.id}`);
          assert.notEqual(b.mode, 'exclusive', `exclusive ${b.id} overlaps ${a.id}`);
        }
      }
    }
  };

  const inFlight: Array<Promise<void>> = [];
  for (let n = 0; n < 400; n++) {
    const start = Math.floor(rnd() * 20);
    const len = 1 + Math.floor(rnd() * 8);
    const end = start + len;
    const mode: 'shared' | 'exclusive' = rnd() < 0.6 ? 'shared' : 'exclusive';

    if (mode === 'shared' && rnd() < 0.15) {
      // Sometimes exercise upgrades: acquire S, try to upgrade, always release.
      const p = (async (): Promise<void> => {
        const lease = await m.acquire('shared', start, end);
        checkInvariant();
        try {
          await lease.upgrade();
          checkInvariant();
          await tick();
        } catch (err) {
          assert.ok(err instanceof LockError);
        }
        if (rnd() < 0.2) lease.downgrade();
        lease.release();
        checkInvariant();
      })();
      inFlight.push(p);
    } else if (rnd() < 0.1) {
      // Sometimes abort a queued request.
      const ac = new AbortController();
      const p = m
        .acquire(mode, start, end, { signal: ac.signal })
        .then((lease) => {
          if (rnd() < 0.5) setImmediate(() => ac.abort()); // after grant: harmless
          lease.release();
          checkInvariant();
        })
        .catch(() => {});
      if (rnd() < 0.5) setImmediate(() => ac.abort()); // while queued: cancel
      inFlight.push(p);
    } else {
      const p = m
        .acquire(mode, start, end)
        .then((lease) => {
          checkInvariant();
          lease.release();
          checkInvariant();
        })
        .catch((err: unknown) => {
          assert.ok(err instanceof LockError);
        });
      inFlight.push(p);
    }

    if (n % 7 === 0) await tick(); // interleave scheduling deterministically
  }

  await Promise.all(inFlight);
  checkInvariant();
  assert.equal(m.holderCount, 0);
  assert.equal(m.waiterCount, 0);
});

test('all library errors share the LockError base and carry codes', () => {
  const cases: Array<[() => LockError, LockError['code']]> = [
    [() => new InvalidIntervalError(), 'INVALID_INTERVAL'],
    [() => new LockClosedError(), 'LOCK_CLOSED'],
    [() => new InvalidLeaseError(), 'INVALID_LEASE'],
    [() => new LeaseReleasedError(), 'LEASE_RELEASED'],
    [() => new UpgradeConflictError(), 'UPGRADE_CONFLICT'],
    [() => new UpgradePendingError(), 'UPGRADE_PENDING'],
    [() => new UpgradeCanceledError(), 'UPGRADE_CANCELED'],
  ];
  for (const [make, code] of cases) {
    const e = make();
    assert.equal(e.code, code);
    assert.ok(e instanceof Error);
  }
});
