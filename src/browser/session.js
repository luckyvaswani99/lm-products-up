import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * IndiaMART has no product API and uses OTP login, so we drive the seller
 * portal in a *persistent* Chromium profile. You log in by hand once
 * (`npm run login`); the cookies live in INDIAMART_SESSION_DIR and every later
 * run reuses them — no password is ever handled by this tool.
 */
export async function openContext({ headful = config.indiamart.headful } = {}) {
  fs.mkdirSync(config.indiamart.sessionDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(config.indiamart.sessionDir, {
    headless: !headful,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

// --- honest "are we logged in" marker, so the UI doesn't lie ---
const STATUS_FILE = path.join(config.dataDir, 'session-status.json');
export function markLoggedIn(value) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ loggedIn: !!value, at: new Date().toISOString() }));
  } catch {
    /* ignore */
  }
}
export function isMarkedLoggedIn() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')).loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Classify the CURRENTLY loaded page WITHOUT navigating (so we never interrupt
 * an OTP the user is typing). Returns 'in' | 'out' | 'unknown'.
 * Signatures verified against the real seller portal:
 *   logged-out landing page contains "Sign In" (and NOT "Manage Products",
 *   "Dashboard", "My Products", "Log Out"); the logged-in portal is the inverse.
 */
export async function pageLoginState(page) {
  if (!page || page.isClosed?.()) return 'unknown';
  const body = (await page.textContent('body').catch(() => '')) || '';
  const hasSignIn = /\bSign\s*In\b/i.test(body);
  const dashMarker = /Manage Products|My Products|Dashboard|Sign\s?Out|Log\s?Out/i.test(body);
  if (dashMarker && !hasSignIn) return 'in';
  if (hasSignIn) return 'out';
  return 'unknown';
}

/**
 * Definitive check: navigate to the protected Manage Products URL. When logged
 * OUT, IndiaMART bounces to the landing page with a "#succ_url=..." hash; when
 * logged IN it stays on /product/manageproducts. (Verified against the real
 * portal — far more reliable than scraping page text.)
 */
export async function confirmLoggedIn(page) {
  await page.goto(config.indiamart.sellerUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2200);
  const url = page.url();
  return /\/product\/manageproducts/i.test(url) && !/succ_url|login|signin/i.test(url);
}

/** Navigate to the seller portal and report whether we're logged in. */
export async function isLoggedIn(page) {
  const inn = await confirmLoggedIn(page);
  markLoggedIn(inn);
  return inn;
}

/**
 * Same definitive check as confirmLoggedIn, but done as a background HTTP
 * request (sharing the context's cookies) instead of navigating a page. This
 * is what lets login() poll for the OTP result without opening a second
 * visible window or touching the tab the user is typing into.
 */
async function confirmLoggedInSilently(ctx) {
  try {
    const resp = await ctx.request.get(config.indiamart.sellerUrl, { maxRedirects: 10 });
    const url = resp.url();
    return /\/product\/manageproducts/i.test(url) && !/succ_url|login|signin/i.test(url);
  } catch {
    return false;
  }
}

/**
 * Interactive login. Opens the portal ONCE and then polls in the background
 * (no extra tab/window, no reload) so you can enter your mobile number + OTP
 * undisturbed.
 */
export async function login() {
  const { ctx, page } = await openContext({ headful: true });
  log.step('A browser window opened. Sign in with your mobile number + OTP.');
  log.info('The login tab will NOT refresh while you type; it closes itself once login is detected.');
  await page.goto('https://seller.indiamart.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.bringToFront().catch(() => {});

  const deadline = Date.now() + 10 * 60 * 1000; // 10 minutes
  let lastPing = 0;
  let loggedIn = false;

  while (Date.now() < deadline) {
    if (!ctx.pages().length) {
      log.warn('Login window was closed before login completed.');
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const inn = await confirmLoggedInSilently(ctx);
    if (inn) {
      loggedIn = true;
      break;
    }
    if (Date.now() - lastPing > 15000) {
      log.info('…waiting for you to finish signing in');
      lastPing = Date.now();
    }
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(4000);
  }

  markLoggedIn(loggedIn);
  if (loggedIn) {
    log.ok('Login detected — session saved to ' + config.indiamart.sessionDir);
    await page.waitForTimeout(1200);
  } else {
    log.error('Login not completed (timed out or window closed).');
  }
  await ctx.close().catch(() => {});
  return loggedIn;
}
