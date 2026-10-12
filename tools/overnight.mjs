/**
 * Unattended driver for the category lanes.
 *
 * Runs the lanes in waves of three browsers (three is the measured sweet spot —
 * see the README), and keeps going through IndiaMART's per-IP rate limit
 * instead of stopping at the first 429:
 *
 *   probe a product page -> run the wave -> if the run was rate limited, stay
 *   quiet for a while (requests made while blocked lengthen the block), probe
 *   again, and run the same wave once more. Products already read are not read
 *   again, so every pass only spends the page budget on what is still missing.
 *
 * Nothing here talks to IndiaMART except the one probe request and the app's
 * own lane run through the dashboard server.
 *
 *   node tools/overnight.mjs
 *
 * Progress is written to data/overnight/ (overnight.log, events.log,
 * status.json) so the result can be read afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const BASE = 'http://localhost:5199';
const ROOT = process.cwd();
const OUT = path.join(ROOT, 'data', 'overnight');
fs.mkdirSync(OUT, { recursive: true });
const logStream = fs.createWriteStream(path.join(OUT, 'overnight.log'), { flags: 'a' });
const eventStream = fs.createWriteStream(path.join(OUT, 'events.log'), { flags: 'a' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function say(message) {
  const line = `[${new Date().toLocaleString('en-IN', { hour12: false })}] ${message}`;
  console.log(line);
  logStream.write(`${line}\n`);
}

// ---------------------------------------------------------------- the lanes
const titleCase = (slug) =>
  slug
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');

const SELLER = 'https://www.indiamart.com/ishaan-medis/';
// Group names the user chose for the first five; every later category's group is
// its URL's last segment, as the user specified.
const FIXED = {
  'ed-medicine': 'ED Medicine',
  'anti-cancer-medicines': 'Anti Cancer Medicine',
  'sunscreen-lotion-and-skin-cream': 'Sunscreen Lotion and Skin Cream',
  'anti-depresants-de-addiction': 'Anti Depressants De Addiction',
  'steroid-injection': 'Steroid Injection',
};
const ORDER = [
  // leftovers from the first rounds
  'sunscreen-lotion-and-skin-cream',
  'anti-depresants-de-addiction',
  'steroid-injection',
  'ed-medicine',
  'anti-cancer-medicines',
  // the user's list for the night
  'antibiotics-anti-bacterials',
  'womens-health',
  'anti-hiv-medicines',
  'pain-killer-tab',
  'antbiotics-antifungals-antiviral-medicines',
  'blood-pressure-cardiac',
  'pharmaceutical-injection',
  'covid-care-medicine',
  'cialis-tadalfil',
  'viagra-sildenafil',
  'antidiabetic-medicines',
  'veterinary-medicines',
  'pharmaceutical-tablets',
  'anticancer-injections',
  'pharmaceutical-capsules',
  'steroids-tablets',
  'hair-care',
];
const LANES = ORDER.map((id) => ({
  id,
  url: `${SELLER}${id}.html`,
  group: FIXED[id] || titleCase(id),
  enabled: false,
}));
const WAVE_SIZE = Number(process.env.WAVE_SIZE || 3);
const FROM = Number(process.argv[2] || 1); // first wave to run, to resume part-way
const QUIET0 = Number(process.argv[3] || 0); // minutes to stay silent before the first request
const WAVES = [];
for (let i = 0; i < ORDER.length; i += WAVE_SIZE) WAVES.push(ORDER.slice(i, i + WAVE_SIZE));

// ------------------------------------------------------------------- server
async function api(route, options = {}) {
  const response = await fetch(BASE + route, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(options.timeout || 20000),
  });
  return response.json();
}

async function serverUp() {
  try {
    const status = await api('/api/status', { timeout: 8000 });
    return status.ok === true ? status : null;
  } catch {
    return null;
  }
}

async function ensureServer() {
  if (await serverUp()) return;
  say('server is down — starting it');
  const out = fs.openSync(path.join(OUT, 'server.log'), 'a');
  spawn(process.execPath, ['src/server.js'], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] }).unref();
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    if (await serverUp()) return;
  }
  throw new Error('server did not start');
}

function killServer() {
  try {
    const lines = execSync('netstat -ano', { encoding: 'utf8' }).split('\n');
    const pids = new Set(
      lines
        .filter((line) => /:5199\s+.*LISTENING/.test(line))
        .map((line) => line.trim().split(/\s+/).pop()),
    );
    for (const pid of pids) execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

// ------------------------------------------------------------ the event feed
const feed = { rateLimited: false, created: 0, groupSet: 0, groupFailed: 0, lastAt: Date.now() };
function handle(chunk) {
  const data = chunk.split('\n').find((line) => line.startsWith('data: '));
  if (!data) return;
  let payload;
  try {
    payload = JSON.parse(data.slice(6));
  } catch {
    return;
  }
  feed.lastAt = Date.now();
  const text = payload.text;
  if (!text) return;
  eventStream.write(`${payload.time || ''} ${payload.level || ''} ${text}\n`);
  if (/rate limiting this connection/.test(text)) feed.rateLimited = true;
  if (/created ✓|reconciled ✓/.test(text)) feed.created += 1;
  if (/group set /.test(text)) feed.groupSet += 1;
  if (/group not set/.test(text)) feed.groupFailed += 1;
}
async function listen() {
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/events`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          handle(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
        }
      }
    } catch {
      /* server restarting */
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(3000);
  }
}

