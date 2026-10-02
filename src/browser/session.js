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
/**
 * A visible window whose page fills it, like an ordinary browser.
 *
 * Playwright sizes the page independently of the window, so a fixed 1440x900
 * viewport inside a larger window renders the portal into part of the frame and
 * cuts the rest off — controls that are plainly on screen in a normal browser
 * are simply not there. `viewport: null` hands sizing back to the window, and
 * the window is maximised.
 *
 * This is not only about seeing it. A bigger page means more of Manage Products
 * and more of the specification form are in view at once, so there is less
 * scrolling into view before every click.
 */
export async function openContext({
  headful = config.indiamart.headful,
  // One Chromium profile can only be driven by one process at a time — a second
  // launch answers "Opening in existing browser session" and fails. Category
  // lanes therefore each get their own profile directory, cloned from the
  // logged-in one, so five windows can work at once.
  sessionDir = config.indiamart.sessionDir,
} = {}) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(sessionDir, {
    headless: !headful,
    // Headless has no window to follow, so it keeps an explicit large page.
    viewport: headful ? null : { width: 1920, height: 1080 },
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(headful ? ['--start-maximized'] : ['--window-size=1920,1080']),
    ],
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
 * Open the app's own browser and hand it to you.
 *
 * Same persistent profile every other stage drives, so whatever you do here —
 * fixing a listing by hand, clearing a portal popup, checking what a page
 * actually shows — is what the uploader will see next. Only one process can
 * hold that profile, which is why this runs as a job: nothing else may drive
 * the browser while you have it.
 *
 * It stays open until you close the window, then records whether the session is
 * still signed in, so the toolbar cannot go on claiming the old state.
 */
export async function openBrowser({ timeoutMinutes = 60 } = {}) {
  const { ctx, page } = await openContext({ headful: true });
  await page.goto(config.indiamart.sellerUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.bringToFront().catch(() => {});
  log.step('Browser is yours — close the window when you are done to give it back.');

  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    if (!ctx.pages().length) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (ctx.pages().length) {
    log.warn(`  closing the browser after ${timeoutMinutes} minutes so the app is usable again`);
  }

  const signedIn = await confirmLoggedInSilently(ctx).catch(() => false);
  markLoggedIn(signedIn);
  await ctx.close().catch(() => {});
  log.ok(`Browser closed — IndiaMART session is ${signedIn ? 'signed in' : 'signed out'}.`);
  return { signedIn };
}

/**
 * Sign out of IndiaMART.
 *
 * The session is whatever cookies the persistent Chromium profile holds, so
 * signing out means clearing those — not just flipping the status flag, which
 * would leave the account signed in while the app claimed otherwise. The result
 * is read back the same way login() checks itself, so "signed out" is something
 * observed rather than assumed.
 */
export async function logout() {
  const { ctx } = await openContext({ headful: false });
  try {
    await ctx.clearCookies();
    const stillIn = await confirmLoggedInSilently(ctx);
    if (stillIn) {
      throw new Error('IndiaMART still answers as signed in after clearing the session cookies');
    }
    markLoggedIn(false);
    log.ok('Signed out of IndiaMART — the next upload will ask for a fresh login.');
    return true;
  } finally {
    await ctx.close().catch(() => {});
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
