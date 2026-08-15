import { log } from '../logger.js';
import { isSellerField } from '../specSanitizer.js';

/** Find a scraped spec value by fuzzy key match (case/space-insensitive). */
function scrapedVal(specs = {}, ...keys) {
  const entries = Object.entries(specs || {});
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '');
  for (const key of keys) {
    const nk = norm(key);
    const hit = entries.find(([k]) => norm(k) === nk || norm(k).includes(nk));
    if (hit && hit[1]) return String(hit[1]).trim();
  }
  return '';
}

/** Normalise scraped values and portal options for safe fuzzy comparison. */
function comparable(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|inc|llp)\b/g, '')
    .replace(/tablets\b/g, 'tablet')
    .replace(/[^a-z0-9]+/g, '');
}

function authoritativeSpecs(product) {
  const sourceSpecs = product.specs && typeof product.specs === 'object' ? product.specs : {};
  if (Object.keys(sourceSpecs).length) return sourceSpecs;
  return product.seo?.specs && typeof product.seo.specs === 'object' ? product.seo.specs : {};
}

const SPEC_GROUP_ALIASES = {
  strength: ['Strength', 'Dose'],
  dose: ['Dose', 'Strength'],
  brand: ['Brand', 'Brand Name'],
  brandname: ['Brand Name', 'Brand'],
  form: ['Form', 'Dosage Form'],
  dosageform: ['Dosage Form', 'Form'],
  composition: ['Composition', 'Active Ingredient'],
  activeingredient: ['Active Ingredient', 'Composition'],
  prescriptiontype: ['Prescription Type', 'Prescription'],
  prescription: ['Prescription', 'Prescription Type'],
  // Pure naming variants of one field: IndiaMART labels it "Packing Type" on
  // some category forms and "Packaging Type" on others.
  packagingtype: ['Packaging Type', 'Packing Type'],
  packingtype: ['Packing Type', 'Packaging Type'],
};

/**
 * Every option row on the rendered specification step, with what it offers and
 * whether anything is ticked. Used to fill ingredient-specific rows and to
 * report exactly what IndiaMART still wants.
 */
export async function readSpecRows(page) {
  return page.evaluate(() => {
    const rows = new Map();
    document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((input) => {
      const container = input.closest('div');
      const label = ((container?.parentElement?.innerText || '').split('\n')[0] || '').trim();
      if (!label) return;
      if (!rows.has(label)) rows.set(label, { label, options: [], checked: false });
      const row = rows.get(label);
      row.options.push(input.value);
      if (input.checked) row.checked = true;
    });
    return [...rows.values()];
  });
}

/**
 * Fill a "<ingredient> Strength" row from the product's plain `Strength`.
 *
 * Category forms for combination medicines name a strength row per ingredient
 * — "Metformin Strength", "Glimepiride Strength", "Voglibose Strength" — while
 * a single-ingredient record just carries "Strength". The value is only used
 * where the product itself names that ingredient, so a Metformin tablet fills
 * "Metformin Strength" and never the Glimepiride or Voglibose rows.
 */
async function fillIngredientStrength(page, product, rows) {
  const specs = authoritativeSpecs(product);
  const strength = scrapedVal(specs, 'Strength', 'Dose');
  if (!strength) return [];

  const describes = comparable(
    `${product.seo?.name || ''} ${product.name || ''} ${product.compound || ''} ` +
      `${specs.Composition || ''} ${specs['Active Ingredient'] || ''}`,
  );
  const filled = [];
  for (const row of rows) {
    const ingredient = (row.label.match(/^(.*?)\s+strength$/i) || [])[1];
    if (!ingredient || row.checked) continue;
    if (!describes.includes(comparable(ingredient))) continue;
    const result = await trySelect({ page, group: row.label, candidates: [strength] });
    if (result.selected) filled.push(`${row.label}=${result.value}`);
  }
  return filled;
}