// -------------------------------------------------------------- the products
function readProducts() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'products.json'), 'utf8'));
    } catch {
      /* caught mid-write */
    }
  }
  return [];
}
const hasSource = (p) => Object.keys(p.specs || {}).length > 0 && String(p.description || '').trim().length > 0;

function waveState(ids) {
  const mine = readProducts().filter((p) => ids.includes(p.lane));
  const done = mine.filter((p) => p.status?.uploaded === 'done');
  const open = mine.filter((p) => p.status?.uploaded !== 'done');
  return {
    total: mine.length,
    done: done.length,
    unread: open.filter((p) => !hasSource(p)).length,
    open: open.filter((p) => hasSource(p)).length,
  };
}

function writeStatus(extra = {}) {
  const products = readProducts();
  const perLane = {};
  for (const lane of ORDER) {
    const mine = products.filter((p) => p.lane === lane);
    perLane[lane] = {
      group: LANES.find((l) => l.id === lane).group,
      stored: mine.length,
      live: mine.filter((p) => p.status?.uploaded === 'done').length,
      unread: mine.filter((p) => p.status?.uploaded !== 'done' && !hasSource(p)).length,
      failed: mine.filter((p) => p.status?.uploaded === 'error' && hasSource(p)).length,
    };
  }
  fs.writeFileSync(
    path.join(OUT, 'status.json'),
    JSON.stringify({ at: new Date().toISOString(), feed, perLane, ...extra }, null, 2),
  );
}

// ---------------------------------------------------------------- rate limit
async function probe() {
  const sample = readProducts().find((p) => /proddetail/.test(p.sourceUrl || ''));
  const url = sample?.sourceUrl || 'https://www.indiamart.com/proddetail/fluvoxamine-maleate-tablets-25851589433.html';
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
      signal: AbortSignal.timeout(25000),
    });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch {
    return 0;
  }
}

async function waitUnblocked() {
  for (;;) {
    const status = await probe();
    if (status === 200) return;
    say(`product pages answer ${status || 'no response'} — still blocked, waiting 20 min`);
    // Each probe is itself a request, and requests made while blocked lengthen it.
    // eslint-disable-next-line no-await-in-loop
    await sleep(20 * 60 * 1000);
  }
}

// ----------------------------------------------------------------- one pass
async function setLanes(ids) {
  const lanes = LANES.map((lane) => ({ ...lane, enabled: ids.includes(lane.id) }));
  const answer = await api('/api/lanes', { method: 'PUT', body: JSON.stringify({ lanes }) });
  if (!answer.ok) throw new Error(`could not save lanes: ${answer.error}`);
}

async function runOnce(ids, { uploadOnly = false } = {}) {
  await ensureServer();
  await setLanes(ids);
  feed.rateLimited = false;
  feed.lastAt = Date.now();
  const started = await api('/api/lanes/run', {
    method: 'POST',
    body: JSON.stringify({ maxUploading: WAVE_SIZE, uploadOnly }),
  });
  if (!started.ok) throw new Error(`could not start the lanes: ${started.error}`);
  const begun = Date.now();
  for (;;) {
    await sleep(20000);
    const status = await serverUp();
    if (!status) {
      say('server stopped answering during the run — restarting it');
      killServer();
      await sleep(3000);
      await ensureServer();
      return { crashed: true };
    }
    if (!status.job) return { crashed: false };
    const silent = Date.now() - feed.lastAt;
    if (silent > 30 * 60 * 1000 || Date.now() - begun > 5 * 3600 * 1000) {
      say(`run looks stuck (silent ${Math.round(silent / 60000)} min) — stopping it`);
      await api('/api/lanes/stop', { method: 'POST' }).catch(() => {});
      await sleep(5 * 60 * 1000);
      killServer();
      await sleep(3000);
      await ensureServer();
      return { crashed: true };
    }
  }
}

