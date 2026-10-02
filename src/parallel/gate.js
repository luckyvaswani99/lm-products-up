/**
 * The shared parts that make several lanes safe to run at once.
 *
 * Running five categories in parallel multiplies everything this tool does:
 * requests to IndiaMART, writes to the product store, and rembg processes on a
 * four-core CPU. Each primitive here exists because one of those breaks when it
 * is simply done five times over.
 */
import { log } from '../logger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One holder at a time, FIFO.
 *
 * The product store is a single JSON file that is read whole and written whole.
 * Five lanes each doing load → change → save would lose four lanes' work to
 * whoever saved last, so every read-modify-write goes through one of these.
 */
export class Mutex {
  constructor() {
    this._queue = [];
    this._held = false;
  }

  async run(fn) {
    await this._acquire();
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  get held() {
    return this._held;
  }

  get waiting() {
    return this._queue.length;
  }

  _acquire() {
    if (!this._held) {
      this._held = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._queue.push(resolve));
  }

  _release() {
    const next = this._queue.shift();
    if (next) next();
    else this._held = false;
  }
}

/**
 * At most `permits` holders at a time.
 *
 * Used for the local work that is CPU-bound rather than waiting on IndiaMART:
 * background removal runs a Python process per photo, and five at once on this
 * machine's four cores makes every lane slower than one lane would have been.
 */
export class Semaphore {
  constructor(permits) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore needs at least 1 permit, got ${permits}`);
    }
    this.permits = permits;
    this._free = permits;
    this._queue = [];
  }

  get inUse() {
    return this.permits - this._free;
  }

  get waiting() {
    return this._queue.length;
  }

  async run(fn) {
    await this._acquire();
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  _acquire() {
    if (this._free > 0) {
      this._free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._queue.push(resolve));
  }

  _release() {
    const next = this._queue.shift();
    if (next) next();
    else this._free += 1;
  }
}

/**
 * One request budget for the whole process, however many lanes share it.
 *
 * Measured on this connection: about 16 product pages read back to back and
 * every page after that answered HTTP 429, per IP — a logged-in context was
 * refused identically, and it stayed closed for over four minutes while
 * requests kept arriving. PagedReader paced itself, but a pacer per lane is
 * five times the rate on the one IP that is being counted, which turns the
 * limit from something avoided into something guaranteed.
 *
 * So the budget lives here, outside the lanes: spacing is enforced between
 * requests from ANY lane, and the batch pause is taken once for all of them.
 */
export class SharedPacer {
  constructor({ spacingMs, batchSize, batchPauseMs, now = () => Date.now(), wait = sleep } = {}) {
    this.spacingMs = spacingMs;
    this.batchSize = batchSize;
    this.batchPauseMs = batchPauseMs;
    this._now = now;
    this._wait = wait;
    this._lock = new Mutex();
    // "Has a request gone out yet" is kept as its own flag rather than read off
    // lastAt: a clock that legitimately reads 0 would otherwise look like "no
    // request yet" forever, and the pacer would never space anything.
    this._started = false;
    this.lastAt = 0;
    this.sincePause = 0;
    this.pauses = 0;
  }

  /**
   * Wait until it is this caller's turn to make one request.
   *
   * The lock is held for the whole wait on purpose: that is what makes two
   * lanes take their turns one after another instead of both deciding the gap
   * has passed and going at the same moment.
   */
  async take() {
    await this._lock.run(async () => {
      if (this.sincePause >= this.batchSize) {
        this.pauses += 1;
        log.info(
          `    read ${this.sincePause} pages across all lanes — pausing ` +
            `${Math.round(this.batchPauseMs / 1000)}s to stay under the rate limit`,
        );
        await this._wait(this.batchPauseMs);
        this.sincePause = 0;
        this._started = false;
      }
      const since = this._now() - this.lastAt;
      if (this._started && since < this.spacingMs) {
        await this._wait(this.spacingMs - since);
      }
      this._started = true;
      this.lastAt = this._now();
      this.sincePause += 1;
    });
  }

  /** A 429 means the budget was wrong; forget it and start counting again. */
  reset() {
    this.sincePause = 0;
    this._started = false;
  }
}

/**
 * Stop every lane when IndiaMART starts refusing, not just the one that saw it.
 *
 * The limit is per IP, so a 429 in one lane is a statement about the whole
 * process. Without this the other four lanes keep knocking while the door is
 * shut, which is what makes the block last longer.
 */
export class Breaker {
  constructor({ wait = sleep, now = () => Date.now() } = {}) {
    this._wait = wait;
    this._now = now;
    this.openUntil = 0;
    this.trips = 0;
  }

  get isOpen() {
    return this.openUntil > this._now();
  }

  /** Hold everyone off for `ms`. Repeated trips do not shorten an open hold. */
  trip(ms, reason = 'HTTP 429') {
    const until = this._now() + ms;
    if (until <= this.openUntil) return;
    this.trips += 1;
    this.openUntil = until;
    log.warn(`  all lanes paused ${Math.round(ms / 1000)}s — ${reason} (IndiaMART limits per IP)`);
  }

  /** Called before any portal request; returns once the hold has passed. */
  async wait() {
    while (this.isOpen) {
      // eslint-disable-next-line no-await-in-loop
      await this._wait(Math.max(250, this.openUntil - this._now()));
    }
  }
}

/**
 * Who owns which product, and which listing names are being created right now.
 *
 * Two hazards that only exist once lanes run together:
 *  - the same product appears in two of the seller's category pages, so two
 *    lanes would upload it twice;
 *  - two lanes reach Add Product for the same name at the same moment, and the
 *    duplicate lookup each one does cannot see the other's half-created
 *    listing. The account already carries one pair of duplicates created
 *    exactly this way by a single lane with the lookup off.
 */
export class Claims {
  constructor() {
    this._products = new Map();
    this._names = new Map();
  }

  /** @returns {string|null} the lane that already owns it, or null on success. */
  claimProduct(id, lane) {
    const owner = this._products.get(id);
    if (owner && owner !== lane) return owner;
    this._products.set(id, lane);
    return null;
  }

  ownerOf(id) {
    return this._products.get(id) || null;
  }

  /**
   * Hold a listing name for the length of one upload. Returns a release
   * function, or null when another lane is uploading that name right now.
   */
  holdName(key, lane) {
    if (!key) return () => {};
    const owner = this._names.get(key);
    if (owner && owner !== lane) return null;
    this._names.set(key, lane);
    return () => {
      if (this._names.get(key) === lane) this._names.delete(key);
    };
  }

  heldNames() {
    return [...this._names.keys()];
  }
}

/**
 * Does a 429 on this URL mean IndiaMART is refusing our work?
 *
 * Not every 429 is about us. Driving the seller portal, the throttled requests
 * were `track.indiamart.com/imlytics/events` — the page's own analytics beacon,
 * fired several times per product view. Treating those as a refusal held all
 * five upload lanes for 60s at a time while the portal was in fact serving
 * every product request normally, which made the safety net the slowest thing
 * in the run.
 *
 * So only the endpoints that carry the work count: the seller portal's ajax
 * calls and the public product pages. Analytics, tracking and third-party
 * beacons are ignored however often they are refused.
 */
const TRACKING = /(^|\.)track\.indiamart\.com$|(^|\.)analytics\.|googletagmanager|doubleclick|yandex|clarity\.ms/i;
const TRACKING_PATH = /\/imlytics\/|\/events\b|\/collect\b|\/watch\//i;

export function isWorkRateLimited(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (TRACKING.test(parsed.hostname)) return false;
  if (TRACKING_PATH.test(parsed.pathname)) return false;
  return /(^|\.)indiamart\.com$|(^|\.)imimg\.com$/i.test(parsed.hostname);
}

export { sleep };