export function deriveSpecPlan(product) {
  const specs = authoritativeSpecs(product);
  const detailLabels = new Set([
    'minimumorderquantity',
    'deliverytime',
    'productioncapacity',
    'productservicecode',
    'packagingdetails',
  ]);
  const plan = [];
  const represented = new Set();

  // Every submitted value must exist in the scraped/imported record. Portal
  // aliases are tried only to locate the same field in category-specific forms;
  // the value itself is never inferred or replaced with an approximate option.
  for (const [sourceGroup, rawValue] of Object.entries(specs)) {
    const value = String(rawValue ?? '').trim();
    const normalizedSourceGroup = comparable(sourceGroup);
    if (!value || detailLabels.has(normalizedSourceGroup)) continue;
    // Final guard: a hand-edited record must not put another seller's phone
    // number, GST or address onto our listing.
    if (isSellerField(sourceGroup, value)) continue;

    const groups = SPEC_GROUP_ALIASES[normalizedSourceGroup] || [sourceGroup];
    for (const group of groups) {
      const key = `${comparable(group)}:${comparable(value)}`;
      if (represented.has(key)) continue;
      plan.push({
        group,
        candidates: [value],
        other: value,
        required: true,
        sourceGroup,
      });
      represented.add(key);
    }
  }

  return plan;
}

// --- locators anchored to each visible spec row ---
function groupRow(page, group) {
  return page
    .locator(
      `xpath=//*[normalize-space(text())="${group}"]/parent::div[.//input[@type="radio" or @type="checkbox"]][1]`,
    )
    .last();
}

/**
 * Tick one option and report whether it actually took.
 *
 * IndiaMART styles these options with a custom control and parks the real
 * <input> off-screen, so clicking the input directly fails with "Element is
 * outside of the viewport" — it can never be scrolled into view.
 *
 * Only controls that provably belong to THIS input are clicked: a wrapping
 * <label> or a label[for=id]. Clicking a parent or sibling container is not
 * safe — a click lands on the centre of the element, which in a row of options
 * is usually a *different* option, and a stray tick would put a value on the
 * listing that the source data never contained.
 */
async function chooseOption(input) {
  if (await input.isChecked().catch(() => false)) return true;

  const inputId = await input.getAttribute('id').catch(() => '');
  const labels = [
    input.locator('xpath=ancestor::label[1]'),
    inputId ? input.page().locator(`label[for="${inputId}"]`) : null,
  ].filter(Boolean);

  for (const label of labels) {
    if (!(await label.count().catch(() => 0))) continue;
    const control = label.first();
    await control.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await control.click({ timeout: 3000 }).catch(() => {});
    if (await input.isChecked().catch(() => false)) return true;
  }

  // No associated label: run this exact input's own click handler. It fires
  // IndiaMART's listeners as a mouse click would and cannot touch a
  // neighbouring option. The result is read back below, never assumed.
  await input.evaluate((element) => element.click()).catch(() => {});
  return input.isChecked().catch(() => false);
}

async function trySelect({ page, group, candidates = [], other }) {
  const row = groupRow(page, group);
  if (!(await row.isVisible().catch(() => false))) return { group, selected: false, present: false };

  const options = row.locator('input[type="radio"], input[type="checkbox"]');
  const optionValues = await options.evaluateAll((inputs) => inputs.map((input) => input.value));
  let matched = false;
  for (const candidate of candidates) {
    const wanted = comparable(candidate);
    if (!wanted) continue;
    const index = optionValues.findIndex((value) => comparable(value) === wanted);
    if (index >= 0) {
      matched = true;
      const input = options.nth(index);
      if (await chooseOption(input)) {
        return { group, selected: true, value: optionValues[index] };
      }
    }
  }

  const otherIndex = optionValues.findIndex((value) => comparable(value) === 'other');
  if (other && otherIndex >= 0) {
    matched = true;
    const otherRadio = options.nth(otherIndex);
    if (await chooseOption(otherRadio)) {
      const input = row.locator('input[type="text"]:not([disabled])').last();
      await input.waitFor({ state: 'visible', timeout: 3000 });
      await input.fill(String(other), { timeout: 3000 });
      return { group, selected: true, value: `Other:${other}` };
    }
  }

  // Two very different outcomes share this exit, and they must not be reported
  // the same way. If the row offered our value (or an "Other" box) the click
  // failed and that is our bug. If it offered neither, the portal simply has no
  // way to say what the source data says — verified on this account: a
  // "Prescription" row whose only option is "Prescription", against source data
  // reading "Non Prescription". Ticking the one option would publish the
  // opposite of the truth, so the field is left unset and reported instead.
  return {
    group,
    selected: false,
    present: true,
    unrepresentable: !matched,
    value: candidates[0] || other || '',
    options: optionValues,
  };
}

