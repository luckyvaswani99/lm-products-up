/**
 * Regression tests for the two faults that broke real uploads:
 *
 *  1. "locator.check: Element is outside of the viewport" — IndiaMART parks the
 *     real <input> off-screen behind a custom-styled control, so clicking the
 *     input directly can never work. Markup here mirrors the failing log line:
 *     <input type="checkbox" name="input_4392425" value="Hormone Therapy"/>
 *
 *  2. The seller's own contact card ("Contact Number", "Verified GST Number",
 *     "Address") was scraped into product specs and would have been published
 *     onto our listing.
 *
 * Both suites assert the honest outcome too: a value the portal does not offer
 * must be reported as missing, never approximated with a nearby option.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fillSpecs } from '../src/uploader/specFiller.js';
import { isSellerField, sanitizeSpecs } from '../src/specSanitizer.js';

const HIDDEN_INPUT_CSS =
  '<style>.opt input{position:absolute;left:-9999px;width:0;height:0}' +
  '.ui,label{display:inline-block;padding:6px 12px;border:1px solid #999;cursor:pointer}</style>';

const ROWS = {
  'off-screen input with no label (the reported failure)': `${HIDDEN_INPUT_CSS}
    <div class="row"><span>Usage</span>
      <div class="opt"><input type="checkbox" name="input_4392425" value="Male Infertility"><span class="ui">Male Infertility</span></div>
      <div class="opt"><input type="checkbox" name="input_4392425" value="Hormone Therapy"><span class="ui">Hormone Therapy</span></div>
    </div>`,
  'off-screen input driven by label[for]': `${HIDDEN_INPUT_CSS}
    <div class="row"><span>Usage</span>
      <div class="opt"><input type="checkbox" id="u1" value="Male Infertility"><label for="u1">Male Infertility</label></div>
      <div class="opt"><input type="checkbox" id="u2" value="Hormone Therapy"><label for="u2">Hormone Therapy</label></div>
    </div>`,
  'plain in-viewport row': `
    <div class="row"><span>Usage</span>
      <label><input type="checkbox" value="Male Infertility">Male Infertility</label>
      <label><input type="checkbox" value="Hormone Therapy">Hormone Therapy</label>
    </div>`,
};

const VALUE_NOT_OFFERED = `
  <div class="row"><span>Usage</span>
    <label><input type="checkbox" value="Male Infertility">Male Infertility</label>
    <label><input type="checkbox" value="Muscle Growth">Muscle Growth</label>
  </div>`;

const product = { specs: { Usage: 'Hormone Therapy' } };
const checkedValues = (page) =>
  page.$$eval('input[type="checkbox"]', (boxes) => boxes.filter((b) => b.checked).map((b) => b.value));

test('spec options are ticked whatever control IndiaMART renders', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  t.after(() => browser.close());

  for (const [name, html] of Object.entries(ROWS)) {
    await t.test(name, async () => {
      await page.setContent(html);
      const result = await fillSpecs(page, product);
      assert.deepEqual(result.missingRequired, []);
      // Only the scraped value may be ticked — never a neighbouring option.
      assert.deepEqual(await checkedValues(page), ['Hormone Therapy']);
    });
  }

  await t.test('a value the portal does not offer is reported, not guessed', async () => {
    await page.setContent(VALUE_NOT_OFFERED);
    const result = await fillSpecs(page, product);
    // Nothing is ticked: a near-enough option is never substituted. The field
    // is reported as unrepresentable rather than counted as a failure, so one
    // form the portal cannot express does not block the product for ever.
    assert.deepEqual(await checkedValues(page), []);
    assert.deepEqual(result.missingRequired, []);
    assert.deepEqual(
      result.unrepresentable.map((field) => field.group),
      ['Usage'],
    );
  });
});

test('seller contact rows never reach the product record', async (t) => {
  await t.test('drops the rows observed on real detail pages', () => {
    assert.deepEqual(
      sanitizeSpecs({
        Strength: '250 mg/ml',
        Usage: 'Hormone Therapy',
        'Contact Number': '+91-8047656348',
        'Verified GST Number': '27**********1ZZ',
        Address: 'Nagpur, Maharashtra',
      }),
      { Strength: '250 mg/ml', Usage: 'Hormone Therapy' },
    );
  });

  await t.test('recognises contact data even when the row is renamed', () => {
    assert.ok(isSellerField('Enquiry Line', '+91-8047656348'));
    assert.ok(isSellerField('Reference', 'sales@example.com'));
    assert.ok(isSellerField('Registration', '27ABCDE1234F1ZZ'));
  });

  await t.test('keeps product rows that merely look numeric', () => {
    const specs = {
      'Product/Service Code': '3004900000',
      'Physical State': 'Liquid',
      'Shelf Life': '36 months',
      'Packaging Size': '10 ml',
      Composition: 'Testosterone Enanthate',
    };
    assert.deepEqual(sanitizeSpecs(specs), specs);
  });
});

/**
 * A field the portal cannot express must not block the product for ever.
 *
 * Verified on this account: the spec form for "850 mg Glycoheal Metformin
 * Tablet SR" renders a "Prescription" row whose ONLY option is "Prescription",
 * while the source data reads "Non Prescription". Ticking the single option
 * would publish the opposite of the truth, and treating it as a required
 * failure blocked every upload attempt.
 */
