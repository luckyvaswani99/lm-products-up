import fs from 'node:fs';
import fsp from 'node:fs/promises';
import pLimit from 'p-limit';
import { config } from '../config.js';
import { log } from '../logger.js';
import { scrapeCatalog } from '../scraper/catalogScraper.js';
import { RATE_LIMIT } from '../scraper/rateLimit.js';
import { downloadImages } from '../images/downloader.js';
import { regenerateImage } from '../images/aiImage.js';
import { Uploader, uploadProductName } from '../uploader/indiamartUploader.js';
import { uploadNameKey } from '../listingKey.js';
import { loadUploadSettings } from '../uploadSettings.js';
import { browserSessionGone, duplicateListingNames, uploadBlockers, REPEATED_FAILURE_LIMIT } from '../pipeline.js';
import { confirmLoggedIn, openContext } from '../browser/session.js';
import { Breaker, Semaphore, SharedPacer, isWorkRateLimited } from './gate.js';
import { LaneStore } from './laneStore.js';
import { laneSessionDir, loadLanes } from './laneConfig.js';

/**
 * Run several seller category pages at once: each lane extracts its own
 * category, processes its own photos and uploads with its own browser window
 * and its own product group.
 *
 * The time saved is real but it is not five times: most of a product's 45
 * seconds is spent waiting on IndiaMART, and IndiaMART counts its rate limit
 * per IP. So the lanes overlap their local work — downloads, background
 * removal, AI images, form filling — while every request to indiamart.com goes
 * through one shared budget. Five lanes with five private budgets would be five
 * times the request rate on the one address being counted, which is how you
 * earn a block rather than finish sooner.
 *
 * What is shared, and why:
 *   store      one JSON file, so every change runs under one lock
 *   budget     one request budget, because the limit is counted per IP
 *   breaker    one 429 stops every lane, not just the one that saw it
 *   downloads  photo downloads are reads of indiamart's hosts too, so the
 *              number of them happening at once is capped across lanes
 *   claims     one lane per product, one lane per listing name at a time
 *
 * Background removal needs nothing here: applyBackgroundRemoval already runs
 * its requests through one module-level queue, so five lanes asking at once
 * queue behind each other rather than starting five Python processes.
 */

/** How many lanes may be inside the *upload* half at once. */
const DEFAULT_MAX_UPLOADING = 2;

/** Errors here are reported one line at a time; the stack is in the log. */
const firstLine = (error) => String(error?.message || error).split(/\r?\n/)[0];

/**
 * The shared state of the run that is going on, so it can be asked to stop.
 *
 * Five browser windows driving one account is a lot to leave running, and the
 * single-job runner has no way to interrupt a job. Stopping is cooperative: a
 * lane finishes the product it is on and then leaves the rest pending, which
 * is the same outcome as a re-run rather than a half-written listing.
 */
let activeRun = null;

export function stopLanes() {
  if (!activeRun) return false;
  activeRun.stopped = true;
  log.warn('lanes: stopping after each lane finishes the product it is on');
  return true;
}

export function lanesRunning() {
  return !!activeRun;
}

/**
 * Give a lane its own logged-in Chromium profile.
 *
 * The login is an OTP the user did by hand once, and it lives in the shared
 * profile's cookies, so the lane profile is a copy of that directory. Copying
 * is only safe while nothing is driving it, which is why this runs before any
 * lane opens a browser. An existing lane profile is reused as it is — rewriting
 * it every run would throw away whatever state the lane built up.
 */
async function prepareLaneProfile(lane) {
  const target = laneSessionDir(lane.id);
  if (fs.existsSync(target)) return target;
  const source = config.indiamart.sessionDir;
  if (!fs.existsSync(source)) {
    throw new Error(
      `No IndiaMART session to copy from (${source}). Sign in once with the Sign in button, then run the lanes.`,
    );
  }
  await fsp.mkdir(target, { recursive: true });
  await fsp.cp(source, target, { recursive: true, force: true });
  log.info(`  ${lane.id}: browser profile prepared from the signed-in session`);
  return target;
}

