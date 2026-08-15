/**
 * The full photo gallery of one IndiaMART product page.
 *
 * Reading `<img>` elements is unreliable: the thumbnail strip is lazy-loaded,
 * so `src` is still a placeholder for the first moments after load. The gallery
 * elements exist immediately but their URLs do not, which is why extracting too
 * early captured a random 1-4 of the frames and why re-running the extractor
 * kept changing the count.
 *
 * Scanning the whole document instead is worse, not better: the "similar
 * products" carousels render into the same page a moment later, so a document
 * sweep returned 7 frames for a 3-photo product, 4 of them belonging to other
 * listings. The gallery is therefore read from its own containers only, after
 * waiting for the strip to swap its shared `z.gif` placeholder for real URLs.
 */

/** Upgrade a quoted size to the largest IndiaMART serves. */
export function fullSize(url) {
  return String(url || '').replace(/-\d+x\d+(\.[a-z]+)(\?.*)?$/i, '-1000x1000$1');
}

/**
 * Identity of a frame independent of the size suffix, so the same photo quoted
 * at 125x125 and 1000x1000 counts once. Includes the asset folder because
 * frame names repeat across a seller's products.
 */
export function frameKey(url) {
  const clean = String(url || '').split('?')[0];
  const folder = (clean.match(/\/(\d+)\/[^/]+$/) || [])[1] || '';
  const name = (clean.match(/\/([^/]+?)(?:-\d+x\d+)?\.[a-z]+$/i) || [])[1] || clean;
  return `${folder}/${name}`;
}

const JUNK = /\/Logo\/|template|imLogo|blalert|bl_mail|hm\.imimg|seller\.imimg|sprite|icon|placeholder|no[-_]?image/i;

/**
 * Read every photo of the product whose page is loaded.
 *
 * @returns {Promise<{images: string[], thumbnails: number}>} `images` are
 *   full-size URLs with the page's own primary frame first; `thumbnails` is how
 *   many frames the strip had resolved.
 */
export async function readProductGallery(page) {
  // Wait for the strip to swap its placeholders (a shared z.gif) for real URLs.
  // The whole document must NOT be scanned instead: "similar products"
  // carousels render into the same page a moment later, and sweeping the
  // document picked up their frames — one 3-photo product came back with 7,
  // four of which belonged to other listings.
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.gallery-thumbs img, img.image')].some((element) =>
          /data5\/SELLER\/Default/i.test(element.currentSrc || element.getAttribute('src') || ''),
        ),
      undefined,
      { timeout: 8000 },
    )
    .catch(() => {});

  const found = await page.evaluate(
    ({ junkPattern }) => {
      const junk = new RegExp(junkPattern, 'i');
      const urlOf = (element) => element.currentSrc || element.getAttribute('src') || '';
      const usable = (url) => /data5\/SELLER\/Default/i.test(url) && !junk.test(url);

      // Only the product's own gallery: the large frame plus its thumbnails.
      const primary = [...document.querySelectorAll('.main-media img')].map(urlOf).filter(usable);
      const strip = [...document.querySelectorAll('.gallery-thumbs img, img.image')]
        .map(urlOf)
        .filter(usable);
      const openGraph = (document.querySelector('meta[property="og:image"]') || {}).content || '';
      return { primary, strip, openGraph: usable(openGraph) ? openGraph : '' };
    },
    { junkPattern: JUNK.source },
  );

  // Order: the frame the page shows first, then the strip in its own order.
  const ordered = [];
  const seen = new Set();
  const add = (url) => {
    if (!url) return;
    const key = frameKey(url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    ordered.push(fullSize(url));
  };
  found.primary.forEach(add);
  add(found.openGraph);
  found.strip.forEach(add);

  return { images: ordered, thumbnails: found.strip.length };
}

/**
 * Read the gallery, insisting on a non-empty result. A page that answers with
 * no photos at all is a failed read, not a product without pictures, so it is
 * retried before being reported.
 */
export async function readProductGalleryWithRetry(page, url, { attempts = 3, log } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(1500 * attempt);
    }
    const gallery = await readProductGallery(page);
    if (gallery.images.length) {
      return gallery;
    }
    if (log && attempt < attempts) log.warn(`    no photos read (attempt ${attempt}/${attempts}) — retrying`);
  }
  return { images: [], thumbnails: 0 };
}
