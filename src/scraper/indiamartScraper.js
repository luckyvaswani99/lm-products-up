import { chromium } from 'playwright';
import { log } from '../logger.js';
import { sanitizeSpecs } from '../specSanitizer.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Parse "₹ 590 / Vial" -> { price: "590", unit: "Vial" }. */
export function parsePrice(text = '') {
  const t = String(text).replace(/,/g, '').trim();
  const price = (t.match(/(\d+(?:\.\d+)?)/) || [])[1] || '';
  let unit = '';
  const slash = t.split('/')[1];
  if (slash) unit = slash.replace(/[^a-zA-Z ]/g, '').trim();
  return { price, unit };
}

async function autoScroll(page, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(700);
  }
}

/**
 * Extract product cards from an IndiaMART listing / search / seller page.
 * Uses several selector strategies because IndiaMART markup varies per page type.
 */
async function extractCards(page) {
  return page.evaluate(() => {
    const pick = (el, sels) => {
      for (const s of sels) {
        const n = el.querySelector(s);
        if (n && n.textContent.trim()) return n.textContent.trim();
      }
      return '';
    };
    const pickImg = (el) => {
      const img = el.querySelector('img');
      if (!img) return '';
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
      const largestSrcset = srcset
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean)
        .pop();
      const source =
        largestSrcset ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-src') ||
        img.currentSrc ||
        img.getAttribute('src') ||
        '';
      return source.replace(/-\d+x\d+(\.[a-z]+)(\?.*)?$/i, '-1000x1000$1');
    };
    const pickLink = (el, sels) => {
      for (const s of sels) {
        const n = el.querySelector(s);
        const href = n?.getAttribute('href');
        if (href) return href;
      }
      const a = el.querySelector('a[href]');
      return a?.getAttribute('href') || '';
    };

    const cardSelectors = [
      '.card',
      '.prd_card',
      '.lst_more_pfor',
      'li.brs4',
      '.prod-card',
      '[data-click*="product"]',
    ];
    let cards = [];
    for (const cs of cardSelectors) {
      const found = Array.from(document.querySelectorAll(cs));
      if (found.length > cards.length) cards = found;
    }

    const seen = new Set();
    const out = [];
    for (const el of cards) {
      const name = pick(el, ['.prd_name', '.prd-name', '.producttitle', '.cardlinks', 'h2', 'h3', '.elps', '.hitTitle']);
      if (!name) continue;
      const priceText = pick(el, ['.prc', '.price', '.p_price', '.prd_price', '.dp_price']);
      const image = pickImg(el);
      const link = pickLink(el, ['a.cardlinks', 'a.prd_name', 'a.producttitle', 'a[href*="proddetail"]']);
      const key = name + '|' + link;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, priceText, image, link });
    }
    return out;
  });
}

/**
 * Scrape a product DETAIL page for everything IndiaMART needs:
 * name, price, unit, MOQ, full specification table, description, and images.
 */
