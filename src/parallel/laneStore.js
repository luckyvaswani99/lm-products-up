import { Store } from '../store.js';
import { Claims, Mutex } from './gate.js';

/**
 * One product store shared by every lane.
 *
 * The store is a JSON file that is read whole and written whole, so the normal
 * load → change → save around a whole run cannot be used by five lanes at once:
 * four lanes' progress would be lost to whichever lane saved last. Instead the
 * file is loaded once, every change runs inside a lock, and the save happens
 * inside that same lock — so a lane is never writing while another is changing.
 *
 * Ownership lives here too. The seller lists the same product under more than
 * one category, so without a claim two lanes would upload it twice.
 */
export class LaneStore {
  constructor(store = new Store()) {
    this.store = store;
    this.lock = new Mutex();
    this.claims = new Claims();
  }

  static async open() {
    return new LaneStore(await new Store().load());
  }

  /**
   * Run `fn(store)` with exclusive access, then persist.
   *
   * `fn` must do its own awaiting inside — the lock is held for its whole
   * duration, which is the point: a lane that reads a product, changes it and
   * saves it is one indivisible step.
   */
  async write(fn) {
    return this.lock.run(async () => {
      const result = await fn(this.store);
      await this.store.save();
      return result;
    });
  }

  /** A read that does not need the lock to be correct (single-threaded JS). */
  read(fn) {
    return fn(this.store);
  }

  /**
   * Hand this lane the products it may work on.
   *
   * A product already claimed by another lane is skipped and reported rather
   * than silently dropped, so a product that appears in two of the seller's
   * categories is visible as a decision rather than a mystery.
   */
  async claimFor(lane, ids) {
    return this.write((store) => {
      const mine = [];
      const takenBy = new Map();
      for (const id of ids) {
        const product = store.get(id);
        if (!product) continue;
        const owner = this.claims.claimProduct(id, lane);
        if (owner) {
          takenBy.set(id, owner);
          continue;
        }
        mine.push(product);
      }
      return { products: mine, takenBy };
    });
  }
}
