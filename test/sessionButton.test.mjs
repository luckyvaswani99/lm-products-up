/**
 * The toolbar had a "Login" button and no way to sign out at all, so a signed-in
 * account could only be left by deleting the browser profile by hand.
 *
 * One control now carries the session: it must always offer the action that is
 * actually available, and must never invite a login while already signed in.
 * The real function is lifted out of public/app.js and run, so this fails if
 * that code changes rather than passing against a copy of it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { chromium } from 'playwright';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const renderSessionButton = source.match(/function renderSessionButton\([\s\S]*?\n}/)?.[0];

test('one button carries the session state', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  assert.ok(renderSessionButton, 'renderSessionButton must exist in public/app.js');

  /** Render the real toolbar button, then run the real function against it. */
  const render = async (signedIn) => {
    await page.setContent('<button class="btn" id="sessionBtn" data-act="login">🔐 Sign in</button>');
    // Built per call rather than injected as a script tag: each render needs a
    // fresh scope, and repeated top-level declarations in one document do not
    // give one.
    await page.evaluate(
      ([fnSource, isIn]) => {
        const $ = (s, r = document) => r.querySelector(s);
        // eslint-disable-next-line no-new-func
        new Function('$', `${fnSource}\nreturn renderSessionButton;`)($)(isIn);
      },
      [renderSessionButton, signedIn],
    );
    return page.locator('#sessionBtn').evaluate((el) => ({
      act: el.dataset.act,
      label: el.textContent.trim(),
      title: el.title,
    }));
  };

  await t.test('signed in, it offers sign out', async () => {
    const button = await render(true);
    assert.equal(button.act, 'logout');
    assert.match(button.label, /sign out/i);
    assert.doesNotMatch(button.label, /sign in/i);
  });

  await t.test('signed out, it offers sign in', async () => {
    const button = await render(false);
    assert.equal(button.act, 'login');
    assert.match(button.label, /sign in/i);
    assert.doesNotMatch(button.label, /sign out/i);
  });

  await t.test('it never sends the action that is already done', async () => {
    assert.notEqual((await render(true)).act, 'login');
    assert.notEqual((await render(false)).act, 'logout');
  });

  await t.test('the two states explain themselves differently', async () => {
    const [inTitle, outTitle] = [(await render(true)).title, (await render(false)).title];
    assert.notEqual(inTitle, outTitle);
    assert.ok(inTitle && outTitle, 'both states carry a tooltip');
  });
});

test('the sign-out action and its route exist', async (t) => {
  await t.test('the button’s action is wired to the logout endpoint', () => {
    assert.match(source, /logout:\s*\(\)\s*=>\s*api\('POST',\s*'\/api\/logout'\)/);
  });

  await t.test('signing out asks first, because the next upload needs an OTP', () => {
    assert.match(source, /act === 'logout' && !confirm\(/);
  });

  await t.test('the server exposes it', () => {
    const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    assert.match(server, /app\.post\('\/api\/logout'/);
    // Clearing the profile's cookies must not race a job driving that profile.
    assert.match(server, /runJob\('logout', \(\) => logout\(\)\)/);
  });
});

/**
 * Handing the browser over for manual work.
 *
 * It is the same persistent profile every stage drives, and only one process
 * can hold it — so this has to occupy the job slot like any other stage, and it
 * has to give the profile back. Verified live: the window opened on Manage
 * Products, closed itself at the cap, and recorded the session as still signed
 * in.
 */
test('the browser can be handed over and is always taken back', async (t) => {
  const session = fs.readFileSync(new URL('../src/browser/session.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const openBrowser = session.slice(session.indexOf('export async function openBrowser'));

  await t.test('it opens the app’s own profile, not a throwaway one', () => {
    assert.match(openBrowser, /openContext\(\{ headful: true \}\)/);
  });

  await t.test('it waits for the window to be closed', () => {
    assert.match(openBrowser, /if \(!ctx\.pages\(\)\.length\) break;/);
  });

  await t.test('it always closes the context, even after the cap', () => {
    assert.match(openBrowser, /timeoutMinutes = 60/);
    assert.match(openBrowser, /await ctx\.close\(\)/);
  });

  await t.test('it records the session state on the way out', () => {
    // Otherwise the Sign in / Sign out button keeps claiming the old state
    // after someone signs in or out by hand.
    const closing = openBrowser.slice(openBrowser.indexOf('const signedIn'));
    assert.match(closing, /confirmLoggedInSilently\(ctx\)/);
    assert.match(closing, /markLoggedIn\(signedIn\)/);
  });

  await t.test('it occupies the job slot, so nothing else drives the browser', () => {
    assert.match(server, /app\.post\('\/api\/open-browser'/);
    assert.match(server, /runJob\('browser', \(\) => openBrowser\(\)\)/);
  });

  await t.test('the toolbar offers it', () => {
    assert.match(html, /data-act="openbrowser"/);
  });
});
