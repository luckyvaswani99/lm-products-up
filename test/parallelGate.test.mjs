/**
 * The safety primitives for running several category lanes at once.
 *
 * Each of these guards a failure that only appears when the work is done five
 * times over, so each test reproduces that failure rather than just exercising
 * the happy path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Breaker, Claims, Mutex, Semaphore, SharedPacer } from '../src/parallel/gate.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('Mutex serialises read-modify-write on shared state', async () => {
  // The product store is read whole and written whole. Without the lock, five
  // lanes interleave and four lanes' changes are lost to whoever saves last.
  const lock = new Mutex();
  let file = { products: [] };

  const laneSaves = (name) =>
    lock.run(async () => {
      const draft = { products: [...file.products] };
      await tick(); // the await that loses the write when it is not held
      draft.products.push(name);
      file = draft;
    });

  await Promise.all(['a', 'b', 'c', 'd', 'e'].map(laneSaves));
  assert.equal(file.products.length, 5, 'every lane’s write survived');
  assert.deepEqual([...file.products].sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('Mutex without the lock really does lose writes', async () => {
  // Proves the test above is testing something: the same body unguarded.
  let file = { products: [] };
  await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map(async (name) => {
      const draft = { products: [...file.products] };
      await tick();
      draft.products.push(name);
      file = draft;
    }),
  );
  assert.equal(file.products.length, 1, 'unguarded, only the last write remains');
});

test('Mutex hands over in order and a throwing lane does not keep the lock', async () => {
  const lock = new Mutex();
  const held = [];
  const failures = [];
  await Promise.all(
    [1, 2, 3].map((n) =>
      lock
        .run(async () => {
          held.push(n);
          if (n === 2) throw new Error('lane 2 failed');
        })
        .catch((error) => failures.push(error.message)),
    ),
  );
  assert.deepEqual(held, [1, 2, 3], 'lane 3 still got its turn after lane 2 threw');
  assert.deepEqual(failures, ['lane 2 failed'], 'the failure reaches its own lane, not the others');
  assert.equal(lock.held, false);
  assert.equal(lock.waiting, 0);
});

test('Semaphore caps concurrent background removal', async () => {
  const limit = new Semaphore(2);
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limit.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick();
        running -= 1;
      }),
    ),
  );
  assert.equal(peak, 2, 'never more than two rembg processes at once');
  assert.equal(limit.inUse, 0);
});

test('Semaphore rejects a nonsense size instead of running unbounded', () => {
  assert.throws(() => new Semaphore(0), /at least 1 permit/);
});

test('SharedPacer spaces requests across lanes, not per lane', async () => {
  // The 429 is counted per IP, so five lanes must share one budget. A pacer per
  // lane would let five requests through in the time one is allowed.
  let clock = 0;
  const waits = [];
  const pacer = new SharedPacer({
    spacingMs: 2500,
    batchSize: 8,
    batchPauseMs: 20000,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });

  // Five lanes ask at the same instant.
  await Promise.all([1, 2, 3, 4, 5].map(() => pacer.take()));

  assert.deepEqual(waits, [2500, 2500, 2500, 2500], 'four of the five had to wait their turn');
  assert.equal(clock, 10000, 'five requests took 4 x 2.5s, the single-lane rate');
  assert.equal(pacer.sincePause, 5);
});

test('SharedPacer takes the batch pause once for all lanes', async () => {
  let clock = 0;
  const waits = [];
  const pacer = new SharedPacer({
    spacingMs: 0,
    batchSize: 3,
    batchPauseMs: 20000,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });

  for (let i = 0; i < 7; i += 1) await pacer.take();

  assert.deepEqual(waits, [20000, 20000], 'two pauses for seven reads at a batch of three');
  assert.equal(pacer.pauses, 2);
});

test('Breaker holds every lane off after one lane sees a 429', async () => {
  let clock = 0;
  const breaker = new Breaker({ now: () => clock, wait: async (ms) => { clock += ms; } });
  assert.equal(breaker.isOpen, false);

  breaker.trip(60000);
  assert.equal(breaker.isOpen, true, 'one lane’s 429 stops all of them');

  // A second, shorter trip must not let everyone back in early.
  breaker.trip(1000);
  assert.equal(breaker.openUntil, 60000);
  assert.equal(breaker.trips, 1, 'the shorter trip was ignored, not counted');

  await breaker.wait();
  assert.equal(breaker.isOpen, false);
  assert.ok(clock >= 60000, 'the wait actually lasted the hold');
});

test('Claims give each product exactly one lane', () => {
  const claims = new Claims();
  assert.equal(claims.claimProduct('tadacip-20', 'mens-health'), null);
  assert.equal(
    claims.claimProduct('tadacip-20', 'pain-killer'),
    'mens-health',
    'a product in two category pages is uploaded once, by its first lane',
  );
  assert.equal(claims.claimProduct('tadacip-20', 'mens-health'), null, 'its own lane may re-claim');
  assert.equal(claims.ownerOf('tadacip-20'), 'mens-health');
  assert.equal(claims.ownerOf('unknown'), null);
});

test('Claims stop two lanes creating the same listing name at once', () => {
  const claims = new Claims();
  const release = claims.holdName('tadacip-20-mg-tablets', 'mens-health');
  assert.equal(typeof release, 'function');
  assert.equal(
    claims.holdName('tadacip-20-mg-tablets', 'pain-killer'),
    null,
    'the second lane must wait rather than race the duplicate lookup',
  );
  release();
  assert.equal(typeof claims.holdName('tadacip-20-mg-tablets', 'pain-killer'), 'function');
  assert.deepEqual(claims.heldNames(), ['tadacip-20-mg-tablets']);
});

test('Claims releasing is safe to call twice and never frees another lane’s hold', () => {
  const claims = new Claims();
  const release = claims.holdName('x', 'one');
  release();
  release();
  const second = claims.holdName('x', 'two');
  release(); // the first lane's stale release must not drop lane two's hold
  assert.equal(typeof second, 'function');
  assert.deepEqual(claims.heldNames(), ['x']);
});
