/**
 * Rate-limit handling for indiamart.com product pages.
 *
 * Measured live: a bulk run read ~16 product pages back to back and every page
 * after that answered HTTP 429. The block is per IP — a logged-in browser
 * context was refused identically — and it outlasted four minutes of continued
 * requests, so retrying through it prolongs the block.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PagedReader, RATE_LIMIT, RateLimitError } from '../src/scraper/rateLimit.js';

/** A page stand-in that answers with the queued statuses and records waits. */
function fakePage(statuses) {
  const waits = [];
  let call = 0;
  return {
    waits,
    get requests() {
      return call;
    },
    async goto() {
      const status = statuses[Math.min(call, statuses.length - 1)];
      call += 1;
      return { status: () => status };
    },
    async waitForTimeout(ms) {
      waits.push(ms);
    },
  };
}

test('a normal page is read without waiting', async () => {
  const page = fakePage([200]);
  const reader = new PagedReader();
  assert.equal(await reader.open(page, 'https://example.test/a'), 200);
  assert.equal(page.requests, 1);
});

test('a 429 is waited out, not hammered', async () => {
  const page = fakePage([429, 429, 200]);
  const reader = new PagedReader();

  assert.equal(await reader.open(page, 'https://example.test/a'), 200);
  // One request per attempt — never a tight retry loop.
  assert.equal(page.requests, 3);
  // The two backoffs actually happened, in increasing order.
  const backoffs = page.waits.filter((ms) => RATE_LIMIT.backoffMs.includes(ms));
  assert.deepEqual(backoffs, [RATE_LIMIT.backoffMs[0], RATE_LIMIT.backoffMs[1]]);
});

test('a persistent 429 stops the run instead of continuing', async () => {
  const page = fakePage([429]);
  const reader = new PagedReader();

  await assert.rejects(() => reader.open(page, 'https://example.test/a'), RateLimitError);
  // Bounded: one try plus one per backoff, then it gives up.
  assert.equal(page.requests, RATE_LIMIT.backoffMs.length + 1);
});

test('requests are paced and batched', async () => {
  const page = fakePage([200]);
  const reader = new PagedReader({ spacing: 2500, batchSize: 8 });

  for (let i = 0; i < 9; i += 1) await reader.open(page, `https://example.test/${i}`);

  assert.equal(page.requests, 9);
  assert.ok(
    page.waits.includes(RATE_LIMIT.batchPauseMs),
    'a batch pause runs once the batch size is reached',
  );
});
