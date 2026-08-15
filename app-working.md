# Application Working Baseline and Recovery Guide

Last verified baseline: 30 July 2026

This document is the recovery reference for the currently working IndiaMART product workflow. Preserve the invariants below before changing selectors, product data rules, media ordering, duplicate handling, or finish behavior. Product facts must come from the current scraped/imported source record; do not invent or default missing commercial or specification values.

## 1. Golden workflow

1. `POST /api/scrape-single` or `POST /api/scrape` reads the current source page.
2. `Store.upsert(..., { refresh: true })` refreshes raw source fields. A changed source gallery invalidates only downloaded/AI images.
3. `runImages` downloads every real source photo. Each side is prepared to at least 500 px because IndiaMART rejects smaller images. Optional AI regeneration can replace only the leading photo; the remaining real gallery is retained.
4. `runSeo` generates copy, but source identity and commercial facts remain authoritative. `sourceSpecsOnly()` forces SEO specs back to the exact non-empty source spec object.
5. `runUpload` opens one persistent Playwright browser, audits existing products, and uploads sequentially.
6. Exact Active matches are reconciled in place. Exact Inactive/Deactivated matches are skipped. A retry must never blindly create another product.
7. A new product is filled in this order: basics and TinyMCE description, complete photo batch, shared PDF and its preview/crop confirmations, Save and Continue, source-only specifications/details, Finish.
8. After an interrupted Finish, the uploader returns to Manage Products and repairs an exact partial listing instead of pressing Add Product again.
9. Success is recorded only after the exact live item is reopened and core identity, description, media count, PDF, and relevant persisted values are confirmed.

## 2. Data authority and product contract

`data/products.json` is the JSON store. A product contains raw `name`, `price`, `unit`, `description`, `specs`, `imageUrls`, `sourceUrl`, and `sourceId`; derived `localImages`, `aiImages`, and `seo`; and `status` values for `scraped`, `images`, `seo`, and `uploaded`.

Rules that must not regress:

- `product.specs` is authoritative when non-empty. SEO specs are only a fallback for old records.
- Submit only non-empty values present in the source record. Do not infer Country of Origin, Type, MOQ, Delivery Time, form, packaging, manufacturer, or buyer suitability.
- Portal aliases such as Strength/Dose, Brand/Brand Name, Form/Dosage Form, and Composition/Active Ingredient locate a field; they never authorize changing its value.
- Radio and checkbox controls are both supported.
- If an exact source value is not an offered option and the portal provides `Other`, select `Other` and enter the exact source value. Never choose an approximate option.
- Missing source MOQ and Delivery Time clear stale values. Other missing optional business details are not filled.
- Hand-edited Specs JSON is explicit user data: `updateSeo()` copies it to both authoritative `product.specs` and `product.seo.specs`.
- Title upload removes the configured supplier suffix, normalizes unsupported characters, and obeys IndiaMART's 100-character input limit.
- Description output is prepared and length-checked before TinyMCE submission. Re-upload Description and Re-upload Specs target one exact existing item and do not add a product or re-upload media.

## 3. Media contract

- `productImageFiles()` prefers available AI leading images, then appends the untouched real source gallery tail. With no AI image, it uses all local source images. Duplicate paths are removed without reordering.
- The first selected file is the intended primary image.
- All source and AI files are persistent inputs. Upload preparation must use temporary copies and must never overwrite them.
- IndiaMART requires each image side to be at least 500 px. Smaller images are centered on a white minimum-size canvas while preserving aspect ratio.
- Multi-photo selection must report IndiaMART's expected remaining capacity (`13 - selected count`) in the current crop dialog before confirmation.
- Missing-photo repair compares current live photo count with desired files and adds only the missing tail through `N More → Upload photos from computer → Upload Photos`. It never replaces the current primary.
- The selected shared brochure is managed under `data/pdf`. Upload is blocked when no PDF is selected. Both IndiaMART document-upload and PDF-conversion responses must succeed, then rendered preview and crop dialogs must be explicitly confirmed.

### General upload watermark extension

The dashboard watermark feature is separate from the old, seller-authorized source-mark replacement in `downloader.js`.

- General watermark settings live under `data/watermark` and are disabled by default.
- Text and image/logo modes are supported.
- A watermark is rendered only onto temporary upload files after minimum-size preparation. Original downloads and AI images remain unchanged.
- `Apply to primary only` means global gallery index zero, including during missing-photo repair. `Apply to all` covers every desired upload photo.
- Image mode cannot be enabled without a validated PNG, JPEG, or WebP logo. Clearing an active image logo disables watermarking rather than allowing broken uploads.
- Disabled mode must return the same original paths and preserve the pre-watermark upload behavior.
- A settings change affects future media uploads only. It does not modify photos already live on IndiaMART and does not run during description-only/specification-only repair.
- When enabled, dashboard cards show the exact upload-preview primary image with a `WM` badge. Product details keep the persistent Original gallery separate and add an Upload preview gallery rendered from the same ordered files/settings used by the uploader.
- Preview files are settings/source-keyed temporary cache artifacts under `data/watermark/preview-cache`; changing settings or the logo invalidates this cache.
- When the authorized-source cleanup and general watermark are both enabled, safely cleared source patches remain blank instead of baking the old text label underneath the selected general watermark.
- If an existing source mark crosses the verified safe cleanup boundary, preserve those source pixels. Use the upload preview to choose an unoccupied watermark position; never erase product/source pixels just to force a replacement.

## 4. Live IndiaMART behavior observed and encoded