test('a row with no option for the real value is reported, not failed', async (t) => {
  const { chromium } = await import('playwright');
  const { fillSpecs } = await import('../src/uploader/specFiller.js');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  const row = (label, values) => `
    <div><span>${label}</span>${values
      .map((value) => `<label><input type="radio" name="${label}" value="${value}">${value}</label>`)
      .join('')}</div>`;

  await t.test('the unsettable field does not block the upload', async () => {
    await page.setContent(row('Prescription', ['Prescription']) + row('Form', ['Tablet']));
    const result = await fillSpecs(page, {
      specs: { 'Prescription Type': 'Non Prescription', Form: 'Tablet' },
    });

    assert.deepEqual(result.missingRequired, []);
    assert.equal(result.unrepresentable.length, 1);
    assert.equal(result.unrepresentable[0].group, 'Prescription');
    assert.deepEqual(result.unrepresentable[0].options, ['Prescription']);
  });

  await t.test('the wrong option is never ticked in its place', async () => {
    assert.equal(await page.locator('input[value="Prescription"]').isChecked(), false);
  });

  await t.test('a field the row does offer is still set', async () => {
    assert.equal(await page.locator('input[value="Tablet"]').isChecked(), true);
  });

  await t.test('an option that exists but will not tick is still a failure', async () => {
    await page.setContent(`
      <div><span>Prescription</span>
        <label><input type="radio" name="p" value="Non Prescription" disabled>Non Prescription</label>
      </div>`);
    const result = await fillSpecs(page, { specs: { Prescription: 'Non Prescription' } });

    assert.deepEqual(result.unrepresentable, []);
    assert.deepEqual(result.missingRequired, ['Prescription']);
  });
});

/**
 * A row that offers the same quantity in a different unit.
 *
 * Real upload log: source "Shelf Life: 36 months" against a row offering
 * "1 years | 1.5 years | 2 years | 2.5 years | 3 years" and no "Other" box, so
 * the field was left unset even though 36 months is exactly 3 years.
 */
test('a value the row spells in another unit is still set, never rounded', async (t) => {
  const { chromium } = await import('playwright');
  const { fillSpecs, equivalentValues } = await import('../src/uploader/specFiller.js');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  const shelfLife = (values) => `
    <div><span>Shelf Life</span>${values
      .map((v) => `<label><input type="radio" name="sl" value="${v}">${v}</label>`)
      .join('')}</div>`;
  const YEARS = ['1 years', '1.5 years', '2 years', '2.5 years', '3 years'];

  await t.test('36 months is ticked as the row’s own "3 years"', async () => {
    await page.setContent(shelfLife(YEARS));
    const result = await fillSpecs(page, { specs: { 'Shelf Life': '36 months' } });

    assert.equal(await page.locator('input[value="3 years"]').isChecked(), true);
    assert.ok(result.done.includes('Shelf Life=3 years'));
    assert.deepEqual(result.unrepresentable, []);
  });

  await t.test('only exact conversions are offered', () => {
    assert.deepEqual(equivalentValues('36 months'), ['3 years', '3 year']);
    assert.deepEqual(equivalentValues('30 months'), ['2.5 years', '2.5 year']);
    assert.deepEqual(equivalentValues('2 years'), ['24 months', '24 month']);
    // 20/12 does not come out clean, so nothing is claimed for it.
    assert.deepEqual(equivalentValues('20 months'), []);
    assert.deepEqual(equivalentValues('Strip'), []);
  });

  await t.test('a quantity the row genuinely lacks is still left unset', async () => {
    await page.setContent(shelfLife(['1 years', '2 years']));
    const result = await fillSpecs(page, { specs: { 'Shelf Life': '36 months' } });

    assert.equal(await page.locator('input:checked').count(), 0);
    assert.deepEqual(result.unrepresentable.map((f) => f.group), ['Shelf Life']);
  });
});

