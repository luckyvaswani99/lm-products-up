import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { getSharedProductPdfPath } from '../sharedProductPdf.js';
import { getUploadImageRuntime, prepareUploadImage } from '../images/uploadImagePreparation.js';
import { productImageFiles } from '../images/productImageFiles.js';
import { openContext, isLoggedIn } from '../browser/session.js';
import { fillSpecs } from './specFiller.js';
import { slugify } from '../store.js';
import {
  DESCRIPTION_MAX_CHARS,
  descriptionFormattedLength,
  prepareDescriptionHtml,
  visibleDescriptionText,
} from '../descriptions/productDescription.js';

const SEL = {
  addProduct: 'Add Product',
  name: 'Product/Service Name',
  price: 'Price',
  unit: 'Enter Unit',
  saveContinue: 'Save and Continue',
  finish: 'Finish',
};

async function tryClick(locator, timeout = 4000) {
  try {
    await locator.first().click({ timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve one field INSIDE the open product popup.
 *
 * `scope` must be the popup, never the page. Manage Products renders inputs
 * for every listing on the page, so a page-wide lookup with `.first()` can
 * resolve to a *different* product's field — that is how an unrelated listing
 * got renamed, and why a "is the form blank" check read the wrong element and
 * passed. An ambiguous match is refused rather than guessed at.
 *
 * IndiaMART's current form identifies inputs by id and no longer puts
 * placeholders on the name or price fields; the placeholder stays as a
 * fallback for accounts still served the previous form version.
 */
async function formField(scope, id, legacyPlaceholder) {
  const field = scope.locator(`#${id}, input[placeholder="${legacyPlaceholder}"]`);
  const count = await field.count();
  if (count !== 1) {
    throw new Error(
      `Expected exactly one "${id}" field inside the product form, found ${count}; ` +
        'refusing to type into an ambiguous field',
    );
  }
  return field;
}

/** Remove the seller name from customer-facing product titles. */
function stripSupplierName(value) {
  const supplierName = String(config.supplier.name || '').trim();
  if (!supplierName) return String(value || '').trim();
  const escaped = supplierName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(value || '')
    .replace(new RegExp(`\\s*(?:[|,–—-]\\s*)?${escaped}\\s*$`, 'i'), '')
    .trim();
}

/** Match IndiaMART's product-name validation and the field's maxlength=100. */
export function uploadProductName(product) {
  const raw = stripSupplierName(product.seo?.name || product.name || '');
  return raw
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9.,_'"\/%& -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
}

/**
 * Listings, other than the one being worked on, whose name changed between two
 * snapshots. Item ids that disappeared are ignored — a listing leaving the
 * Active tab is not a rename.
 */
export function collateralRenames(namesBefore, namesAfter, allowedItemId) {
  const renamed = [];
  for (const [itemId, previousName] of namesBefore) {
    if (itemId === allowedItemId) continue;
    const currentName = namesAfter.get(itemId);
    if (currentName !== undefined && currentName !== previousName) {
      renamed.push(`item ${itemId}: "${previousName}" -> "${currentName}"`);
    }
  }
  return renamed;
}

/**
 * Read the current state of IndiaMART's crop popup.
 *
 * Measured on the live portal (3 photos, Add Product): the popup renders one
 * `.Thumb_crop` per photo it has finished reading plus a single trailing
 * `.Thumb_crop.Thumb_Noimage` "add more" slot, and shows "Loading images.
 * Please wait" until the last file is in. Photos arrive one at a time —
 * thumbnails appeared at ~2.0s, ~4.5s and ~7.5s — so anything read on a fixed
 * short delay sees a partly-loaded gallery.
 */
async function readCropState(crop) {
  return crop
    .first()
    .evaluate((el) => {
      const text = el.innerText || '';
      return {
        thumbnails: el.querySelectorAll('.Thumb_crop:not(.Thumb_Noimage)').length,
        loading: /Loading images/i.test(text),
        rejected: /could not be added|less than\s*500\s*x\s*500/i.test(text),
        text,
      };
    })
    .catch(() => null);
}

/**
 * Block until IndiaMART has actually read every selected file.
 *
 * The popup's "N More" label counts free slots in its 13-photo gallery, so it
 * also lags while files load ("12 More" with one of three photos in). Counting
 * loaded thumbnails is the direct signal and needs no assumption about gallery
 * capacity. Returns the confirmed thumbnail count; never guesses.
 */
export async function waitForCropSelection(page, crop, expectedTotal, baseline = 0) {
  const arriving = Math.max(expectedTotal - baseline, 0);
  const deadline = Date.now() + 20000 + arriving * 15000;
  let state = null;

  while (Date.now() < deadline) {
    state = await readCropState(crop);
    if (!state) throw new Error('IndiaMART crop popup closed before the selected photos were read');
    if (state.rejected) {
      throw new Error(state.text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-2).join(' '));
    }
    if (!state.loading && state.thumbnails >= expectedTotal) {
      if (state.thumbnails > expectedTotal) {
        throw new Error(
          `IndiaMART crop popup holds ${state.thumbnails} photos but ${expectedTotal} were expected; ` +
            'refusing to publish a gallery this tool did not assemble',
        );
      }
      return state.thumbnails;
    }
    await page.waitForTimeout(500);
  }

  const loaded = state?.thumbnails ?? 0;
  throw new Error(
    `IndiaMART read only ${loaded} of ${expectedTotal} photos into the crop popup ` +
      `within ${Math.round((20000 + arriving * 15000) / 1000)}s` +
      (state?.loading ? ' and was still loading' : ''),
  );
}

/**
 * Read IndiaMART's photo-rejection modal, if it appears.
 *
 * Clicking "Upload Photos" posts the selection to `uploading.imimg.com/dedup`.
 * Photos that service considers the listing already has are dropped and
 * announced in a `.modal_dedup` popup — "Photo rejected during upload! … Photo
 * already available in Product" — which closes itself after about four
 * seconds. Nothing else reports it: the CDN upload returns 200, the cropper
 * shows the photo, and the listing simply never gains it. That is why one
 * product retried "2/3 source photos" for ever with no reason given.
 *
 * Returns one entry per refused file, and dismisses the modal.
 */
export async function readPhotoRejections(page, timeout = 4000) {
  const modal = page.locator('.modal_dedup, #modal_dedup').first();
  const appeared = await modal
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return [];

  const rejected = await modal
    .evaluate((el) =>
      [...el.querySelectorAll('.dedup-rejection-section')].flatMap((section) => {
        const reason = (section.querySelector('.dedup-rejection-heading')?.innerText || 'rejected').trim();
        return [...section.querySelectorAll('li')].map((item) => ({
          reason,
          file: (item.querySelector('a')?.innerText || item.innerText || '').replace(/^✖\s*/, '').trim(),
        }));
      }),
    )
    .catch(() => []);

  await modal.getByText(/^OK$/i).last().click({ timeout: 2000 }).catch(() => {});
  await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  return rejected;
}

/** Report photos IndiaMART refused, naming its own reason for each. */
function logPhotoRejections(rejected, itemLabel) {
  if (!rejected.length) return;
  log.warn(`  IndiaMART refused ${rejected.length} photo(s)${itemLabel ? ` for ${itemLabel}` : ''}:`);
  rejected.forEach((entry) => log.warn(`    ${entry.file || 'a photo'} — ${entry.reason}`));
}

/**
 * IndiaMART can navigate the tab away from an open product form to its own
 * recommendation view. Recorded on a real run: the editor was filled, the PDF
 * retained, and thirteen seconds later Save and Continue was gone because the
 * page had moved to "?opensuggprodview=redirectsellerrecom". That is the portal
 * interrupting itself, not a fault in the product, so it is worth one retry.
 */
export const PORTAL_REDIRECT = 'IndiaMART navigated away from the product form';
export function portalRedirected(urlOrError) {
  const text = String(urlOrError?.message || urlOrError || '');
  return text.includes('opensuggprodview') || text.includes(PORTAL_REDIRECT);
}

/**
 * Keep a Playwright wait alive without letting it crash the process.
 *
 * These waits are started BEFORE the action that triggers them, so if that
 * action throws the wait is left with no one listening — and when it later
 * times out Node kills the whole run on an unhandled rejection. A real run
 * died exactly that way after publishing 31 listings:
 *   page.waitForResponse: Timeout 30000ms exceeded while waiting for event
 *   "response"  ->  triggerUncaughtException
 * Awaiting the returned promise still rejects normally; this only stops an
 * abandoned one from taking the process down.
 */
function detachable(promise) {
  promise.catch(() => {});
  return promise;
}

/** Close IndiaMART's "suggested products" / promo modals if one is open. */
async function dismissPopups(page) {
  const closers = [
    page.locator('xpath=//*[contains(@class,"close") or @aria-label="Close"]'),
    page.getByText('×', { exact: true }),
  ];
  for (const c of closers) {
    if (await c.count().catch(() => 0)) await tryClick(c, 1500);
  }
}

export class Uploader {
  constructor() {
    this.ctx = null;
    this.page = null;
  }

  async open() {
    const { ctx, page } = await openContext();
    this.ctx = ctx;
    this.page = page;
    if (!(await isLoggedIn(page))) {
      await ctx.close();
      throw new Error('Not logged in to IndiaMART. Run `npm run login` first.');
    }
    log.ok('IndiaMART session active.');
    return this;
  }

  async close() {
    if (this.ctx) await this.ctx.close();
  }

  /**
   * Screenshot the portal exactly as it stood when a product failed, next to a
   * note of the URL and every dialog/overlay that was on screen. The overlays
   * are the usual culprit and they are gone by the time anyone looks.
   */
  async captureFailure(product) {
    const page = this.page;
    if (!page || page.isClosed?.()) return null;
    const file = path.join(config.dataDir, `upload-fail-${product.id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const layers = await page
      .locator('[role="dialog"], [class*="modal"], [class*="overlay"], [class*="popup"]')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          })
          .map((node) => (node.id || node.className || 'unnamed').toString().slice(0, 60))
          .slice(0, 6),
      )
      .catch(() => []);
    fs.writeFileSync(
      file.replace(/\.png$/, '.txt'),
      `url: ${page.url()}\nvisible layers: ${layers.join(' | ') || 'none'}\n`,
    );
    return file;
  }

  async gotoManage() {
    // IndiaMART answers this URL with its own recommendation view now and then
    // ("?opensuggprodview=redirectsellerrecom"), where no "Active (N)" tab
    // exists — a run died on "Manage Products did not become ready at
    // …?opensuggprodview=redirectsellerrecom". Asking again lands on the real
    // page, so the upsell costs a reload rather than a product.
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.page.goto(config.indiamart.sellerUrl, { waitUntil: 'domcontentloaded' });
      await dismissPopups(this.page);
      try {
        await this.page.locator('text=/Active\\s*\\(\\d+\\)/').first().waitFor({
          state: 'visible',
          timeout: 15000,
        });
        return;
      } catch (cause) {
        lastError = cause;
        if (attempt === 3) break;
        // Two separate causes, one answer: the upsell view, and a portal that
        // has simply gone slow after a long run — "Manage Products did not
        // become ready at …/manageproducts/" with no redirect in the URL. A
        // reload costs seconds; failing here costs the product.
        log.warn(
          portalRedirected(this.page.url())
            ? `  IndiaMART served its recommendation view instead of Manage Products; reloading (attempt ${attempt})`
            : `  Manage Products did not render in time; reloading (attempt ${attempt})`,
        );
        await this.page.waitForTimeout(3000 * attempt);
      }
    }
    throw new Error(`Manage Products did not become ready at ${this.page.url()}`, { cause: lastError });
  }

  async activeCount() {
    const t = (await this.page.locator('text=/Active\\s*\\(\\d+\\)/').first().textContent().catch(() => '')) || '';
    const m = t.match(/\((\d+)\)/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Load every lazily-rendered product card in the currently selected status tab. */
  async _loadAllProductRows(expectedCount = null) {
    const rows = this.page.locator('a.MPSD_prdname');
    if (expectedCount === 0) return 0;

    if (expectedCount > 0) {
      await rows.first().waitFor({ state: 'attached', timeout: 15000 });
    } else {
      await rows.first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    }

    let previous = await rows.count();
    let unchanged = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (expectedCount !== null && previous >= expectedCount) break;

      await this.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await this.page
        .waitForFunction(
          (count) => document.querySelectorAll('a.MPSD_prdname').length > count,
          previous,
          { timeout: 3000 },
        )
        .catch(() => {});

      const current = await rows.count();
      unchanged = current === previous ? unchanged + 1 : 0;
      previous = current;
      if (unchanged >= 2) break;
    }
    await this.page.evaluate(() => window.scrollTo(0, 0));
    return previous;
  }

  /** Read exact product names separately from Active and Inactive/Deactivated tabs. */
  async fetchExistingState() {
    const p = this.page;
    const grab = async (expectedCount) => {
      await this._loadAllProductRows(expectedCount);
      const names = new Set();
      const rows = await p.locator('a.MPSD_prdname').allInnerTexts().catch(() => []);
      // Keyed by normalised token set, not exact slug: the account writes the
      // same product differently ("Vidalista 20 Mg …" vs "20mg Vidalista …").
      rows.map((name) => name.trim()).filter(Boolean).forEach((name) => names.add(name));
      return names;
    };
    const tabCount = async (tab) => {
      const text = (await tab.textContent().catch(() => '')) || '';
      const match = text.match(/\((\d+)\)/);
      return match ? parseInt(match[1], 10) : null;
    };

    await this.gotoManage();
    const active = await grab(await this.activeCount());
    const inactive = new Set();

    for (const label of ['Inactive', 'Deactivated']) {
      const tab = p.getByText(new RegExp(`^${label}\\s*\\(\\d+\\)$`)).first();
      if (!(await tab.isVisible().catch(() => false))) continue;
      await tab.click();
      await p.waitForTimeout(750);
      (await grab(await tabCount(tab))).forEach((name) => inactive.add(name));
    }
    return { active, inactive };
  }

  /** Return the union for callers that only need duplicate detection. */
  async fetchExistingNames() {
    const { active, inactive } = await this.fetchExistingState();
    return new Set([...active, ...inactive]);
  }

  /**
   * The single open product popup. Every field must be read and written
   * through this scope so no interaction can reach another listing's card.
   */
  async _productForm() {
    const form = this.page.locator('#editProductPopup:visible');
    const count = await form.count();
    if (count !== 1) {
      throw new Error(`Expected exactly one open product form, found ${count}`);
    }
    return form;
  }

  async _openForm() {
    // The green "+ Add Product" sits at the top of Manage Products, while
    // finding a listing scrolls through every lazily rendered row — on this
    // account that is a document about 87,000 px tall. Measured after a scan:
    // the button's box read y = -84430, so Playwright had to scroll ~84,000 px
    // back before it could click. With the old 4s budget that only sometimes
    // fit, which is how 33 products in a row failed with
    // 'Could not find the "Add Product" button' as the account grew.
    //
    // Scroll back up first and wait for the button to be genuinely on screen.
    // `getByRole('button')` is not tried at all: it is not a <button> and
    // matched 0 elements on every check, so it only ever burned the budget.
    // Judge this by whether the form opened, never by whether the click call
    // returned cleanly. Opening the form re-renders the page under Playwright,
    // so a click that worked can still be reported as a timeout — which is how
    // a product failed with 'Could not click the "Add Product" button' while
    // the failure screenshot showed the Add Product form open on screen.
    const button = this.page.getByText(SEL.addProduct, { exact: true }).first();
    const formOpened = (timeout) =>
      this.page
        .locator('#editProductPopup:visible')
        .first()
        .waitFor({ state: 'visible', timeout })
        .then(() => true)
        .catch(() => false);

    let opened = await formOpened(1000);
    for (let attempt = 1; attempt <= 2 && !opened; attempt += 1) {
      await this.page.evaluate(() => window.scrollTo(0, 0));
      await this.page
        .waitForFunction(
          () => {
            const node = [...document.querySelectorAll('span, div, a, button')].find(
              (el) => (el.textContent || '').trim() === 'Add Product',
            );
            if (!node) return false;
            const box = node.getBoundingClientRect();
            return box.top >= 0 && box.bottom <= window.innerHeight;
          },
          null,
          { timeout: 15000 },
        )
        .catch(() => {});
      const clicked = await tryClick(button, 20000);
      opened = await formOpened(15000);
      if (!opened) {
        log.warn(
          `  "Add Product" did not open the form (attempt ${attempt}; ` +
            `the click itself ${clicked ? 'reported success' : 'reported a timeout'})`,
        );
      }
    }
    if (!opened) {
      const shot = path.join(config.dataDir, 'add-product-button.png');
      await this.page.screenshot({ path: shot }).catch(() => {});
      const box = await button.boundingBox().catch(() => null);
      throw new Error(
        `"Add Product" did not open the product form ` +
          `(button found: ${await button.count().catch(() => 0)}, box: ${JSON.stringify(box)}). ` +
          `Screenshot: ${shot}`,
      );
    }

    try {
      await this.page
        .locator('#editProductPopup:visible')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });
    } catch (cause) {
      const placeholders = await this.page
        .locator('input[placeholder], textarea[placeholder]')
        .evaluateAll((fields) =>
          fields
            .filter((field) => {
              const box = field.getBoundingClientRect();
              const style = getComputedStyle(field);
              return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            })
            .map((field) => field.getAttribute('placeholder'))
            .filter(Boolean),
        )
        .catch(() => []);
      const shot = path.join(config.dataDir, 'add-product-form-timeout.png');
      await this.page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      throw new Error(
        `Add Product form did not become ready at ${this.page.url()}. ` +
          `Visible placeholders: ${placeholders.join(', ') || 'none'}. Screenshot: ${shot}`,
        { cause },
      );
    }

    // Add Product and Edit share #editProductPopup and #nameOfProduct. If the
    // portal opened an existing listing's editor — or one was still open from
    // an earlier step — then filling this form would rename that listing
    // instead of creating a product. Only a genuinely blank form is safe, and
    // the check must read the popup's own field, not a page-wide match.
    const form = await this._productForm();
    const nameField = await formField(form, 'nameOfProduct', SEL.name);
    await nameField.waitFor({ state: 'visible', timeout: 15000 });
    const openedName = (await nameField.inputValue().catch(() => '')).trim();
    if (openedName) {
      const shot = path.join(config.dataDir, 'add-product-opened-existing.png');
      await this.page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      throw new Error(
        `Add Product opened the existing listing "${openedName}" instead of a blank form; ` +
          `nothing was changed. Screenshot: ${shot}`,
      );
    }
    return form;
  }

  async _fillBasics(product) {
    const p = this.page;
    const seo = product.seo || {};
    const rawName = seo.name || product.name;
    const name = uploadProductName(product);

    if (!name) throw new Error('Product name is empty after applying IndiaMART character rules');
    if (name !== rawName) log.info(`  adjusted product name for IndiaMART: ${name}`);
    const form = await this._productForm();
    await (await formField(form, 'nameOfProduct', SEL.name)).fill(name);
    if (product.price !== '' && product.price != null)
      await (await formField(form, 'priceOfProduct', SEL.price)).fill(String(product.price));
    if (product.unit) {
      const unitField = await formField(form, 'unitOfProduct', SEL.unit);
      // On an existing listing IndiaMART locks the unit: the input renders
      // `disabled`, and filling it just stalls until the 30s action timeout.
      // Read what the listing already carries instead of hanging on it.
      if (await unitField.isDisabled().catch(() => false)) {
        const current = (await unitField.inputValue().catch(() => '')).trim();
        if (slugify(current) === slugify(String(product.unit))) {
          log.info(`  unit already set to "${current}" and locked by IndiaMART — left as is`);
        } else {
          log.warn(
            `  unit is locked by IndiaMART on this listing: it reads "${current || '(empty)'}" ` +
              `while the product says "${product.unit}". Change it on the portal if it matters.`,
          );
        }
      } else {
        await unitField.fill(String(product.unit));
        await p.waitForTimeout(500);
        // The current portal requires choosing a suggested unit; typing alone
        // leaves its internal unit value unset and Save and Continue does nothing.
        const unitChoice = p.locator('#unitSugg li').first();
        if (await unitChoice.isVisible().catch(() => false)) await unitChoice.click();
      }
    }

    await this._fillDescription(product);
  }

  async _fillDescription(product) {
    const p = this.page;
    const description = product.seo?.description || product.description || '';
    const descriptionHtml = prepareDescriptionHtml(description);
    const descriptionLength = descriptionFormattedLength(descriptionHtml);
    if (descriptionLength > DESCRIPTION_MAX_CHARS) {
      throw new Error(
        `Product description is ${descriptionLength} characters; maximum is ${DESCRIPTION_MAX_CHARS}`,
      );
    }

    // The current form uses TinyMCE in an iframe. Set semantic HTML through
    // TinyMCE's API when available so headings/lists remain structured and its
    // hidden textarea is synchronised before Save and Continue.
    const richTextFrame = p.locator('#item_desc_ifr').first();
    if (await richTextFrame.isVisible().catch(() => false)) {
      const editor = p.frameLocator('#item_desc_ifr').locator('body#tinymce, body[contenteditable="true"]').first();
      await editor.waitFor({ state: 'visible', timeout: 10000 });
      const setByTinyMce = await p
        .evaluate((html) => {
          const instance = window.tinymce?.get('item_desc');
          if (!instance) return false;
          instance.setContent(html);
          instance.fire('input');
          instance.fire('change');
          instance.save();
          return true;
        }, descriptionHtml)
        .catch(() => false);
      if (!setByTinyMce) {
        await editor.evaluate((body, html) => {
          body.innerHTML = html;
          body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          body.dispatchEvent(new Event('change', { bubbles: true }));
        }, descriptionHtml);
      }
      const rendered = await editor.evaluate((body) => ({
        textLength: (body.innerText || '').trim().length,
        formattedLength: body.innerHTML.length,
      }));
      if (descriptionHtml && rendered.textLength === 0) throw new Error('TinyMCE did not retain the product description');
      if (rendered.formattedLength > DESCRIPTION_MAX_CHARS) {
        throw new Error(
          `TinyMCE description is ${rendered.formattedLength} characters including formatting; maximum is ${DESCRIPTION_MAX_CHARS}`,
        );
      }
    } else {
      // Fallback for accounts still receiving the previous inline editor.
      const editor = p.locator('div[contenteditable="true"]').first();
      await editor.waitFor({ state: 'visible', timeout: 10000 });
      await editor.evaluate((body, html) => {
        body.innerHTML = html;
        body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        body.dispatchEvent(new Event('change', { bubbles: true }));
      }, descriptionHtml);
      const formattedLength = await editor.evaluate((body) => body.innerHTML.length);
      if (formattedLength > DESCRIPTION_MAX_CHARS) {
        throw new Error(
          `Product description is ${formattedLength} characters including formatting; maximum is ${DESCRIPTION_MAX_CHARS}`,
        );
      }
    }
    log.info(`  description formatted (${descriptionLength}/${DESCRIPTION_MAX_CHARS} characters including formatting)`);
    return { html: descriptionHtml, formattedLength: descriptionLength };
  }

  async _readDescriptionText() {
    const p = this.page;
    const richTextFrame = p.locator('#item_desc_ifr').first();
    if (await richTextFrame.isVisible().catch(() => false)) {
      const editor = p.frameLocator('#item_desc_ifr').locator('body#tinymce, body[contenteditable="true"]').first();
      await editor.waitFor({ state: 'visible', timeout: 10000 });
      return (await editor.innerText()).replace(/\s+/g, ' ').trim();
    }
    const editor = p.locator('div[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 10000 });
    return (await editor.innerText()).replace(/\s+/g, ' ').trim();
  }

  async _uploadPhotos(product) {
    const images = productImageFiles(product);
    if (!images.length) {
      log.warn('  no images to upload — listing will be created without a photo');
      return 0;
    }

    const p = this.page;
    const form = p.locator('#editProductPopup');
    const photoCard = form.locator('.MPSD_PRImg').filter({ hasText: 'Add Photo' }).last();
    const prepared = [];
    const uploadImageRuntime = getUploadImageRuntime();

    try {
      for (let index = 0; index < images.length; index += 1) {
        prepared.push(
          await prepareUploadImage(
            p,
            images[index],
            `${product.id}-${index + 1}`,
            uploadImageRuntime,
            index,
          ),
        );
      }

      await photoCard.click({ timeout: 5000 });
      const uploadButton = p.locator('.uploadbtndiv button').filter({ hasText: /upload photos from computer/i }).last();
      await uploadButton.waitFor({ state: 'visible', timeout: 5000 });

      const chooserPromise = detachable(p.waitForEvent('filechooser', { timeout: 5000 }));
      await uploadButton.click();
      const chooser = await chooserPromise;
      if (images.length > 1 && !chooser.isMultiple()) {
        throw new Error(`IndiaMART file input accepted only one file; ${images.length} were prepared`);
      }
      await chooser.setFiles(prepared.map((item) => item.filePath));

      // The multiImg crop popup previews the whole selection and confirms it
      // once. Wait for it to finish reading every file before confirming —
      // clicking early publishes only the photos that happened to be in.
      const crop = p.locator('#im-crop-block.is-visible-imcrp');
      const cropOpened = await crop
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (cropOpened) {
        const confirmed = await waitForCropSelection(p, crop, images.length);
        log.info(`  crop popup holds ${confirmed}/${images.length} selected photo(s)`);
        const uploadPhoto = crop.getByText(/^Upload Photos?$/, { exact: true }).last();
        await uploadPhoto.click({ timeout: 10000 });
        logPhotoRejections(await readPhotoRejections(p), 'this new listing');
        await crop.waitFor({ state: 'hidden', timeout: 30000 });
      } else {
        // Older portal variants attach the gallery without a cropper.
        log.warn('  no crop popup appeared; relying on the Add Photos confirmation');
        await p.waitForTimeout(2500);
      }

      // Older portal variants return to an Add Photos confirmation dialog;
      // newer ones attach the gallery immediately after the crop step.
      const confirm = p.getByRole('button', { name: /^add photos$/i }).last();
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click({ timeout: 5000 });
        await confirm.waitFor({ state: 'hidden', timeout: 10000 });
      } else {
        await uploadButton.waitFor({ state: 'hidden', timeout: 10000 });
      }
      images.forEach((image, index) => {
        log.info(`  photo ${index + 1}/${images.length} uploaded: ${path.basename(image)}`);
      });
      log.info(`  photos uploaded: ${images.length}/${images.length}`);
      return images.length;
    } catch (e) {
      const cropOverlay = p.locator('#im-crop-block .popup-overlay-imcrp').first();
      if (await cropOverlay.isVisible().catch(() => false)) await cropOverlay.click({ force: true }).catch(() => {});
      const cancel = p.locator('#photodocpopup').getByText('Cancel', { exact: true }).last();
      if (await cancel.isVisible().catch(() => false)) await cancel.click({ force: true }).catch(() => {});
      await dismissPopups(p);
      throw new Error(`Gallery upload failed (${images.length} photos): ${e.message}`, { cause: e });
    } finally {
      for (const item of prepared) {
        if (item.temporary) fs.unlinkSync(item.filePath);
      }
    }
  }

  /**
   * IndiaMART's document upload and PDF-to-image conversion are separate
   * services, and under load either can miss its window — seen twice on the
   * same product as "PDF upload failed: page.waitForResponse: Timeout 45000ms
   * exceeded". The file and the form are unchanged when that happens, so the
   * step is worth one clean retry before the product is called failed.
   */
  async _uploadPdf() {
    try {
      return await this._uploadPdfOnce();
    } catch (error) {
      if (!/waitForResponse|Timeout \d+ms exceeded/i.test(error.message)) throw error;
      log.warn(`  PDF step timed out against IndiaMART; retrying once (${error.message.split('\n')[0]})`);
      await this.page.waitForTimeout(4000);
      return this._uploadPdfOnce();
    }
  }

  async _uploadPdfOnce() {
    const pdfPath = getSharedProductPdfPath();
    if (!pdfPath) {
      throw new Error('No shared product PDF selected. Choose one from the app toolbar before uploading.');
    }
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`Selected shared product PDF no longer exists: ${pdfPath}`);
    }

    const p = this.page;
    const form = p.locator('#editProductPopup');
    const pdfCard = form.locator('.pdfBlog').first();
    try {
      await pdfCard.waitFor({ state: 'visible', timeout: 10000 });

      // IndiaMART does more than retain a File on this hidden input. Clicking
      // the visible card establishes the active product context, then its file
      // chooser starts both the document upload and PDF-to-image conversion.
      // Save and Continue must not run until both services acknowledge success.
      const chooserPromise = detachable(p.waitForEvent('filechooser', { timeout: 5000 }));
      await pdfCard.locator('.actionPDF').click({ timeout: 5000 });
      const chooser = await chooserPromise;

      const uploadPromise = detachable(p.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('uploading.imimg.com/uploadimage'),
        { timeout: 30000 },
      ));
      const conversionPromise = detachable(p.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('pdf_to_image_service_new.php'),
        { timeout: 45000 },
      ));
      await chooser.setFiles(pdfPath);

      const [uploadResponse, conversionResponse] = await Promise.all([uploadPromise, conversionPromise]);
      const parseResponse = async (response, service) => {
        const body = await response.text();
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          throw new Error(`${service} returned invalid JSON: ${body.slice(0, 300)}`);
        }
        if (!response.ok()) {
          throw new Error(`${service} returned HTTP ${response.status()}: ${body.slice(0, 300)}`);
        }
        return data;
      };
      const upload = await parseResponse(uploadResponse, 'IndiaMART document upload');
      const conversion = await parseResponse(conversionResponse, 'IndiaMART PDF conversion');
      const remotePdf = upload?.Data?.AwsPath?.Image_Original_Path;
      if (Number(upload?.Code) !== 200 || !/^success$/i.test(String(upload?.Status || '')) || !remotePdf) {
        throw new Error(`IndiaMART document upload was not accepted: ${JSON.stringify(upload).slice(0, 500)}`);
      }
      if (!conversion?.PDF_URL || Number(conversion?.NO_OF_IMG_RENDERED) < 1) {
        throw new Error(`IndiaMART PDF conversion was not accepted: ${JSON.stringify(conversion).slice(0, 500)}`);
      }

      await pdfCard.getByText('View PDF', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
      const attachedName = await pdfCard.locator('img[title]').first().getAttribute('title');
      if (attachedName?.toLowerCase() !== path.basename(pdfPath).toLowerCase()) {
        throw new Error(`IndiaMART acknowledged a different PDF: ${attachedName || 'unknown file'}`);
      }

      // The conversion opens a second z-index 9999 dialog asking which rendered
      // PDF page(s) to add to the gallery. Until its explicit Save button runs,
      // the dialog covers Save and Continue and the PDF is not committed.
      const previewModal = p.locator('#savephotoModal_g02.show-modal');
      if (await previewModal.isVisible().catch(() => false)) {
        const selectedPreviewCount = Number(
          (await previewModal.locator('#no_of_selected_images').innerText().catch(() => '0')).trim(),
        );
        if (selectedPreviewCount < 1) {
          throw new Error('IndiaMART PDF preview dialog has no selected page to save');
        }
        const previewUploadPromise = detachable(p.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().includes('uploading.imimg.com/uploadimage'),
          { timeout: 30000 },
        ));
        await previewModal.locator('#save_btn_main_g02').click({ timeout: 5000 });
        const previewUpload = await previewUploadPromise;
        if (!previewUpload.ok()) {
          throw new Error(`IndiaMART PDF preview upload returned HTTP ${previewUpload.status()}`);
        }
        await previewModal.waitFor({ state: 'hidden', timeout: 20000 });
        log.info(`  PDF preview confirmed: ${selectedPreviewCount} page(s)`);

        // Saving the selected PDF page opens IndiaMART's image crop/review
        // popup for the rendered preview. Accept its untouched full-page
        // canvas; otherwise this z-index overlay remains above the subsequent
        // specification form and intercepts every radio-button click.
        const previewCrop = p.locator('#im-crop-block.is-visible-imcrp');
        const cropOpened = await previewCrop
          .waitFor({ state: 'visible', timeout: 10000 })
          .then(() => true)
          .catch(() => false);
        if (cropOpened) {
          const cropText = (await previewCrop.innerText().catch(() => '')) || '';
          if (!/Upload Photos\b/i.test(cropText)) {
            throw new Error(`IndiaMART PDF preview crop dialog was not ready: ${cropText.slice(0, 300)}`);
          }
          const uploadPreview = previewCrop.getByText(/^Upload Photos?$/, { exact: true }).last();
          await uploadPreview.click({ timeout: 10000 });
          await previewCrop.waitFor({ state: 'hidden', timeout: 20000 });
          log.info('  PDF preview crop confirmed without modifying the rendered page');

          // Confirming it can bring the very same popup straight back. Settle
          // that here rather than letting it surface seconds later as a
          // blocked Save and Continue.
          const reopened = await previewCrop
            .waitFor({ state: 'visible', timeout: 3000 })
            .then(() => true)
            .catch(() => false);
          if (reopened) await this._drainImageReview('after the PDF preview');
        }
      }

      log.info(
        `  PDF uploaded and converted: ${attachedName} (${conversion.NO_OF_IMG_RENDERED} preview image(s))`,
      );
      return true;
    } catch (error) {
      throw new Error(`PDF upload failed: ${error.message}`, { cause: error });
    }
  }

  /**
   * Confirm and close IndiaMART's crop/review popup for as long as it keeps
   * coming back.
   *
   * Saving the rendered PDF page reopens this popup even though the very same
   * preview was just confirmed, and its z-index overlay swallows every click
   * underneath it. When that happens is a race: on one machine it reappeared
   * after Save and Continue, on another before it, blocking the button with
   * "visible layers: … im-crop-block: … 12 More … Upload Photos".
   */
  async _drainImageReview(stage) {
    const p = this.page;
    const crop = p.locator('#im-crop-block.is-visible-imcrp');
    for (let pass = 0; pass < 3; pass += 1) {
      if (!(await crop.isVisible().catch(() => false))) break;
      const uploadPhotos = crop.getByText(/^Upload Photos?$/, { exact: true }).last();
      if (!(await uploadPhotos.isVisible().catch(() => false))) {
        throw new Error('IndiaMART image review popup reopened without an Upload Photos confirmation');
      }
      await uploadPhotos.click({ timeout: 10000 });
      await crop.waitFor({ state: 'hidden', timeout: 20000 });
      await p.waitForTimeout(750);
      log.info(`  confirmed reopened image review ${stage} (pass ${pass + 1})`);
    }
    if (await crop.isVisible().catch(() => false)) {
      throw new Error(`IndiaMART image review popup kept reopening ${stage}`);
    }
  }

  async _finish(product, { fillSpecifications = true } = {}) {
    const p = this.page;
    const form = p.locator('#editProductPopup');
    const crop = p.locator('#im-crop-block.is-visible-imcrp');
    const saveContinue = form.locator('.MPSD_AdEditSVCon').filter({ hasText: 'Save and Continue' }).first();

    // Clear the review popup first, and treat it as the one retryable reason a
    // click can fail: it can also open *during* the attempt. Any other failure
    // is reported straight away rather than retried blindly.
    for (let attempt = 1; ; attempt += 1) {
      await this._drainImageReview('before Save and Continue');
      try {
        await saveContinue.waitFor({ state: 'visible', timeout: 10000 });
        if ((await saveContinue.getAttribute('aria-disabled')) === 'true') {
          throw new Error('IndiaMART has disabled Save and Continue');
        }
        await saveContinue.click({ timeout: 10000 });
        break;
      } catch (cause) {
        const blockedAgain = await crop.isVisible().catch(() => false);
        if (blockedAgain && attempt < 3) {
          log.warn(`  image review popup reopened over Save and Continue; clearing it (attempt ${attempt})`);
          continue;
        }
        // IndiaMART sometimes navigates the whole tab to its own product
        // recommendation view mid-edit ("?opensuggprodview=redirectsellerrecom"),
        // taking the form with it. Nothing was wrong with the product, so say
        // so distinctly and let the caller reopen the listing.
        if (portalRedirected(p.url()) || !(await form.first().isVisible().catch(() => false))) {
          throw new Error(`${PORTAL_REDIRECT}: the product form is gone, page is at ${p.url()}`);
        }
        const visibleLayers = await p
          .locator('[role="dialog"], [class*="modal"], [class*="overlay"], [class*="popup"]')
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => {
                const box = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
              })
              .map((node) => `${node.id || node.className}: ${(node.innerText || '').trim().slice(0, 120)}`)
              .slice(0, 5),
          )
          .catch(() => []);
        throw new Error(
          `Could not click active Add Product Save and Continue` +
            `${visibleLayers.length ? `; visible layers: ${visibleLayers.join(' | ')}` : ''}`,
          { cause },
        );
      }
    }

    // wait for the specification step
    const finish = p.getByText(SEL.finish, { exact: true }).first();
    await finish.waitFor({ timeout: 15000 });

    await this._drainImageReview('before specifications');

    let result = { missingRequired: [] };
    if (fillSpecifications) {
      result = await fillSpecs(p, product);
      if (result.missingRequired.length) {
        throw new Error(`Could not set required specifications: ${result.missingRequired.join(', ')}`);
      }
    }
    if (!(await tryClick(finish, 10000))) {
      throw new Error(
        fillSpecifications
          ? 'Could not click Finish after setting specifications'
          : 'Could not click Finish after updating the description',
      );
    }
    await p.waitForTimeout(1800);

    // If IndiaMART still reports missing specs, re-read the rendered form once
    // and require every field to be selected before retrying Finish.
    if (await p.getByText('Missing Specification', { exact: false }).count().catch(() => 0)) {
      log.warn('  still missing specs — retrying');
      result = await fillSpecs(p, product);
      if (result.missingRequired.length) {
        throw new Error(`Could not set required specifications: ${result.missingRequired.join(', ')}`);
      }
      if (!(await tryClick(p.getByText(SEL.finish, { exact: false }), 10000))) {
        throw new Error('Could not click Finish after retrying specifications');
      }
      await p.waitForTimeout(1800);
    }
    return result;
  }

  /**
   * Find exactly one existing product card on the active Manage Products page.
   * Matching is deliberately exact after the same normalization used during
   * upload so a specs repair can never open or create the wrong product.
   */
  async _findActiveProduct(product) {
    await this._loadAllProductRows(await this.activeCount());
    const candidates = new Set(
      [uploadProductName(product), product.seo?.name, product.name]
        .filter(Boolean)
        .map((name) => slugify(name)),
    );
    const rows = await this.page.locator('a.MPSD_prdname').evaluateAll((anchors) =>
      anchors.map((anchor) => ({
        anchorId: anchor.id || '',
        itemId: (anchor.id || '').match(/^itemName(\d+)$/)?.[1] || '',
        name: (anchor.innerText || anchor.textContent || '').trim(),
      })),
    );
    const matches = rows.filter((row) => row.itemId && candidates.has(slugify(row.name)));
    if (matches.length > 1) {
      throw new Error(
        `Found multiple exact live products named "${uploadProductName(product)}"; ` +
          'refusing to choose one automatically',
      );
    }
    if (!matches.length) return null;

    const match = matches[0];
    const anchor = this.page.locator(`#${match.anchorId}`);
    const card = anchor.locator('xpath=ancestor::div[contains(@class,"MPSD_prdlstcont")][1]');
    return { ...match, anchor, card };
  }

  /** Name of every rendered Active listing, keyed by IndiaMART item id. */
  async _activeNamesById() {
    await this._loadAllProductRows(await this.activeCount());
    const rows = await this.page.locator('a.MPSD_prdname').evaluateAll((anchors) =>
      anchors
        .map((anchor) => [
          (anchor.id || '').match(/^itemName(\d+)$/)?.[1] || '',
          (anchor.innerText || anchor.textContent || '').trim(),
        ])
        .filter(([itemId]) => itemId),
    );
    return new Map(rows);
  }

  /**
   * Prove the run touched only its own listing.
   *
   * Verifying by name cannot detect collateral damage: if the form wrote over
   * another listing, that listing now carries this product's name and matches
   * the very value that was written. Comparing every listing's name against a
   * snapshot taken beforehand is independent of which selector went wrong.
   */
  async _assertOnlyTouched(namesBefore, allowedItemId) {
    await this.gotoManage();
    const namesAfter = await this._activeNamesById();
    const renamed = collateralRenames(namesBefore, namesAfter, allowedItemId);
    if (renamed.length) {
      const shot = path.join(config.dataDir, 'collateral-rename.png');
      await this.page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      throw new Error(
        `This run renamed ${renamed.length} unrelated IndiaMART listing(s): ${renamed.join('; ')}. ` +
          `Restore those names on Manage Products. Screenshot: ${shot}`,
      );
    }
  }

  /** The product group currently shown on a listing's card, '' when unset. */
  async _cardGroup(card) {
    const text = (await card.innerText().catch(() => '')) || '';
    const match = text.match(/(?:^|\n)Group\s*\n\s*([^\n]+)/);
    return match ? match[1].trim() : '';
  }

  /**
   * Put one live listing into a product group, creating the group when the
   * account does not have it yet.
   *
   * The group is not part of the Add Product form — that step only takes the
   * name, price and unit. It is set from the listing's card on Manage
   * Products: the "Group" link opens a chip menu of the account's groups
   * (`span.MPSD_Groupmenutxt[data-catid]`) plus a "+ Create New Group" field.
   */
  async setProductGroup(product, live, groupName) {
    const wanted = String(groupName || '').trim();
    if (!wanted) return { group: '', changed: false };

    const current = await this._cardGroup(live.card);
    if (current.toLowerCase() === wanted.toLowerCase()) {
      return { group: current, changed: false };
    }

    await live.card.locator('span', { hasText: /^Group$/ }).first().click({ timeout: 10000 });
    const menu = this.page.locator('div[class*="MPSD_Gro"]').first();
    await menu.waitFor({ state: 'visible', timeout: 10000 });

    // Show every group the account has, not only the first page of chips.
    const more = menu.getByText(/^More$/).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click().catch(() => {});
      await this.page.waitForTimeout(1200);
    }

    // Match an existing group case-insensitively so a second run reuses it.
    const existing = await this.page.evaluate((name) => {
      const chip = [...document.querySelectorAll('span.MPSD_Groupmenutxt[data-catid]')].find(
        (span) => (span.getAttribute('data-catname') || '').trim().toLowerCase() === name.toLowerCase(),
      );
      return chip ? chip.getAttribute('data-catname') : '';
    }, wanted);

    if (existing) {
      await this.page
        .locator(`span.MPSD_Groupmenutxt[data-catname="${existing}"]`)
        .first()
        .click({ timeout: 10000 });
    } else {
      await menu.getByText('+ Create New Group').first().click({ timeout: 10000 });
      const field = this.page.locator('#addNewGroupName');
      await field.waitFor({ state: 'visible', timeout: 10000 });
      await field.fill(wanted);
      await this.page.getByText('Done', { exact: true }).last().click({ timeout: 10000 });
    }
    await this.page.waitForTimeout(2500);

    // Read the card back rather than trusting the click.
    await this.gotoManage();
    const verified = await this._findActiveProduct(product);
    if (!verified || verified.itemId !== live.itemId) {
      throw new Error(`Could not re-read IndiaMART item ${live.itemId} after setting its group`);
    }
    const applied = await this._cardGroup(verified.card);
    if (applied.toLowerCase() !== wanted.toLowerCase()) {
      throw new Error(
        `IndiaMART item ${live.itemId} shows group "${applied || 'none'}" instead of "${wanted}"`,
      );
    }
    return { group: applied, changed: true, created: !existing };
  }

  /** Find the exact live listing for a product and put it in a group. */
  async applyGroup(product, groupName) {
    await this.gotoManage();
    const live = await this._findActiveProduct(product);
    if (!live) {
      throw new Error(
        `Active listing not found for "${uploadProductName(product)}"; its group was not set`,
      );
    }
    return this.setProductGroup(product, live, groupName);
  }

  async _livePhotoUrls(live) {
    return live.card.locator('img').evaluateAll((images, itemId) => {
      const urls = images
        .filter((image) => {
          const src = image.currentSrc || image.src || '';
          const owner = image.dataset.itemid || image.closest('[data-itemid]')?.dataset.itemid || '';
          return owner === itemId && /\/SELLER\/Default\//i.test(src);
        })
        .map((image) => image.currentSrc || image.src);
      return [...new Set(urls)];
    }, live.itemId);
  }

  async _pdfName(scope) {
    const icon = scope.locator('.pdfBlog img[title]').first();
    if (!(await icon.isVisible().catch(() => false))) return '';
    return ((await icon.getAttribute('title')) || '').trim();
  }

  async _openExactEditor(product, live) {
    const edit = live.card.locator(`a[data-itemid="${live.itemId}"]`).filter({ hasText: 'Edit' }).first();
    if ((await edit.count()) !== 1) {
      throw new Error(`Could not find the Edit action for IndiaMART item ${live.itemId}`);
    }
    await edit.evaluate((link) => link.click());

    await this.page
      .locator('#editProductPopup:visible')
      .first()
      .waitFor({ state: 'visible', timeout: 10000 });
    const form = await this._productForm();
    const openedName = (await (await formField(form, 'nameOfProduct', SEL.name)).inputValue()).trim();
    const expectedNames = new Set(
      [uploadProductName(product), product.seo?.name, product.name]
        .filter(Boolean)
        .map((name) => slugify(name)),
    );
    if (!expectedNames.has(slugify(openedName))) {
      throw new Error(
        `IndiaMART opened "${openedName || 'an unnamed product'}" instead of ` +
          `"${uploadProductName(product)}"; no changes were submitted`,
      );
    }
    return form;
  }

  async _uploadMissingPhotos(product, live) {
    const desiredFiles = productImageFiles(product);
    const currentUrls = await this._livePhotoUrls(live);
    if (currentUrls.length >= desiredFiles.length) {
      return { live, photoCount: currentUrls.length, added: 0 };
    }

    // Products created before a later step failed retain the leading photos in
    // upload order. Add only the missing tail through IndiaMART's observed
    // "N More" secondary-gallery flow, never replacing the current primary.
    const missingFiles = desiredFiles.slice(currentUrls.length);
    const prepared = [];
    const uploadImageRuntime = getUploadImageRuntime();
    try {
      for (let index = 0; index < missingFiles.length; index += 1) {
        const galleryIndex = currentUrls.length + index;
        prepared.push(
          await prepareUploadImage(
            this.page,
            missingFiles[index],
            `${product.id}-missing-${galleryIndex + 1}`,
            uploadImageRuntime,
            galleryIndex,
          ),
        );
      }

      const addPhoto = live.card.locator('.MPSD_PRImg').filter({ hasText: 'Add Photo' }).first();
      if (!(await addPhoto.isVisible().catch(() => false))) {
        throw new Error(`IndiaMART item ${live.itemId} has no Add Photo control`);
      }
      await addPhoto.click({ timeout: 5000 });

      const crop = this.page.locator('#im-crop-block.is-visible-imcrp');
      const cropOpened = await crop
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      // Photos already in the cropper are this listing's existing gallery; the
      // new files are counted on top of them, never instead of them.
      let baseline = 0;
      if (cropOpened) {
        baseline = (await readCropState(crop))?.thumbnails ?? 0;
        const addMore = crop.locator('.Thumb_Noimage').first();
        if (!(await addMore.isVisible().catch(() => false))) {
          throw new Error(`IndiaMART item ${live.itemId} has no empty secondary-photo slot`);
        }
        const action = (await addMore.getAttribute('onclick')) || '';
        if (!action.includes(String(live.itemId))) {
          throw new Error(`IndiaMART secondary-photo control did not target item ${live.itemId}`);
        }
        await addMore.click({ timeout: 5000 });
      }

      const uploadButton = this.page
        .locator('.uploadbtndiv button')
        .filter({ hasText: /upload photos from computer/i })
        .last();
      await uploadButton.waitFor({ state: 'visible', timeout: 10000 });
      const chooserPromise = detachable(this.page.waitForEvent('filechooser', { timeout: 10000 }));
      await uploadButton.click();
      const chooser = await chooserPromise;
      if (prepared.length > 1 && !chooser.isMultiple()) {
        throw new Error(`IndiaMART accepted only one file while ${prepared.length} gallery photos are missing`);
      }
      await chooser.setFiles(prepared.map((item) => item.filePath));

      await crop.waitFor({ state: 'visible', timeout: 15000 });
      const expectedTotal = baseline + prepared.length;
      const confirmed = await waitForCropSelection(this.page, crop, expectedTotal, baseline);
      log.info(`  crop popup holds ${confirmed}/${expectedTotal} photo(s) for item ${live.itemId}`);
      const uploadPhotos = crop.getByText(/^Upload Photos?$/, { exact: true }).last();
      await uploadPhotos.click({ timeout: 10000 });
      const rejected = await readPhotoRejections(this.page, 8000);
      logPhotoRejections(rejected, `item ${live.itemId}`);
      await crop.waitFor({ state: 'hidden', timeout: 30000 });
      await this.page.waitForTimeout(2000);

      await this.gotoManage();
      const verified = await this._findActiveProduct(product);
      if (!verified || verified.itemId !== live.itemId) {
        throw new Error(`Could not verify IndiaMART item ${live.itemId} after adding gallery photos`);
      }
      const verifiedUrls = await this._livePhotoUrls(verified);
      if (verifiedUrls.length + rejected.length < desiredFiles.length) {
        throw new Error(
          `IndiaMART item ${live.itemId} retained ${verifiedUrls.length}/${desiredFiles.length} source photos`,
        );
      }
      // A photo IndiaMART's own dedup service refuses cannot be added by
      // retrying, so it is a known gap rather than a failure.
      if (verifiedUrls.length < desiredFiles.length) {
        log.warn(
          `  item ${live.itemId} keeps ${verifiedUrls.length}/${desiredFiles.length} photos; ` +
            'IndiaMART will not store the rest',
        );
      }
      missingFiles.forEach((file, index) => {
        log.info(`  missing photo ${index + 1}/${missingFiles.length} added: ${path.basename(file)}`);
      });
      return {
        live: verified,
        photoCount: verifiedUrls.length,
        added: missingFiles.length,
        refused: rejected.length,
      };
    } finally {
      for (const item of prepared) {
        if (item.temporary) fs.unlinkSync(item.filePath);
      }
    }
  }

  async _completeExistingProduct(product, live, { before = null } = {}) {
    const itemId = live.itemId;
    const desiredPhotoCount = productImageFiles(product).length;
    const media = await this._uploadMissingPhotos(product, live);
    live = media.live;

    const form = await this._openExactEditor(product, live);
    await this._fillBasics(product);
    const existingPdf = await this._pdfName(form);
    if (!existingPdf) await this._uploadPdf();
    else log.info(`  existing PDF retained: ${existingPdf}`);
    await this._finish(product);

    await this.gotoManage();
    const verified = await this._findActiveProduct(product);
    if (!verified || verified.itemId !== itemId) {
      throw new Error(`Could not verify repaired IndiaMART item ${itemId}`);
    }
    const photoUrls = await this._livePhotoUrls(verified);
    // Photos IndiaMART refused as already-present are counted here too: they
    // are gone for good, and failing the whole listing over them only produces
    // a product that can never finish.
    if (photoUrls.length + (media.refused || 0) < desiredPhotoCount) {
      throw new Error(`IndiaMART item ${itemId} has only ${photoUrls.length}/${desiredPhotoCount} source photos`);
    }
    const pdfName = await this._pdfName(verified.card);
    if (!pdfName) throw new Error(`IndiaMART item ${itemId} did not retain its PDF`);

    const verificationForm = await this._openExactEditor(product, verified);
    const openedPrice = await (await formField(verificationForm, 'priceOfProduct', SEL.price)).inputValue();
    const openedUnit = await (await formField(verificationForm, 'unitOfProduct', SEL.unit)).inputValue();
    const actualDescription = await this._readDescriptionText();
    const expectedDescription = visibleDescriptionText(
      prepareDescriptionHtml(product.seo?.description || product.description || ''),
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (actualDescription !== expectedDescription) {
      throw new Error(`IndiaMART item ${itemId} did not retain the complete description`);
    }
    if (String(openedPrice).trim() !== String(product.price ?? '').trim()) {
      throw new Error(`IndiaMART item ${itemId} retained price "${openedPrice}" instead of "${product.price}"`);
    }
    if (slugify(openedUnit) !== slugify(product.unit)) {
      throw new Error(`IndiaMART item ${itemId} retained unit "${openedUnit}" instead of "${product.unit}"`);
    }
    if (!(await this._pdfName(verificationForm))) {
      throw new Error(`IndiaMART item ${itemId} PDF was not visible after reopening the editor`);
    }

    const after = await this.activeCount();
    return {
      ok: true,
      before,
      after,
      itemId,
      repaired: true,
      photoCount: photoUrls.length,
      pdfName,
      descriptionCharacters: expectedDescription.length,
    };
  }

  /**
   * Edit an existing live product and submit only its specification step.
   * This never clicks Add Product and never uploads photos or the shared PDF.
   */
  async reuploadSpecs(product) {
    await this.gotoManage();
    const live = await this._findActiveProduct(product);
    if (!live) {
      throw new Error(
        `Active IndiaMART product not found for "${uploadProductName(product)}"; ` +
          'no duplicate product was created',
      );
    }

    // Same guarded open as every other edit path: it verifies the exact
    // data-itemid and re-reads the popup's own name field before anything is
    // submitted, so no other listing can be touched.
    await this._openExactEditor(product, live);

    const filled = await this._finish(product);
    await this.gotoManage();
    const verified = await this._findActiveProduct(product);
    if (!verified || verified.itemId !== live.itemId) {
      throw new Error(`Could not verify the live product after updating specifications (item ${live.itemId})`);
    }
    const liveCardText = (await verified.card.innerText().catch(() => '')) || '';
    const missingMatch = liveCardText.match(/\b(\d+)\s+missing\b/i);
    const stillMissing = missingMatch ? Number(missingMatch[1]) : 0;

    // Fields IndiaMART has no option for cannot be filled without publishing a
    // value the product does not have, so they are left blank on purpose. That
    // is a finished job with a known gap, not a failure to retry — only a
    // count beyond those fields means something was actually missed.
    const leftBlank = filled?.leftBlank || [];
    if (stillMissing > leftBlank.length) {
      throw new Error(
        `IndiaMART item ${live.itemId} still reports ${stillMissing} missing specification(s) ` +
          `and only ${leftBlank.length} were deliberately left blank; ` +
          'add the remaining values to Specs JSON and retry',
      );
    }
    if (stillMissing) {
      log.warn(
        `  item ${live.itemId} shows ${stillMissing} field(s) left blank because this product ` +
          'has no true value for them:',
      );
      leftBlank.forEach((field) => log.warn(`    ${field.group} — ${field.reason}`));
    }
    return {
      ok: true,
      itemId: live.itemId,
      name: live.name,
      missingSpecifications: stillMissing,
      leftBlank: leftBlank.map((field) => field.group),
    };
  }

  /**
   * Update only the description on one exact existing live product. The flow
   * never clicks Add Product and never touches its photos or shared PDF.
   */
  async reuploadDescription(product) {
    const expectedHtml = prepareDescriptionHtml(product.seo?.description || product.description || '');
    const expectedText = visibleDescriptionText(expectedHtml).replace(/\s+/g, ' ').trim();
    if (!expectedText) throw new Error('Product description is empty; nothing was uploaded');

    await this.gotoManage();
    const live = await this._findActiveProduct(product);
    if (!live) {
      throw new Error(
        `Active IndiaMART product not found for "${uploadProductName(product)}"; ` +
          'no duplicate product was created',
      );
    }

    const openExactEditor = (match) => this._openExactEditor(product, match);

    await openExactEditor(live);
    await this._fillDescription(product);
    await this._finish(product, { fillSpecifications: false });

    await this.gotoManage();
    const verified = await this._findActiveProduct(product);
    if (!verified || verified.itemId !== live.itemId) {
      throw new Error(`Could not verify the live product after updating its description (item ${live.itemId})`);
    }

    // Reopen the same item and compare rendered editor text, not only a success
    // toast, so IndiaMART cannot silently retain the previous description.
    await openExactEditor(verified);
    const actualText = await this._readDescriptionText();
    if (actualText !== expectedText) {
      throw new Error(
        `IndiaMART item ${live.itemId} retained different description text ` +
          `(expected ${expectedText.length} characters, found ${actualText.length})`,
      );
    }

    return {
      ok: true,
      itemId: live.itemId,
      name: live.name,
      descriptionCharacters: expectedText.length,
    };
  }

  /**
   * Add or reconcile one product end-to-end. Exact existing failed/partial
   * listings are repaired in place; Add Product is used only when no exact
   * Active item exists.
   */
  async addProduct(product, { dryRun = false } = {}) {
    await this.gotoManage();
    const before = await this.activeCount();
    const existing = await this._findActiveProduct(product);
    if (existing) {
      if (dryRun) {
        log.warn(`  dry-run: exact existing item ${existing.itemId} would be reconciled`);
        return { ok: false, before, after: before, dryRun: true, itemId: existing.itemId };
      }
      log.warn(`  exact existing item ${existing.itemId} found — repairing it instead of adding a duplicate`);
      const namesBeforeRepair = await this._activeNamesById();
      let repaired;
      try {
        repaired = await this._completeExistingProduct(product, existing, { before });
      } catch (error) {
        if (!portalRedirected(error)) throw error;
        log.warn('  IndiaMART jumped to its recommendation view mid-edit; reopening this listing');
        await this.gotoManage();
        const reopened = await this._findActiveProduct(product);
        if (!reopened || reopened.itemId !== existing.itemId) throw error;
        repaired = await this._completeExistingProduct(product, reopened, { before });
      }
      await this._assertOnlyTouched(namesBeforeRepair, existing.itemId);
      return repaired;
    }

    // Snapshot every listing before touching the form. Adding a product must
    // produce a NEW item id and must leave every other listing's name intact;
    // anything else is an edit of somebody else's listing, never an upload.
    const namesBefore = await this._activeNamesById();
    const knownItemIds = new Set(namesBefore.keys());

    await this._openForm();
    await this._fillBasics(product);
    await this._uploadPhotos(product);
    await this._uploadPdf();

    if (dryRun) {
      log.warn('  dry-run: not clicking Finish');
      return { ok: false, before, after: before, dryRun: true };
    }

    let finishError = null;
    try {
      await this._finish(product);
    } catch (error) {
      finishError = error;
      log.warn(`  initial finish was interrupted; checking for a partial exact item: ${error.message}`);
    }

    // IndiaMART can publish the basic item at Save and Continue before a later
    // specification/overlay failure. Always reconcile the exact resulting item
    // in place so a retry cannot create a duplicate and partial media/specs are
    // completed before reporting success.
    await this.gotoManage();
    const live = await this._findActiveProduct(product);
    if (live) {
      // Matching purely by name is self-fulfilling: if the form had renamed an
      // existing listing, that listing now carries this product's name and
      // would "verify" against the very value we just wrote. Require a new id.
      if (knownItemIds.has(live.itemId)) {
        throw new Error(
          `IndiaMART item ${live.itemId} already existed before this upload but now carries ` +
            `"${uploadProductName(product)}" — an existing listing was modified instead of a new ` +
            `product being created. Check that item on Manage Products; nothing else was changed.`,
        );
      }
      const result = await this._completeExistingProduct(product, live, { before });
      await this._assertOnlyTouched(namesBefore, live.itemId);
      // Reached through Add Product on an item id that did not exist before, so
      // this is a newly created listing rather than a reconciled one.
      return { ...result, repaired: false, created: true };
    }
    if (finishError) throw finishError;

    const shot = path.join(config.dataDir, `upload-fail-${product.id}.png`);
    await this.page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    throw new Error(
      `IndiaMART did not expose the new exact product after Finish. Screenshot: ${shot}`,
    );
  }
}