/** Fail a lane before it does anything if its profile is not signed in. */
async function assertLaneSignedIn(lane, sessionDir) {
  const { ctx, page } = await openContext({ headful: false, sessionDir });
  try {
    if (!(await confirmLoggedIn(page))) {
      throw new Error(
        `${lane.id}: its browser profile is not signed in to IndiaMART. ` +
          'Sign in once with the Sign in button, delete .session-lanes, and run the lanes again.',
      );
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Extract one category page through the shared request budget. */
async function laneExtract(lane, shared, { limit }) {
  log.step(`${lane.id}: extracting ${lane.url}`);
  const records = await scrapeCatalog([lane.url], {
    limit,
    headful: false,
    budget: shared.budget,
    breaker: shared.breaker,
  });
  if (!records.length) {
    log.warn(`${lane.id}: no products extracted — nothing for this lane to upload`);
    return [];
  }
  // Insert under the lock, then claim. Both steps are the shared store's, so a
  // product the seller lists in two categories belongs to exactly one lane.
  const ids = await shared.store.write((store) =>
    records.map((record) => {
      const { product } = store.upsert(record, { refresh: true });
      // Remember the lane AND its group. The lane is what lets a later
      // upload-only run find this product again without reading the category
      // page a second time, which matters because extraction is the half that
      // runs into the rate limit.
      product.lane = lane.id;
      if (lane.group) product.group = lane.group;
      return product.id;
    }),
  );
  const { products, takenBy } = await shared.store.claimFor(lane.id, ids);
  if (takenBy.size) {
    log.warn(
      `${lane.id}: ${takenBy.size} product(s) are already another lane's — ` +
        `the seller lists them in more than one category, so they upload once`,
    );
  }
  log.ok(`${lane.id}: ${products.length} product(s) extracted and claimed`);
  return products;
}

/**
 * The products this lane already extracted on an earlier run.
 *
 * Extraction is the half the rate limit bites: 192 product pages in one sitting
 * earned a 429 even through the shared budget, and re-reading them to get back
 * to the same products would earn another. So an upload-only run picks up what
 * is already stored, matched by the lane that extracted it.
 */
async function laneStored(lane, shared) {
  const ids = shared.store.read((store) =>
    store
      .all()
      .filter((product) => {
        if (product.lane) return product.lane === lane.id;
        // Records from a run before the lane was recorded: the group on them
        // was written by this lane's own extract, and each lane has its own
        // group, so it identifies the lane just as well. Falling back to it
        // beats re-reading 192 product pages to learn something already known.
        return !!lane.group && product.group === lane.group;
      })
      .map((product) => product.id),
  );
  const { products } = await shared.store.claimFor(lane.id, ids);
  // Record it now, so the next run does not need the fallback.
  await shared.store.write(() => products.forEach((product) => { product.lane = lane.id; }));
  log.ok(`${lane.id}: ${products.length} product(s) already extracted`);
  return products;
}

/**
 * Download and prepare photos for this lane's products.
 *
 * The downloads are reads of IndiaMART's image hosts, so how many run at once
 * is capped across every lane rather than per lane. The AI image is a different
 * provider's API and is not counted against IndiaMART at all.
 */
async function laneImages(lane, products, shared) {
  const todo = products.filter((p) => !['done', 'skipped'].includes(p.status.images));
  if (!todo.length) return;
  log.step(`${lane.id}: photos for ${todo.length} product(s)`);
  const perLane = pLimit(Math.max(1, Math.min(config.concurrency, 2)));
  await Promise.all(
    todo.map((product) =>
      perLane(async () => {
        try {
          const wanted = (product.imageUrls || []).filter((url) => /^https?:/.test(url)).length;
          // Capped across all lanes, not per lane: these are reads of
          // indiamart's image hosts and they count towards the same limit.
          const files = await shared.downloads.run(() => downloadImages(product));
          if (!files.length) throw new Error('no images downloaded');
          if (files.length < wanted) {
            throw new Error(`only ${files.length} of ${wanted} source photos downloaded`);
          }
          let usedAi = false;
          if (config.image.ai) {
            try {
              product.aiImages = [await regenerateImage(product)];
              usedAi = true;
            } catch (aiError) {
              product.aiImages = [];
              log.warn(`${lane.id}: AI image unavailable for ${product.name.slice(0, 35)} — using the real photo(s)`);
            }
          } else {
            product.aiImages = [];
          }
          await shared.store.write((store) => {
            product.localImages = files;
            store.markStage(product, 'images', 'done');
          });
          log.ok(
            `${lane.id}: photos ✓ ${product.name.slice(0, 40)} ` +
              `(${files.length}/${wanted}${usedAi ? ' + AI primary' : ''})`,
          );
        } catch (error) {
          await shared.store.write((store) => store.markStage(product, 'images', 'error', error));
          log.error(`${lane.id}: photos ✗ ${product.name.slice(0, 40)}: ${error.message}`);
        }
      }),
    ),
  );
}

/**
 * Upload this lane's products from this lane's own browser window.
 *
 * Mirrors the single-lane upload: readiness is checked before the browser
 * opens, a dead session leaves products pending rather than failed, and the
 * same fault repeating stops the lane instead of burning through the queue.
 * What is added is the listing-name hold, so two lanes can never be inside Add
 * Product for the same name at the same moment — the duplicate lookup each
 * lane does cannot see the other's half-created listing.
 */
async function laneUpload(lane, products, shared, { dryRun }) {
  const skipDuplicateCheck = !loadUploadSettings().findDuplicates;
  let todo = products.filter((p) => !['done', 'skipped'].includes(p.status.uploaded));
  if (!todo.length) {
    log.warn(`${lane.id}: nothing ready to upload`);
    return { published: 0, failed: 0, pending: 0 };
  }

  const clashes = duplicateListingNames(todo);
  const notReady = [];
  todo = todo.filter((product) => {
    const blockers = uploadBlockers(product);
    const clash = clashes.get(product);
    if (clash) blockers.push(clash);
    if (!blockers.length) return true;
    notReady.push({ product, blockers });
    return false;
  });
  if (notReady.length) {
    await shared.store.write((store) => {
      for (const { product, blockers } of notReady) {
        store.markStage(product, 'uploaded', 'error', `not uploaded — ${blockers.join(', ')}`);
      }
    });
    log.warn(`${lane.id}: ${notReady.length} product(s) are not ready and were NOT uploaded`);
    notReady.forEach(({ product, blockers }) =>
      log.warn(`${lane.id}:   ${product.name.slice(0, 40)} — ${blockers.join(', ')}`),
    );
  }
  if (!todo.length) return { published: 0, failed: notReady.length, pending: 0 };

  const sessionDir = await prepareLaneProfile(lane);
  const up = new Uploader({
    sessionDir,
    label: lane.id,
    // A 429 on the portal is the same per-IP fact as one on the public site,
    // so it holds every lane off instead of only slowing this one down — but
    // only when it is the WORK being refused. The portal's analytics beacon
    // gets throttled on its own schedule, and reading that as a refusal held
    // all five lanes for a minute at a time while every product request was
    // being served normally.
    onRateLimited: (url) => {
      if (!isWorkRateLimited(url)) return;
      shared.breaker.trip(RATE_LIMIT.backoffMs[0], `HTTP 429 on ${new URL(url).pathname.slice(0, 50)}`);
      shared.budget.reset();
    },
  });
  await up.open();
  let lastReason = null;
  let repeats = 0;
  let stopped = null;
  try {
    for (const product of todo) {
      if (shared.stopped) {
        stopped = new Error('stopped on request');
        break;
      }
      await shared.breaker.wait();

      const nameKey = uploadNameKey(uploadProductName(product));
      const releaseName = shared.store.claims.holdName(nameKey, lane.id);
      if (!releaseName) {
        // Another lane is creating this exact name right now. Leaving it
        // pending is right: it is not a fault, and a later pass picks it up
        // once the other lane has finished and the listing is findable.
        log.warn(
          `${lane.id}: "${product.name.slice(0, 40)}" is being uploaded by another lane right now — left pending`,
        );
        continue;
      }
      try {
        log.step(`${lane.id}: uploading ${(product.seo?.name || product.name).slice(0, 45)}`);
        const result = await up.addProduct(product, { dryRun, skipDuplicateCheck });
        if (dryRun) continue;
        if (!result.ok) {
          await shared.store.write((store) =>
            store.markStage(product, 'uploaded', 'error', 'could not confirm listing'),
          );
          continue;
        }
        await shared.store.write((store) => store.markStage(product, 'uploaded', 'done'));
        log.ok(
          `${lane.id}: ${result.created ? 'created' : 'reconciled'} ✓ item ${result.itemId} ` +
            `(${result.photoCount} photo(s), PDF ${result.pdfName})`,
        );
        const wantedGroup = String(product.group || lane.group || '').trim();
        if (wantedGroup) {
          try {
            const applied = await up.applyGroup(product, wantedGroup);
            if (applied.changed) {
              log.ok(`${lane.id}: group set ${applied.group}${applied.created ? ' (new group)' : ''}`);
            }
          } catch (groupError) {
            // The listing is published and correct; only the grouping failed.
            log.warn(`${lane.id}: group not set — ${groupError.message.split('\n')[0]}`);
          }
        }
        lastReason = null;
        repeats = 0;
      } catch (error) {
        if (browserSessionGone(error)) {
          await shared.store.write((store) => store.markStage(product, 'uploaded', 'pending'));
          stopped = error;
          break;
        }
        const shot = await up.captureFailure(product).catch(() => null);
        await shared.store.write((store) => store.markStage(product, 'uploaded', 'error', error));
        log.error(`${lane.id}: upload ✗ ${product.name.slice(0, 40)}: ${error.message.split('\n')[0]}`);
        if (shot) log.warn(`${lane.id}:   page at the moment of failure: ${shot}`);

        const reason = String(error.message).split('\n')[0].slice(0, 80);
        repeats = reason === lastReason ? repeats + 1 : 1;
        lastReason = reason;
        if (repeats >= REPEATED_FAILURE_LIMIT) {
          stopped = new Error(`${repeats} products in a row failed with: ${reason}`);
          break;
        }
      } finally {
        releaseName();
      }
    }
  } finally {
    await up.close().catch(() => {});
  }

  const published = todo.filter((p) => p.status.uploaded === 'done').length;
  const failed = todo.filter((p) => p.status.uploaded === 'error').length + notReady.length;
  const pending = todo.filter((p) => !['done', 'error', 'skipped'].includes(p.status.uploaded)).length;
  if (stopped) {
    log.warn(
      `${lane.id}: stopped after ${published} product(s) — ${stopped.message.split('\n')[0]}; ` +
        `${pending} left pending for a re-run`,
    );
  }
  return { published, failed, pending, stopped: stopped ? stopped.message.split('\n')[0] : null };
}

/**
 * Extract, prepare and upload several categories at once.
 *
 * Every lane is awaited through allSettled: one lane throwing must not take the
 * other four down, and the run has to end with a per-lane answer rather than a
 * single error from whichever lane failed first.
 */
export async function runLanes({
  lanes: laneInput,
  limit = 0,
  dryRun = false,
  maxUploading = DEFAULT_MAX_UPLOADING,
  scrapeOnly = false,
  // Upload what is already extracted, without reading any category page again.
  // Extraction is the half that hits the rate limit, so repeating it to reach
  // products already in the store costs a block and gains nothing.
  uploadOnly = false,
} = {}) {
  if (activeRun) throw new Error('a lane run is already going');
  const lanes = (laneInput?.length ? laneInput : loadLanes()).filter((lane) => lane.enabled !== false);
  if (!lanes.length) throw new Error('no lanes are enabled');

  const shared = {
    store: await LaneStore.open(),
    // One budget for every lane, because the 429 is counted per IP.
    budget: new SharedPacer({
      spacingMs: RATE_LIMIT.spacingMs,
      batchSize: RATE_LIMIT.batchSize,
      batchPauseMs: RATE_LIMIT.batchPauseMs,
    }),
    breaker: new Breaker(),
    // Photo downloads across every lane, not per lane.
    downloads: new Semaphore(2),
    stopped: false,
  };

  activeRun = shared;
  try {
    return await execute(lanes, shared, { limit, dryRun, maxUploading, scrapeOnly, uploadOnly });
  } finally {
    // Cleared however the run ends. Left set after a failure, it would refuse
    // every later run with "a lane run is already going".
    activeRun = null;
  }
}

async function execute(lanes, shared, { limit, dryRun, maxUploading, scrapeOnly, uploadOnly }) {
  log.step(
    `lanes: ${lanes.length} categor${lanes.length === 1 ? 'y' : 'ies'} in parallel ` +
      `(${maxUploading} uploading at a time, one shared IndiaMART request budget)`,
  );
  lanes.forEach((lane) =>
    log.info(`  ${lane.id} -> group ${lane.group ? `"${lane.group}"` : '(none set)'}`),
  );

  // Profiles are copied before any browser opens: copying a Chromium profile
  // that something is already driving produces a corrupt one.
  for (const lane of lanes) {
    // eslint-disable-next-line no-await-in-loop
    const dir = await prepareLaneProfile(lane);
    // eslint-disable-next-line no-await-in-loop
    if (!dryRun && !scrapeOnly) await assertLaneSignedIn(lane, dir);
  }

  const uploadSlots = pLimit(Math.max(1, maxUploading));
  const results = await Promise.allSettled(
    lanes.map(async (lane) => {
      const products = uploadOnly
        ? await laneStored(lane, shared)
        : await laneExtract(lane, shared, { limit });
      if (!products.length) return { lane: lane.id, published: 0, failed: 0, pending: 0, products: 0 };
      await laneImages(lane, products, shared);
      if (scrapeOnly) {
        return { lane: lane.id, published: 0, failed: 0, pending: products.length, products: products.length };
      }
      const outcome = await uploadSlots(() => laneUpload(lane, products, shared, { dryRun }));
      return { lane: lane.id, products: products.length, ...outcome };
    }),
  );

  log.ok('lanes complete');
  const summary = [];
  results.forEach((result, index) => {
    const lane = lanes[index];
    if (result.status === 'rejected') {
      log.error(`  ${lane.id} ✗ ${firstLine(result.reason)}`);
      summary.push({ lane: lane.id, error: String(result.reason?.message || result.reason) });
      return;
    }
    const { products = 0, published = 0, failed = 0, pending = 0, stopped } = result.value;
    log.info(
      `  ${lane.id}: ${published}/${products} published` +
        `${failed ? `, ${failed} failed` : ''}${pending ? `, ${pending} pending` : ''}` +
        `${stopped ? ` — stopped: ${stopped}` : ''}`,
    );
    summary.push(result.value);
  });
  if (shared.breaker.trips) {
    log.warn(
      `  IndiaMART rate limited this connection ${shared.breaker.trips} time(s); ` +
        'lanes paused together each time',
    );
  }
  return { lanes: summary };
}