/**
 * A product went live with every one of its seven specifications empty, while
 * the same run's log listed those rows and the options they offered. The rows
 * were on the page; the locator could not reach them.
 *
 * Markup recorded from the live specification step:
 *
 *   <div class="SLC_dflx">                                  <- the row
 *     <div><span title="Strength">Strength</span></div>     <- label column
 *     <div class="MPSD_SPADpopw1"><ul><li>
 *       <label><input type="radio" readonly value="7.5 mg">  <- options column
 *
 * The label's parent is the label column, which holds no inputs at all, so a
 * `parent::div[.//input]` step matched nothing.
 */
test('a spec row is found when its label sits beside the options', async (t) => {
  const { chromium } = await import('playwright');
  const { fillSpecs } = await import('../src/uploader/specFiller.js');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  /** The row exactly as the portal builds it: label and options are siblings. */
  const row = (label, values) => `
    <div class="SLC_dflx">
      <div class="SLC_f13 MPSD_SPADpopw"><span class="MPSD_SPADpopqtxt" title="${label}">${label}</span></div>
      <div class="MPSD_SPADpopw1"><ul>${values
        .map(
          (v) => `<li><label class="MPSD_SPADpop_radio">
            <input type="radio" name="input_4339168" readonly value="${v}">
            <span class="MPSD_SPADpop_radiolbltxt">${v}</span></label></li>`,
        )
        .join('')}</ul></div>
    </div>`;

  await t.test('the value is ticked, not skipped', async () => {
    await page.setContent(row('Strength', ['7.5 mg', '10 mg', '20 mg']));
    const result = await fillSpecs(page, { specs: { Strength: '10 mg' } });

    assert.equal(await page.locator('input[value="10 mg"]').isChecked(), true);
    assert.ok(result.done.includes('Strength=10 mg'));
  });

  await t.test('the older layout, where the label is the parent, still works', async () => {
    await page.setContent(`
      <div><span>Strength</span>
        <label><input type="radio" value="10 mg">10 mg</label>
      </div>`);
    const result = await fillSpecs(page, { specs: { Strength: '10 mg' } });
    assert.ok(result.done.includes('Strength=10 mg'));
  });

  await t.test('a label that differs only in case still matches', async () => {
    // The source writes "Shelf life"; the form renders "Shelf Life". That one
    // capital dropped the value entirely.
    await page.setContent(row('Shelf Life', ['24 months', '36 months']));
    const result = await fillSpecs(page, { specs: { 'Shelf life': '2 years' } });
    assert.ok(
      result.done.includes('Shelf life=24 months'),
      `expected 2 years to resolve to the row's own 24 months, got ${JSON.stringify(result.done)}`,
    );
  });

  await t.test('a value with no row at all is named, never dropped in silence', async () => {
    await page.setContent(row('Strength', ['10 mg']));
    const result = await fillSpecs(page, {
      specs: { Strength: '10 mg', Manufacturer: 'HAB Pharma', 'Country of Origin': 'Made in India' },
    });

    assert.ok(result.done.includes('Strength=10 mg'));
    assert.deepEqual(result.noSuchRow.sort(), ['Country of Origin=Made in India', 'Manufacturer=HAB Pharma']);
  });

  await t.test('an alias that found no row is not reported as a lost value', async () => {
    // "Strength" is also planned as "Dose"; only one of them can match.
    await page.setContent(row('Strength', ['10 mg']));
    const result = await fillSpecs(page, { specs: { Strength: '10 mg' } });
    assert.deepEqual(result.noSuchRow, []);
  });
});