export function deriveAdditionalDetails(product) {
  const specs = authoritativeSpecs(product);
  return [
    {
      label: 'Minimum Order Quantity',
      value: scrapedVal(specs, 'Minimum Order Quantity', 'MOQ', 'Min Order Quantity'),
      required: false,
      clearWhenMissing: true,
    },
    {
      label: 'Delivery Time',
      value: scrapedVal(specs, 'Delivery Time', 'Dispatch Time', 'Lead Time'),
      required: false,
      clearWhenMissing: true,
    },
    {
      label: 'Production Capacity',
      value: scrapedVal(specs, 'Production Capacity', 'Supply Ability'),
      required: false,
    },
    {
      label: 'Product/Service Code',
      value: scrapedVal(specs, 'Product/Service Code', 'Product Code', 'Item Code'),
      required: false,
    },
    {
      label: 'Packaging Details',
      value: scrapedVal(specs, 'Packaging Details', 'Packing Details'),
      required: false,
    },
  ];
}

function detailRow(page, label) {
  return page
    .locator(
      `xpath=//*[normalize-space(text())="${label}"]/parent::div[.//input[not(@disabled)] or .//textarea][1]`,
    )
    .last();
}

async function tryFillDetail(page, detail) {
  const value = String(detail.value || '');
  if (!value && !detail.clearWhenMissing) return { ...detail, filled: false, present: false };
  const row = detailRow(page, detail.label);
  if (!(await row.isVisible().catch(() => false))) return { ...detail, filled: false, present: false };
  const control = row.locator('input:not([disabled]), textarea').first();
  await control.fill(value, { timeout: 3000 });
  const actual = await control.inputValue().catch(() => '');
  return { ...detail, value, filled: actual === value, cleared: !value && actual === '' };
}

/** Fill the spec step for a product. Returns a summary of what was set. */
export async function fillSpecs(page, product) {
  const plan = deriveSpecPlan(product);
  const done = [];
  const missingRequired = [];
  const unrepresentable = [];
  for (const step of plan) {
    const r = await trySelect({ page, ...step });
    if (r.selected) done.push(`${r.group}=${r.value}`);
    else if (r.unrepresentable) unrepresentable.push(r);
    else if (step.required && r.present) missingRequired.push(step.group);
  }
  for (const detail of deriveAdditionalDetails(product)) {
    const result = await tryFillDetail(page, detail);
    if (result.filled) {
      done.push(result.cleared ? `${detail.label}=cleared (no source value)` : `${detail.label}=${detail.value}`);
    } else if (detail.required && result.present) missingRequired.push(detail.label);
  }
  // Category forms name a strength row per ingredient; fill the one this
  // product actually contains.
  const rows = await readSpecRows(page).catch(() => []);
  done.push(...(await fillIngredientStrength(page, product, rows)));

  log.info(`  specs/details set: ${done.join(', ') || '(none)'}`);

  // Name what IndiaMART still wants, with the choices it offers, so the gap can
  // be closed in Specs JSON instead of guessed at here.
  const stillEmpty = (await readSpecRows(page).catch(() => []))
    .filter((row) => !row.checked && !unrepresentable.some((field) => field.group === row.label));
  if (stillEmpty.length) {
    log.warn(`  ${stillEmpty.length} field(s) the form offers were not in this product's data:`);
    stillEmpty.forEach((row) =>
      log.warn(`    ${row.label} — IndiaMART offers: ${[...new Set(row.options)].join(' | ')}`),
    );
  }

  // Every field left blank, and why. Category forms carry rows for ingredients
  // this product does not contain — a Metformin-only tablet is offered
  // "Glimepiride Strength" and "Voglibose Strength" — and there is no true
  // value to put in them. Blank is the honest answer, so callers can tell an
  // intentional gap from something that was actually missed.
  const leftBlank = [
    ...unrepresentable.map((field) => ({
      group: field.group,
      reason: `no option for "${field.value}"`,
      options: field.options,
    })),
    ...stillEmpty.map((row) => ({
      group: row.label,
      reason: 'no value for this field in the product data',
      options: [...new Set(row.options)],
    })),
  ];
  // A field the portal cannot express is a fact about IndiaMART's form, not a
  // failure to fix by retrying, so it is named with the options it did offer
  // and the upload continues rather than blocking this product for good.
  unrepresentable.forEach((field) => {
    log.warn(
      `  left unset — "${field.group}" has no option for "${field.value}"; ` +
        `IndiaMART offers: ${field.options.join(' | ') || '(none)'}`,
    );
  });
  if (missingRequired.length) log.warn(`  could not set required: ${missingRequired.join(', ')}`);
  return { done, missingRequired, unrepresentable, leftBlank };
}