- Seller URL: `https://seller.indiamart.com/product/manageproducts/`.
- A protected Manage Products navigation is the definitive session check. OTP login is manual; `.session` stores the persistent Chromium profile.
- Manage Products initially renders only five Active cards even when the Active count is larger. `_loadAllProductRows()` scrolls until the status count is reached or growth stops. Do not search only the first rendered batch.
- Existing item matching uses normalized exact names and verifies the card/item ID. Multiple exact Active matches are a safety error, not permission to pick one arbitrarily.
- Current product links use `a.MPSD_prdname`; the item ID is embedded in the link ID. Exact card lookup is required before clicking its hidden delegated Edit action.
- Add Product fields currently use `#nameOfProduct`, `#priceOfProduct`, and `#unitOfProduct`; legacy placeholder fallbacks are retained.
- Description currently uses TinyMCE `#item_desc_ifr` with a contenteditable-body fallback.
- Usage can be a checkbox. Specifications may use radio or checkbox inputs.
- Dedup overlays can appear after Save and Continue because a partial item may already be Active. The correct response is exact-item reconciliation, not another Add Product attempt.
- Active account count is account-wide and can change because another unrelated product was added. Product identity, exact-copy count, and item ID are stronger invariants than a hard-coded account total.

## 5. Verified recovery canary

The last fully verified repair canary was:

- Source URL: `https://www.indiamart.com/proddetail/150mg-nervigisic-pregabalin-tablet-2859581355512.html`
- Live name: `Nervigisic Pregabalin 150 mg Capsule`
- IndiaMART item ID: `330878712`
- Price/unit: `310` / `Box`
- Shared PDF: `shared-product-brochure.pdf`
- Source gallery: three photos; source photo 1 is primary
- Source specs: Strength `150 mg`; Form `Capsule`; Brand `Nervigisic`; Composition `Pregabalin`; Packaging Size `10x15 Capsules`; Prescription Type `Non Prescription`; Usage `Neuropathic Pain`; Packaging Type `Strip`; Shelf Life `36 months`
- Portal persistence used `Other → Nervigisic` for Brand and `Other → 10x15 Capsules` for Packaging Size.
- MOQ and Delivery Time were empty.
- Final verification found one exact live copy, score 90, exact normalized 2,321-character description, all three unique source-photo pixel matches, the PDF, all nine source specs, and local stages all `done` with no upload error.

Do not hard-code this canary's values for other products. It is a regression reference only.

## 6. Important files

- `src/pipeline.js`: stage orchestration, exact-existing classification, statuses.
- `src/store.js`: product schema and persistence.
- `src/scraper/indiamartScraper.js`: current source extraction.
- `src/images/downloader.js`: real gallery download, minimum dimensions, narrowly authorized source-mark handling.
- `src/images/aiImage.js`: optional AI primary regeneration.
- `src/ai/seoContent.js`: source-only specs and medical-copy constraints.
- `src/descriptions/productDescription.js`: description normalization and validation.
- `src/uploader/indiamartUploader.js`: live portal navigation, media/PDF upload, reconciliation, and verification.
- `src/uploader/specFiller.js`: exact source specification mapping and stale-value clearing.
- `src/watermark/settings.js`: persisted general watermark settings and logo validation.
- `src/images/uploadWatermark.js`: temporary upload-copy rendering.
- `src/server.js`, `public/index.html`, `public/app.js`, `public/style.css`: dashboard API and UI.

The README contains an old statement that specs are inferred from the product name. That statement is obsolete. The current source-only behavior documented here and implemented in `specFiller.js`/`seoContent.js` is authoritative.

## 7. Safety checklist before future changes

1. Back up `.env`, `data/products.json`, `data/pdf`, `data/watermark`, and `.session` before risky changes.
2. Never expose API keys, session files, source files, or user data to an unrequested third-party service.
3. Read the exact current live DOM before changing selectors. Do not guess a selector from an old IndiaMART page.
4. Preserve exact Active repair and Inactive/Deactivated skip behavior.
5. Preserve all-gallery ordering and missing-tail repair.
6. Keep new optional features disabled by default and outside the working path when disabled.
7. Validate with syntax checks first, then a local/read-only smoke test, then one explicitly selected product before a batch.
8. Do not treat a command exit code alone as upload success; reopen and compare the exact item.
9. This workspace currently has no Git metadata, so Git cannot restore a bad edit. Keep file-level backups if making high-risk manual changes.

## 8. Validation commands

Run from the workspace root on Windows:

```text
node --check src\uploader\indiamartUploader.js
node --check src\uploader\specFiller.js
node --check src\ai\seoContent.js
node --check src\pipeline.js
node --check src\server.js
node --check src\watermark\settings.js
node --check src\images\uploadWatermark.js
```

For the dashboard, start `npm run web` and use `http://localhost:5199`. Do not run a second server against the same saved browser profile while an upload is active.

## 9. Recovery sequence

If uploads regress:

1. Stop new batch uploads; do not click Add Product repeatedly.
2. Inspect the product's raw source record and stage errors in `data/products.json`.
3. Open Manage Products, load all cards to the status count, and identify exact names/item IDs across Active and Inactive/Deactivated states.
4. If an exact Active partial item exists, repair that item. If exact Inactive/Deactivated exists, skip creating a duplicate.
5. Compare source name, price/unit, description, source gallery count/order, PDF, and every source spec.
6. Reproduce the current portal interaction in a non-destructive or one-product run before changing code.
7. Restore invariants from this document; do not restore obsolete guessed defaults.