export async function extractDetail(page, url, { navigate = true } = {}) {
  try {
    // Callers that need the HTTP status (to see a rate limit) navigate first
    // and pass navigate:false, so the page is not requested twice.
    if (navigate) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1800);
    }
    const detail = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const firstText = (sels, min = 1) => {
        for (const s of sels) {
          const n = document.querySelector(s);
          if (n && clean(n.textContent).length >= min) return clean(n.textContent);
        }
        return '';
      };

      const name = firstText(['h1', '.bo.center-heading', '.prod-name', '[itemprop="name"]']);

      const description = firstText(
        ['#prod-desc', '.prod-descp', '#descp', '.dtl_desc', '.pd_descBox', '[itemprop="description"]', '#descriptionId'],
        30,
      );

      // --- product specification table (skip the seller/company profile rows) ---
      const specs = {};
      const DROP = /^(gst|import export|iec|annual turnover|no\.? of employees|number of employees|legal status|nature of business|indiamart member|gst registration|year of establishment|ships? from|shipping|availability|price|view in hindi|exports? to|member since|total number|weekly working|banker|payment terms|company|business type|established)/i;
      const addPair = (k, v) => {
        k = clean(k).replace(/:$/, '');
        v = clean(v);
        if (!k || !v || k.length > 45 || v.length > 300 || /^https?:/.test(v)) return;
        if (DROP.test(k)) return;
        specs[k] = v;
      };
      // 2-column tables
      document.querySelectorAll('table tr').forEach((tr) => {
        const c = tr.querySelectorAll('td, th');
        if (c.length === 2) addPair(c[0].textContent, c[1].textContent);
      });
      // IndiaMART spec lists (label / value spans)
      document
        .querySelectorAll('.dtl-attr, .prod-spec li, .specf li, .list-attr li, .attr-row, .spec-row')
        .forEach((li) => {
          const k = li.querySelector('.attr-label, .lbl, .spec-label, .lft, .name');
          const v = li.querySelector('.attr-value, .val, .spec-value, .rgt, .value');
          if (k && v) addPair(k.textContent, v.textContent);
        });
      // definition lists
      document.querySelectorAll('dl').forEach((dl) => {
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        dts.forEach((dt, i) => dds[i] && addPair(dt.textContent, dds[i].textContent));
      });

      // --- price / unit / MOQ ---
      let priceText = firstText(['.pp_price', '#pdp_price', '.price-tag', '.dp_price', '[itemprop="price"]', '.bo.pgpprc', '.price']);
      if (!priceText) {
        priceText = document.querySelector('meta[itemprop="price"], meta[property="product:price:amount"]')?.content || '';
      }
      if (!priceText) {
        // e.g. page title "... at ₹ 200/stripe | ..."
        const m = (document.title || '').match(/₹\s*([\d,]+)\s*\/\s*([A-Za-z]+)/);
        if (m) priceText = `₹ ${m[1]} / ${m[2]}`;
      }
      const moq = firstText(['.moq', '#moq', '.pdp_moq']) ||
        (specs['Minimum Order Quantity'] || specs['MOQ'] || '');

      // --- images: collect this product's named gallery rather than assuming
      // every gallery asset shares og:image's folder id. IndiaMART stores each
      // gallery frame under a different asset id on current detail pages.
      const isJunk = (s) => /\/Logo\/|template|imLogo|blalert|bl_mail|hm\.imimg|seller\.imimg|sprite|icon|placeholder|no[-_]?image/i.test(s);
      const fixSize = (s) => (s || '').replace(/-\d+x\d+(\.[a-z]+)(\?.*)?$/i, '-1000x1000$1');
      const imageSource = (image) =>
        image.currentSrc ||
        image.getAttribute('src') ||
        image.getAttribute('data-src') ||
        image.getAttribute('data-original') ||
        '';
      const og = document.querySelector('meta[property="og:image"]')?.content || '';
      const normalizedName = clean(name).toLowerCase();
      const pageImages = Array.from(document.querySelectorAll('img'));
      const galleryImages = pageImages.filter((image) => {
        const alt = clean(image.getAttribute('alt')).toLowerCase();
        return (
          alt === normalizedName ||
          alt.startsWith(`${normalizedName} `) ||
          alt.startsWith(`${normalizedName}-`) ||
          Boolean(image.closest('.main-media, .image-belowfold'))
        );
      });
      let imgs = galleryImages
        .map(imageSource)
        .filter((src) => /imimg\.com\/data5\/SELLER\/Default\//i.test(src) && !isJunk(src))
        .map(fixSize);

      // Fallback for older detail-page markup that has no named gallery.
      if (!imgs.length) {
        imgs = pageImages
          .map(imageSource)
          .filter((src) => /imimg\.com\/data5\//i.test(src) && !isJunk(src))
          .map(fixSize);
        const prodId = (og.match(/\/Default\/\d{4}\/\d{1,2}\/(\d+)\//) || [])[1];
        if (prodId) imgs = imgs.filter((src) => src.includes('/' + prodId + '/'));
      }
      const images = [...new Set([fixSize(og), ...imgs].filter((src) => src && !isJunk(src)))].slice(0, 6);

      return { name, description, specs, priceText, moq, images };
    });
    // The spec table shares markup with the seller's contact card, so drop the
    // supplier's own rows before this record reaches the store.
    return { ...detail, specs: sanitizeSpecs(detail.specs) };
  } catch (e) {
    log.warn(`detail failed ${url}: ${e.message}`);
    return { name: '', description: '', specs: {}, priceText: '', moq: '', images: [] };
  }
}

/**
 * Extract a SINGLE product from its IndiaMART detail URL — captures the full
 * spec set IndiaMART needs. Returns one raw product record (or null).
 */