// -------------------------------------------------------------------- main
async function main() {
  say(`overnight run: ${ORDER.length} categories in ${WAVES.length} waves of ${WAVE_SIZE}`);
  listen();
  await ensureServer();
  if (QUIET0) {
    say(`staying quiet for ${QUIET0} min before the first request`);
    await sleep(QUIET0 * 60 * 1000);
  }

  if (process.env.UPLOAD_ONLY) {
    // Publish what is already read, one pass per wave, without touching a
    // single product page.
    say('UPLOAD ONLY: publishing products that are read but not live');
    for (const wave of WAVES) {
      if (!waveState(wave).open) continue;
      say(`  ${wave.join(', ')}`);
      // eslint-disable-next-line no-await-in-loop
      await runOnce(wave, { uploadOnly: true });
      const state = waveState(wave);
      say(`  -> ${state.done}/${state.total} live, ${state.open} read but not live`);
      writeStatus({ uploadOnly: true });
    }
    fs.writeFileSync(path.join(OUT, 'FINISHED'), new Date().toISOString());
    process.exit(0);
  }

  for (const [index, wave] of WAVES.entries()) {
    if (index + 1 < FROM) continue;
    say(`WAVE ${index + 1}/${WAVES.length}: ${wave.join(', ')}`);
    let stalls = 0;
    let previous = null;
    for (let cycle = 1; cycle <= 16; cycle += 1) {
      // eslint-disable-next-line no-await-in-loop
      await waitUnblocked();
      say(`  pass ${cycle}`);
      let result;
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await runOnce(wave);
      } catch (error) {
        say(`  pass failed to run: ${error.message}`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(5 * 60 * 1000);
        stalls += 1;
        if (stalls >= 4) break;
        continue;
      }
      const state = waveState(wave);
      writeStatus({ wave: index + 1, cycle });
      say(
        `  pass ${cycle} ended${feed.rateLimited ? ' (rate limited)' : ''}: ` +
          `${state.done}/${state.total} live, ${state.unread} not read yet, ${state.open} read but not live` +
          `${result.crashed ? ' [server had to be restarted]' : ''}`,
      );
      const finished = !feed.rateLimited && state.unread === 0 && state.open === 0;
      if (finished) break;
      const progressed =
        !previous || state.done > previous.done || state.unread < previous.unread || state.total > previous.total;
      stalls = progressed ? 0 : stalls + 1;
      previous = state;
      if (!feed.rateLimited && !progressed && stalls < 3 && (state.open || state.unread)) {
        // The portal's own throttle (PDF step timing out, "Retry After Sometime")
        // clears with time, and an immediate retry only runs into it again.
        say('  portal is throttling uploads — waiting 30 min before trying again');
        // eslint-disable-next-line no-await-in-loop
        await sleep(30 * 60 * 1000);
      }
      if (!feed.rateLimited && stalls >= 3) {
        say('  no progress without a rate limit — moving on');
        break;
      }
      if (stalls >= 4) {
        say('  no progress for 4 passes — moving on');
        break;
      }
      if (feed.rateLimited) {
        say('  rate limited — staying quiet for 40 min');
        // eslint-disable-next-line no-await-in-loop
        await sleep(40 * 60 * 1000);
      }
    }
  }

  // Upload-only sweep: retries whatever was read but not published, without
  // touching a single product page.
  say('SWEEP: upload what is read but not live (no page reads)');
  for (const wave of WAVES) {
    const state = waveState(wave);
    if (!state.open) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await runOnce(wave, { uploadOnly: true });
    } catch (error) {
      say(`  sweep failed for ${wave.join(', ')}: ${error.message}`);
    }
  }

  writeStatus({ finished: true });
  const products = readProducts();
  say(
    `DONE: ${products.filter((p) => p.status?.uploaded === 'done').length} live of ${products.length} stored; ` +
      `${feed.groupFailed} group assignment(s) were refused by the portal`,
  );
  fs.writeFileSync(path.join(OUT, 'FINISHED'), new Date().toISOString());
  process.exit(0);
}

main().catch((error) => {
  say(`FATAL: ${error.stack || error.message}`);
  process.exit(1);
});
