/**
 * Apply a reviewed plan (data/spec-plan.json: [{ itemId, name, specs }]) to listings
 * that are already live, 3 browsers at a time. Each listing gets exactly the rows
 * in its plan; rows that are already ticked, and everything else on the listing,
 * are left alone.
 *
 *   node tools/applySpecPlan.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { Uploader } from '../src/uploader/indiamartUploader.js';

const planFile = process.argv[2] || 'data/spec-plan.json';
const resultFile = process.argv[3] || 'data/spec-plan-results.json';
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const results = [];
const PROFILES = ['hair-care', 'pharmaceutical-capsules', 'veterinary-medicines'];
let next = 0;

async function worker(profile) {
  const up = new Uploader({ sessionDir: path.resolve('.session-lanes', profile), label: `plan-${profile}` });
  await up.open();
  try {
    for (;;) {
      const entry = plan[next];
      next += 1;
      if (!entry) return;
      try {
        const r = await up.applySpecPlan({ id: entry.itemId, name: entry.name, explicitSpecs: entry.specs });
        results.push({ itemId: entry.itemId, name: entry.name, ...r });
        console.log(`${entry.itemId} ${entry.name.slice(0, 36)} — set ${r.filled.length}, missing ${r.missingBefore} -> ${r.missingAfter}`);
      } catch (error) {
        results.push({ itemId: entry.itemId, name: entry.name, error: error.message.split('\n')[0] });
        console.log(`${entry.itemId} ${entry.name.slice(0, 36)} ✗ ${error.message.split('\n')[0].slice(0, 110)}`);
      }
      fs.writeFileSync(resultFile, JSON.stringify(results, null, 1));
    }
  } finally {
    await up.close?.().catch(() => {});
  }
}
await Promise.all(PROFILES.map((profile) => worker(profile)));
console.log('FINISHED');
process.exit(0);
