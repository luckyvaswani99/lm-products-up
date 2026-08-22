/**
 * A dying background-removal worker must say why.
 *
 * On a fresh machine the run reported only:
 *   Upload preview failed for …: rembg CPU worker exited with code 1
 * repeatedly, with no reason — while the engine state showed the model was not
 * cached yet ("modelCached: false, firstRunDownloadsModel: true"), so the
 * failure was in loading/downloading it. The reason was lost because Node
 * rejected on 'exit', which can fire while stderr still holds buffered output.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';

/** Run a child that prints to stderr and dies, collecting what each event saw. */
function observe(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrBuffer = '';
    let atExit = null;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderrBuffer += chunk; });
    child.once('exit', () => { atExit = stderrBuffer; });
    child.once('close', (code) => resolve({ code, atExit, atClose: stderrBuffer }));
  });
}

test('a worker that dies reports the reason it printed', async (t) => {
  // A Python traceback is many lines; this stands in for one.
  const traceback = Array.from({ length: 40 }, (_, i) => `  line ${i}: ValueError: model missing`).join('\n');
  const script = `process.stderr.write(${JSON.stringify(`${traceback}\n`)}); process.exit(1);`;

  await t.test('by close, the whole message is there', async () => {
    const { code, atClose } = await observe(script);
    assert.equal(code, 1);
    assert.match(atClose, /ValueError: model missing/);
    assert.equal(atClose.trim().split('\n').length, 40);
  });

  await t.test('the last lines are what gets reported', async () => {
    const { atClose } = await observe(script);
    const detail = atClose.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ');
    assert.match(detail, /line 39: ValueError: model missing$/);
    assert.ok(detail.length < 400, 'the report stays short enough to read in a log line');
  });

  await t.test('a worker that says nothing still yields an exit code', async () => {
    const { code, atClose } = await observe('process.exit(1);');
    assert.equal(code, 1);
    assert.equal(atClose, '', 'nothing to quote — the caller adds the model-cache hint instead');
  });
});
