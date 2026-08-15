# india-mart-products-up

Automated pipeline that pulls products from IndiaMART, **regenerates a faithful
copy of each product image with AI**, writes **SEO-optimized listing copy with
DeepSeek**, and **auto-uploads** everything to your own IndiaMART seller portal.

```
 scrape  ──►  download image  ──►  AI image (same copy)  ──►  DeepSeek SEO  ──►  upload
(Playwright)     (real photo)        (Gemini/OpenAI/Replicate)   (text)        (Playwright)
```

> **Why Playwright for upload?** IndiaMART has **no public API** to add products
> and uses OTP login. So the uploader drives the real seller portal in a saved
> browser profile — you log in by hand once, and the tool reuses that session.
> This tool never sees or types your password.

---

## 1. Setup

```bash
cd india-mart-products-up
npm install          # also downloads the Chromium browser for Playwright
cp .env.example .env # then edit .env and fill in your keys
```

Fill in `.env`:

| Key | What it's for |
|-----|----------------|
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | SEO text (model id, e.g. `deepseek-chat`) |
| `IMAGE_PROVIDER` + provider key | AI image copy: `gemini` / `openai` / `replicate` |
| `SUPPLIER_NAME` / `SUPPLIER_CITY` | injected into the generated copy |
| `SCRAPE_URLS` | IndiaMART pages to pull products from |

## Web dashboard (recommended)

Prefer clicking over the CLI? Launch the UI:

```bash
npm run web        # opens http://localhost:5199
```

From the dashboard you can:

- **Log in** to IndiaMART (OTP, once).
- **Import** a JSON, **Scrape list** from a listing/search URL, or **＋ Extract
  product** from a single product URL (captures the full spec set IndiaMART needs).
- Run **Images / SEO / Upload** (or **Run all**); **⏭ Skip live** marks
  products already in your account.
- **Select products** (card checkbox or "select all") and **🗑 Delete selected**
  in bulk (removes from the app only — never touches IndiaMART).
- Watch the **live log**, and open any product to compare **original vs AI image**,
  hand-edit the SEO + specs, re-run a stage, or **upload that one product**.

Config chips at the top show which API keys / session are set.
(Change the port with `PORT=6000 npm run web`.)

All the same actions are available on the CLI below.

## 2. Log in to IndiaMART (once)

```bash
npm run login
```

A browser opens — sign in with your mobile + OTP. The session is stored in
`.session/` and reused by every later `upload` run.

## 3. Run the pipeline

```bash
# a) scrape products from an IndiaMART search / seller / category page
npm run scrape -- --url "https://dir.indiamart.com/search.mp?ss=tadalafil+tablets"

# b) download real images + regenerate faithful AI copies
npm run images

# c) generate SEO copy with DeepSeek
npm run seo

# d) upload everything to your portal  (add `-- --dry-run` to fill without saving)
npm run upload

# …or do it all at once:
npm run run
```

Check progress any time:

```bash
npm run list
```

### Already have a product JSON? Import it and skip scraping

```bash
node src/cli.js import "C:/path/to/sterling_products_complete.json"
npm run images && npm run seo && npm run upload
```

The importer understands both the raw scrape format and the "prepared" format
(`price_value`/`price_unit`/`primary_image`/`compound`).

---

## Project layout

```
src/
  cli.js                     command-line entry
  config.js                  reads .env
  store.js                   JSON store + pipeline-stage tracking (data/products.json)
  pipeline.js                orchestrates the stages
  scraper/indiamartScraper   Playwright scraper (name/price/unit/desc/specs/images)
  images/downloader          downloads the original photos
  images/aiImage             faithful AI copy (gemini | openai | replicate adapters)
  ai/seoContent              DeepSeek SEO copywriter (JSON out)
  browser/session            persistent-profile login (OTP by hand, once)
  uploader/indiamartUploader Add-Product automation (name→specs→Finish)
  uploader/specFiller        fills IndiaMART's category-specific mandatory specs
data/                        products.json, images/, ai-images/  (git-ignored)
```

## Notes & caveats

- **Selectors drift.** IndiaMART changes its markup; if scraping or upload misses
  a field, the selectors in `scraper/indiamartScraper.js` and
  `uploader/indiamartUploader.js` are the places to tune. Failed uploads drop a
  screenshot in `data/upload-fail-*.png`.
- **Specs are inferred** from the product name (strength, brand, packaging). Review
  `specFiller.js` to adjust defaults per category.
- **Pharma images / content.** AI copies the *real* product photo and the copy
  avoids medical claims, but you are responsible for the accuracy and compliance
  of what goes live, and for your right to re-list scraped products.
