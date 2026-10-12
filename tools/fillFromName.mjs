/**
 * Fill Strength / Form / Composition from the product NAME on listings that are
 * already live (the ledger in data/uploaded-ledger.json), 3 browsers at a time.
 *
 * Only rows the listing's own card still lists as missing are touched, and only
 * with what the name states (see fillMissingFromName). Resumable: finished item
 * ids are kept in data/overnight/topup-done.json.
 *
 *   node tools/fillFromName.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { Uploader } from '../src/uploader/indiamartUploader.js';

const root = process.cwd();
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data', 'uploaded-ledger.json'), 'utf8'));
const donePath = path.join(root, 'data', 'overnight', 'topup-done.json');
const done = fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, 'utf8')) : {};
const save = () => fs.writeFileSync(donePath, JSON.stringify(done, null, 1));

// Listings IndiaMART removed are not on the account to edit.
const todo = ledger.filter((e) => e.itemId && e.lane !== 'anti-cancer-medicines' && !done[e.itemId]);
console.log(`${todo.length} listing(s) to check (${Object.keys(done).length} already done)`);

const PROFILES = ['ed-medicine', 'anti-depresants-de-addiction', 'sunscreen-lotion-and-skin-cream'];
let next = 0;
const tally = { filled: 0, nothing: 0, failed: 0 };

async function worker(profile) {
  const up = new Uploader({ sessionDir: path.resolve('.session-lanes', profile), label: `topup-${profile}` });
  await up.open();
  try {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= todo.length) return;
      const entry = todo[index];
      try {
        const result = await up.topUpFromName({ id: entry.itemId, name: entry.name });
        done[entry.itemId] = result.skipped ? 'nothing' : (result.filled || []).join('; ') || 'none-matched';
        if (result.skipped || !(result.filled || []).length) tally.nothing += 1;
        else tally.filled += 1;
        console.log(`[${index + 1}/${todo.length}] ${entry.name.slice(0, 40)} — ${done[entry.itemId]}`);
      } catch (error) {
        tally.failed += 1;
        done[entry.itemId] = `error: ${error.message.split('\n')[0].slice(0, 120)}`;
        console.log(`[${index + 1}/${todo.length}] ${entry.name.slice(0, 40)} ✗ ${done[entry.itemId]}`);
      }
      save();
    }
  } finally {
    await up.close?.().catch(() => {});
  }
}

await Promise.all(PROFILES.map((profile) => worker(profile)));
console.log('FINISHED', JSON.stringify(tally));
fs.writeFileSync(path.join(root, 'data', 'overnight', 'TOPUP_FINISHED'), new Date().toISOString());
process.exit(0);
