#!/usr/bin/env node
import { log } from './logger.js';
import { login } from './browser/session.js';
import {
  runScrape,
  runImport,
  runImages,
  runSeo,
  runUpload,
  runAll,
  skipLive,
  status,
} from './pipeline.js';

function parseArgs(argv) {
  const args = { _: [], url: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url.push(argv[++i]);
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--no-detail') args.detail = false;
    else if (a === '--no-skip') args.skipExisting = false;
    else if (a === '--dry-run') args.dryRun = true;
    else args._.push(a);
  }
  return args;
}

const HELP = `
india-mart-products-up — scrape → AI image → AI SEO → upload to IndiaMART

Usage:
  npm run login                      Sign in to IndiaMART once (saves session)
  npm run scrape -- --url "<URL>"    Scrape products from an IndiaMART page
  node src/cli.js import <file.json> Import an existing product JSON file
  npm run images                     Download + AI-regenerate images (pending)
  npm run seo                        Generate SEO copy with DeepSeek (pending)
  npm run upload [-- --dry-run]      Upload pending products (skips already-live)
  node src/cli.js skip-live          Mark products already in your account as skipped
  npm run run                        Full pipeline (scrape→images→seo→upload)
  npm run list                       Show pipeline status

Flags: --url <u> (repeatable) --limit <n> --no-detail --dry-run
`;

async function printStatus() {
  const { counts, products } = await status();
  console.log(`\nProducts: ${counts.total}`);
  for (const stage of ['scraped', 'images', 'seo', 'uploaded']) {
    const c = counts[stage];
    console.log(
      `  ${stage.padEnd(9)} done=${c.done || 0} pending=${c.pending || 0} error=${c.error || 0}`,
    );
  }
  console.log('');
  for (const p of products.slice(0, 40)) {
    const flag = (s) => (p.status[s] === 'done' ? '✓' : p.status[s] === 'error' ? '✗' : '·');
    console.log(
      `  [${flag('images')}${flag('seo')}${flag('uploaded')}] ${(p.seo?.name || p.name).slice(0, 60)}`,
    );
  }
  if (products.length > 40) console.log(`  … ${products.length - 40} more`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    switch (cmd) {
      case 'login':
        await login();
        break;
      case 'scrape':
        await runScrape({ urls: args.url, limit: args.limit, detail: args.detail, mode: args.mode });
        break;
      case 'import':
        if (!args._[1]) throw new Error('usage: import <file.json>');
        await runImport(args._[1]);
        break;
      case 'images':
        await runImages({ limit: args.limit });
        break;
      case 'seo':
        await runSeo({ limit: args.limit });
        break;
      case 'upload':
        await runUpload({ limit: args.limit, dryRun: args.dryRun, skipExisting: args.skipExisting });
        break;
      case 'skip-live':
        await skipLive();
        break;
      case 'run-all':
      case 'run':
        await runAll({ urls: args.url, limit: args.limit, dryRun: args.dryRun });
        break;
      case 'list':
      case 'status':
        await printStatus();
        break;
      default:
        console.log(HELP);
    }
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
  }
}

main();
