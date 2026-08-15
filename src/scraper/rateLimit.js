/**
 * Rate-limit aware navigation for indiamart.com product pages.
 *
 * Measured on this account: a bulk run read about 16 product pages back to back
 * and every page after that answered HTTP 429 Too Many Requests. The limit is
 * per IP — a logged-in browser context was throttled exactly the same — and it
 * stayed closed for more than four minutes while requests kept arriving, so
 * retrying through it makes the block last longer, not shorter.
 *
 * The old code could not even see this: extractDetail swallowed the failure and
 * returned an empty record, so a throttled page was indistinguishable from a
 * page with no specifications, and the extractor retried it three times.
 */
import { log } from '../logger.js';

/** Raised when the site has shut us out and the run should stop cleanly. */
export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
    this.rateLimited = true;
  }
}

export const RATE_LIMIT = {
  /** Minimum gap between product-page requests. */
  spacingMs: 2500,
  /** Product pages read before pausing to let the budget refill. */
  batchSize: 8,
  /** Pause between batches. */
  batchPauseMs: 20000,
  /** Waits after consecutive 429s. The run stops once these run out. */
  backoffMs: [60000, 120000, 240000],
};

/**
 * Navigate to a product page, respecting the site's rate limit.
 *
 * Paces requests, waits out a 429 with increasing backoff, and gives up on the
 * whole run rather than hammering a closed door.
 *
 * @throws {RateLimitError} when the limit persists through every backoff.
 */
export class PagedReader {
  constructor({ spacing = RATE_LIMIT.spacingMs, batchSize = RATE_LIMIT.batchSize } = {}) {
    this.spacing = spacing;
    this.batchSize = batchSize;
    this.readsSincePause = 0;
    this.lastRequestAt = 0;
  }

  async _pace(page) {
    const since = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt && since < this.spacing) {
      await page.waitForTimeout(this.spacing - since);
    }
    if (this.readsSincePause >= this.batchSize) {
      log.info(
        `    read ${this.readsSincePause} pages — pausing ${Math.round(RATE_LIMIT.batchPauseMs / 1000)}s to stay under the rate limit`,
      );
      await page.waitForTimeout(RATE_LIMIT.batchPauseMs);
      this.readsSincePause = 0;
    }
  }

  /** @returns {Promise<number>} the HTTP status of the loaded page. */
  async open(page, url) {
    for (let attempt = 0; attempt <= RATE_LIMIT.backoffMs.length; attempt += 1) {
      await this._pace(page);
      this.lastRequestAt = Date.now();
      this.readsSincePause += 1;

      const response = await page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch(() => null);
      const status = response ? response.status() : 0;
      if (status !== 429) return status;

      const wait = RATE_LIMIT.backoffMs[attempt];
      if (wait === undefined) break;
      log.warn(
        `    HTTP 429 Too Many Requests — waiting ${Math.round(wait / 1000)}s before retrying ` +
          `(${attempt + 1}/${RATE_LIMIT.backoffMs.length})`,
      );
      await page.waitForTimeout(wait);
      // A fresh budget: stop counting the requests that were refused.
      this.readsSincePause = 0;
    }
    throw new RateLimitError(
      'indiamart.com is rate limiting this connection (HTTP 429). Nothing further was read; ' +
        'the products already extracted are saved. Wait a few minutes and run the extract again ' +
        'to continue where it stopped.',
    );
  }
}
