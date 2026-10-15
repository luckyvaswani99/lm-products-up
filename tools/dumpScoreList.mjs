/**
 * Read-only: list the listings behind one of Manage Products' filters ("Low Score",
 * "No Specifications"), and for each one its description, what the card still says
 * is missing, and every specification row with the options the form offers and what
 * is already ticked. Nothing is changed on the account.
 *
 *   node tools/dumpScoreList.mjs "Low Score" data/lowscore-dump.json [profileDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Uploader } from '../src/uploader/indiamartUploader.js';

const [filter, outFile, profile = '.session-lanes/hair-care'] = process.argv.slice(2);
const up = new Uploader({ sessionDir: path.resolve(profile), label: 'dump' });
await up.open();
const out = [];
try {
  await up.gotoManage();
  await up.page.waitForTimeout(3000);
  await up.page.getByText(new RegExp(`^${filter} \\(\\d+\\)`)).first().click();
  await up.page.waitForTimeout(4000);
  let previous = -1;
  for (let i = 0; i < 40; i += 1) {
    const count = await up.page.locator('a.MPSD_prdname').count();
    if (count === previous) break;
    previous = count;
    await up.page.mouse.wheel(0, 6000);
    await up.page.waitForTimeout(1500);
  }
  const listed = await up.page.locator('a.MPSD_prdname').evaluateAll((anchors) =>
    anchors.map((a) => ({ itemId: (a.id.match(/\d+/) || [''])[0], name: a.innerText.trim() })),
  );
  console.log(`${filter}: ${listed.length} listing(s)`);
  for (const entry of listed) {
    try {
      await up.gotoManage();
      const live = await up._findActiveProduct({ id: 'x', name: entry.name });
      if (live.itemId !== entry.itemId) throw new Error(`name matched item ${live.itemId}, not ${entry.itemId}`);
      const cardText = ((await live.card.innerText()) || '').split(/\s*\n+\s*/).join(' | ');
      const missing = (cardText.split(/\d+ missing/i)[1] || '').split(/View All/i)[0].trim();
      await up._openExactEditor({ id: 'x', name: entry.name }, live);
      const description = ((await up._readDescriptionText().catch(() => '')) || '').split(/\s+/).join(' ').slice(0, 700);
      await up.page.getByText('Specification/Additional Details', { exact: true }).first().click({ timeout: 8000 });
      await up.page.waitForTimeout(2500);
      const rows = await up.page.evaluate(() => {
        const byLabel = new Map();
        document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((input) => {
          const label = ((input.closest('div')?.parentElement?.innerText || '').split(String.fromCharCode(10))[0] || '').trim();
          if (!label) return;
          if (!byLabel.has(label)) byLabel.set(label, { label, options: [], selected: [] });
          const row = byLabel.get(label);
          row.options.push(input.value);
          if (input.checked) row.selected.push(input.value);
        });
        return [...byLabel.values()];
      });
      out.push({ itemId: live.itemId, name: entry.name, missing, description, rows });
      console.log(`${live.itemId} ${entry.name.slice(0, 40)} | ${rows.length} rows, ${rows.filter((r) => !r.selected.length).length} empty`);
    } catch (error) {
      out.push({ itemId: entry.itemId, name: entry.name, error: error.message.split('\n')[0].slice(0, 140) });
      console.log('ERR', entry.name.slice(0, 40), error.message.split('\n')[0].slice(0, 100));
    }
    fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  }
} finally {
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  await up.close?.().catch(() => {});
}
process.exit(0);