export async function scrapeSingle(url, { headful = false } = {}) {
  const browser = await chromium.launch({ headless: !headful });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    log.step(`extracting single product: ${url}`);
    const d = await extractDetail(page, url);
    if (!d.name) {
      log.warn('could not read a product name from that URL');
      return null;
    }
    const { price, unit } = parsePrice(d.priceText || '');
    const specs = d.moq ? { ...d.specs, 'Minimum Order Quantity': d.moq } : d.specs;
    if (!Object.keys(specs).length) log.warn('  no product specifications found on that page');
    const compFromSpec =
      specs['Product Composition'] || specs['Composition'] || specs['Salt Composition'] || specs['Salt'] || '';
    const rec = {
      name: d.name,
      price,
      unit: unit || 'Piece',
      description: d.description,
      specs,
      imageUrls: d.images,
      sourceUrl: url,
      sourceId: url.slice(-40),
      compound: guessCompound(d.name) || guessCompound(compFromSpec) || compFromSpec,
    };
    log.ok(`extracted: ${rec.name} (${Object.keys(rec.specs).length} specs, ${rec.imageUrls.length} images)`);
    return rec;
  } finally {
    await browser.close();
  }
}

/** Guess the active compound from a product name (best-effort, pharma-oriented). */
export function guessCompound(name = '') {
  const map = [
    ['tadalafil', 'Tadalafil'],
    ['sildenafil', 'Sildenafil Citrate'],
    ['vardenafil', 'Vardenafil'],
    ['dapoxetine', 'Dapoxetine'],
    ['testosterone', 'Testosterone'],
  ];
  const l = name.toLowerCase();
  for (const [needle, val] of map) if (l.includes(needle)) return val;
  return '';
}

/**
 * Extract products from a custom-domain IndiaMART storefront (e.g. a seller's
 * own microsite like sterlingexporters.com). These list every product inline
 * on the page — name, price, a full spec table, MOQ, description and image —
 * so there is no separate detail page to visit.
 */
async function extractStorefront(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/[ \t]+/g, ' ').trim();
    const fixSize = (s) => (s || '').replace(/-\d+x\d+(\.[a-z]+)(\?.*)?$/i, '-1000x1000$1');
    const DROP = /^(availab|shelf|payment terms|gst|import export|iec|annual turnover|employees|legal status|nature of business|member since|price|view in hindi|exports? to|supply ability|company|global supplier|supplier|medicine name|product name|\d+\s*\.)/i;

    // one product per block: a container holding exactly ONE seller product image + a price
    const blocks = [...document.querySelectorAll('div.row, li, .prd')].filter((r) => {
      const imgs = r.querySelectorAll('img[src*="data5/SELLER/Default"], img[dataimg*="data5/SELLER/Default"]');
      return imgs.length === 1 && /₹|Get Latest Price|Get Best Quote/i.test(r.innerText || '');
    });

    const seen = new Set();
    const out = [];
    for (const r of blocks) {
      const img = r.querySelector('img[src*="data5/SELLER/Default"], img[dataimg*="data5/SELLER/Default"]');
      const src = img ? fixSize(img.getAttribute('src') || img.getAttribute('dataimg') || '') : '';
      const lines = (r.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
      const junk = /^(get best quote|request callback|get latest price|product brochure|yes,? i am interested|save time)/i;
      // collect ALL key/value pairs first — the real product name lives in the
      // "Medicine Name" spec, and the seller's own name must be filtered out.
      const raw = {};
      r.querySelectorAll('table tr').forEach((tr) => {
        const c = tr.querySelectorAll('td, th');
        if (c.length === 2) {
          const k = clean(c[0].textContent);
          const v = clean(c[1].textContent);
          if (k && v && k.length < 40) raw[k] = v;
        }
      });
      for (const rawLn of (r.innerText || '').split('\n')) {
        const m = rawLn.match(/^([A-Za-z][\w .()/]{2,36})\t+(.+)$/);
        if (m) raw[clean(m[1])] = clean(m[2]);
      }

      let name =
        raw['Medicine Name'] ||
        raw['Product Name'] ||
        clean((r.querySelector('h1, h2, h3') || {}).textContent || '');
      if (!name || junk.test(name)) name = lines.find((l) => l.length > 5 && !junk.test(l) && !/₹|\t/.test(l)) || '';
      name = clean(name);
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const pm = (r.innerText || '').match(/₹\s*([\d,]+)\s*\/\s*([A-Za-z]+)/);
      const specs = {};
      for (const [k, v] of Object.entries(raw)) if (!DROP.test(k)) specs[k] = v;
      const moqm = (r.innerText || '').match(/Minimum order quantity:?\s*(.+)/i);
      const desc = lines.filter((l) => l.length > 120).sort((a, b) => b.length - a.length)[0] || '';
      out.push({
        name,
        price: pm ? pm[1].replace(/,/g, '') : '',
        unit: pm ? pm[2] : '',
        specs,
        moq: moqm ? clean(moqm[1]) : '',
        image: src,
        desc,
      });
    }
    return out;
  });
}

