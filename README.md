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

### Setting it up on another machine

```bash
git clone https://github.com/luckyvaswani99/lm-products-up.git
cd lm-products-up
npm install                 # also downloads Chromium for Playwright
cp .env.example .env        # then paste your keys in
npm run web                 # http://localhost:5199
```

Then, in order, the four things git deliberately does **not** carry — each is
either a secret or this machine's own state:

1. **`.env`** — your API keys. Copy them across by hand.
2. **The IndiaMART login.** `.session/` holds live cookies and is git-ignored,
   so sign in again on the new machine (dashboard **Sign in**, or
   `npm run login`) with your mobile + OTP. Do this *before* any lane run.
3. **The shared product brochure PDF.** It lives under `data/`, which is
   git-ignored, so select it again from the toolbar. Without it every upload
   fails with "No shared product PDF selected".
4. **Background removal**, if you want it — the venv is per machine. See the
   section below, and read the Python-version and Visual C++ notes there before
   installing: the failures they describe look nothing like their causes.

`data/products.json` is also not carried, so the new machine starts with an
empty product list. That is usually what you want; if you need the same
products, copy `data/` across yourself.

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
  parallel/gate              shared request budget, breaker, lock, claims
  parallel/runLanes          several category pages at once (see below)
  parallel/laneConfig        the lanes, on disk (data/lanes.json)
tools/
  verifyPublished.mjs        check published products against the real account
  checkFailed.mjs            is a "failed" product actually live? (run before a retry)
data/                        products.json, images/, ai-images/  (git-ignored)
```

## Category lanes: several categories at once

One lane per seller category page. Each lane extracts its own category, prepares
its own photos, and uploads from its **own browser window** with its own
product group. Configure them in the dashboard's **Category lanes** row — the
set is saved on the server, so a refresh cannot leave a run doing something
other than what the page shows.

- **🏷 Load my groups** reads the product groups your account actually has, so a
  lane's group is picked from them. Do not type one: a category page's name is
  not a group name — this seller has a pain-killer category and the account's
  group is "Painkillers Medicine".
- **⬇ Extract only** extracts and prepares photos without uploading.
- **⚡ Run lanes** does the whole thing.

`runLanes({ uploadOnly: true })` uploads what the lanes already extracted
without reading any category page again. Use it after a run that was cut short:
extraction is the half that runs into the rate limit, so re-reading those pages
to reach products already stored costs a block and gains nothing.

### How many lanes

**Three.** Measured on this account, same products, same machine:

| Lanes | Per product | Effective rate |
|-------|-------------|----------------|
| 1 | 42–52s | 80/hour |
| **3** | 55–86s | **164/hour** |
| 5 | 129–166s | 120/hour |

Five is *slower* than three. The portal is the bottleneck, not this tool: with
five sessions on one account every step stretches about threefold (PDF 8s→36s,
photos 5s→38s, opening Manage Products 2s→35s), which more than eats the extra
parallelism, and it produces more failures.

### What is shared, and why

The lanes overlap their local work but **not** their requests to IndiaMART,
because the rate limit is counted per IP. Measured: a single reader gets about
99 product pages before HTTP 429; five lanes with five private budgets got 88
between them and then shut the whole run out. So one `SharedPacer` spaces every
request from any lane, one `Breaker` holds *all* lanes off when any of them is
refused, one `Mutex` guards the store (it is a JSON file read and written whole
— unguarded, five lanes lose four lanes' progress to whoever saves last), and
`Claims` give each product one lane and each listing name one lane at a time.

A 429 on IndiaMART's analytics beacon is not a refusal of your work and is
ignored; only the endpoints that carry the work count.

### Lane browser profiles

Each lane gets its own Chromium profile under `.session-lanes/<lane>`, copied
from the signed-in `.session` the first time it runs — one profile driven by two
processes fails with "Opening in existing browser session". Both directories
hold live login cookies and are git-ignored. Sign in once (`npm run login` or
the dashboard's Sign in) *before* the first lane run; a lane whose profile is
not signed in fails before it touches anything.

## Checking a run against the account

A run's log says what the uploader believed. It is not evidence: a product can
publish and then report an error, because some failures happen *after* Finish.

```bash
node tools/verifyPublished.mjs      # every "published" product, searched on the account
node tools/checkFailed.mjs          # is a "failed" product actually live?
```

**Run `checkFailed` before retrying anything.** It found five products that were
live while reading as failed; retrying them blind would have created five
duplicate listings. Retry only with **Find duplicates: on** — then the uploader
finds the listing by name and completes it in place instead of creating a second
one.

## Optional: local background removal

Photos can have their background removed before upload (rembg CPU, u2netp). It
is off until you switch it on in the app, and the rest of the pipeline works
without it.

```bash
python -m venv .venv-background-removal
.venv-background-removal/Scripts/python.exe -m pip install -r requirements-background-removal.txt
```

(On macOS/Linux the interpreter is `.venv-background-removal/bin/python`.)

**Build the venv with Python 3.11, 3.12 or 3.13.** Verified on 3.11.15. On
Python 3.14 the packages install and then onnxruntime fails to load, with rembg
reporting only "No onnxruntime backend found" — the app now names the real
cause and the interpreter version. Check yours with:

```bash
.venv-background-removal/Scripts/python.exe -u src/backgroundRemoval/worker.py
```

`{"type": "ready", …}` means it works; a `"fatal"` line says what is wrong.

**On Windows it also needs a current Visual C++ runtime.** onnxruntime 1.28 is
built with the VS2022 toolchain; with the 2019 runtime still in place it
installs cleanly and then fails to load:

```
onnxruntime could not be loaded: ImportError: DLL load failed while importing
onnxruntime_pybind11_state: A dynamic link library (DLL) initialization routine failed.
```

Check the version — 14.4x or newer is fine, 14.2x is not:

```powershell
(Get-Item C:\Windows\System32\vcruntime140_1.dll).VersionInfo.FileVersion
```

```powershell
winget install --id Microsoft.VCRedist.2015+.x64
```

Restart afterwards. Do not try an older onnxruntime instead: rembg 2.0.77
requires numpy >= 2.3, and only recent onnxruntime builds work with it — and
those are all VS2022 builds.

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
