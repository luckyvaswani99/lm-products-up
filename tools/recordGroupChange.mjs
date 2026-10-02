/**
 * Watch a product group being changed by hand, and write down what the portal
 * actually did.
 *
 * Why this exists: the group menu on Manage Products accepts a click on an
 * existing group's chip and sends no request at all — verified four ways — so
 * there was nothing to copy. Rather than keep guessing at the portal, this
 * opens the app's own browser, records every request the seller portal makes
 * and every control that is clicked, and saves both to data/group-change.json.
 *
 *   node tools/recordGroupChange.mjs
 *
 * Do the change by hand in the window that opens, then close the window.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openContext } from '../src/browser/session.js';
import { config } from '../src/config.js';
import { log } from '../src/logger.js';

const NOISE = /analytics|googletagmanager|google-analytics|doubleclick|yandex|imlytics|collect\?|\.(png|jpe?g|gif|svg|css|woff2?|ico)(\?|$)/i;

const requests = [];
const clicks = [];

const { ctx, page } = await openContext({ headful: true });

page.on('response', async (response) => {
  const url = response.url();
  if (NOISE.test(url)) return;
  const request = response.request();
  if (request.method() !== 'POST') return;
  let body = '';
  try {
    body = (await response.text()).slice(0, 1500);
  } catch {
    body = '(unreadable)';
  }
  const entry = {
    at: new Date().toISOString(),
    status: response.status(),
    url,
    payload: (request.postData() || '').slice(0, 1500),
    response: body,
  };
  requests.push(entry);
  log.info(`  POST ${response.status()} ${url.replace(/^https:\/\/[^/]+/, '')}`);
});

// Record what was clicked, so the fix can target the same control rather than
// something that merely looks like it.
await page.exposeFunction('__recordClick', (entry) => {
  clicks.push({ at: new Date().toISOString(), ...entry });
  log.info(`  click ${entry.tag}${entry.cls ? `.${entry.cls.split(' ')[0]}` : ''} "${entry.text}"`);
});
await page.addInitScript(() => {
  document.addEventListener(
    'click',
    (event) => {
      const el = event.target;
      if (!el || !el.tagName) return;
      const trail = [];
      for (let node = el; node && trail.length < 4; node = node.parentElement) {
        trail.push(
          `${node.tagName}${node.id ? `#${node.id}` : ''}` +
            `${node.className ? `.${String(node.className).trim().split(/\s+/).join('.')}` : ''}`,
        );
      }
      window.__recordClick({
        tag: el.tagName,
        id: el.id || '',
        cls: String(el.className || ''),
        text: (el.textContent || '').trim().slice(0, 60),
        attrs: Object.fromEntries(
          [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value]),
        ),
        trail,
      });
    },
    true,
  );
});

await page.goto(config.indiamart.sellerUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.bringToFront().catch(() => {});

log.step('Browser is open. Change ONE product\'s group by hand, then close the window.');
log.info('  Everything the portal sends is being recorded.');

while (ctx.pages().length) {
  // eslint-disable-next-line no-await-in-loop
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

const out = path.join(config.dataDir, 'group-change.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({ requests, clicks }, null, 2)}\n`, 'utf8');
log.ok(`Recorded ${requests.length} portal request(s) and ${clicks.length} click(s) -> ${out}`);
await ctx.close().catch(() => {});