/**
 * Scrape one or more IndiaMART URLs (works on both indiamart.com and
 * custom-domain seller storefronts).
 * @param {string[]} urls
 * @param {object} opts { limit, detail, headful }
 * @returns {Promise<object[]>} raw product records
 */
export async function scrape(urls, opts = {}) {
  // mode: 'auto' (try classic cards, else storefront) | 'traditional' (classic
  // indiamart.com only) | 'whitelabel' (custom-domain seller storefront only)
  const { limit = 0, detail = true, headful = false, mode = 'auto' } = opts;
  const browser = await chromium.launch({ headless: !headful });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const results = [];

  try {
    for (const url of urls) {
      log.step(`scraping ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);
      await autoScroll(page);
      const cards = mode === 'whitelabel' ? [] : await extractCards(page);
      // classic indiamart.com cards use one markup; custom seller storefronts
      // (e.g. sterlingexporters.com) use another.
      let store = [];
      if (mode === 'whitelabel' || (mode === 'auto' && cards.length === 0)) {
        store = await extractStorefront(page);
      }
      log.info(`  [${mode}] found ${cards.length} classic cards, ${store.length} storefront products`);

      for (const c of cards) {
        if (limit && results.length >= limit) break;
        const { price, unit } = parsePrice(c.priceText);
        results.push({
          name: c.name,
          price,
          unit: unit || 'Piece',
          description: '',
          specs: {},
          imageUrls: c.image ? [c.image] : [],
          sourceUrl: c.link || url,
          sourceId: (c.link || c.name).slice(-40),
          compound: guessCompound(c.name),
        });
      }

      for (const s of store) {
        if (limit && results.length >= limit) break;
        const own = sanitizeSpecs(s.specs);
        const specs = s.moq ? { ...own, 'Minimum Order Quantity': s.moq } : own;
        const cf = specs['Composition'] || specs['Product Composition'] || specs['Salt Composition'] || specs['Salt'] || '';
        results.push({
          name: s.name,
          price: s.price,
          unit: s.unit || 'Piece',
          description: s.desc,
          specs,
          imageUrls: s.image ? [s.image] : [],
          sourceUrl: `${url}#${s.name}`,
          sourceId: s.name.slice(0, 60),
          compound: guessCompound(s.name) || guessCompound(cf) || cf,
          _full: true, // data already complete — skip the detail-page visit
        });
      }
      if (limit && results.length >= limit) break;
    }

    if (detail) {
      const detailPage = await ctx.newPage();
      for (const r of results) {
        if (r._full) continue; // storefront products already have full data
        if (!/^https?:/.test(r.sourceUrl) || !/indiamart|imimg|proddetail/.test(r.sourceUrl)) continue;
        log.info(`  detail: ${r.name.slice(0, 50)}`);
        const d = await extractDetail(detailPage, r.sourceUrl);
        if (d.description) r.description = d.description;
        if (Object.keys(d.specs).length) r.specs = { ...r.specs, ...d.specs };
        if (d.moq) r.specs['Minimum Order Quantity'] = d.moq;
        if (d.images.length) r.imageUrls = [...new Set([...r.imageUrls, ...d.images])];
        if ((!r.price || r.price === '') && d.priceText) {
          const pp = parsePrice(d.priceText);
          r.price = pp.price || r.price;
          if (pp.unit) r.unit = pp.unit;
        }
        if (!r.compound) {
          const cf = r.specs['Product Composition'] || r.specs['Composition'] || r.specs['Salt Composition'] || r.specs['Salt'] || '';
          r.compound = guessCompound(cf) || cf;
        }
      }
      await detailPage.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}
