/**
 * Recognising a product the account already carries.
 *
 * Every pair below was read off the live account and the seller's
 * erectile-dysfunction category page. Exact-name matching found 3 of them;
 * these are the 6 that are genuinely the same listing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isNearMatch, listingKey } from '../src/listingKey.js';

const same = (a, b) => listingKey(a) === listingKey(b);

test('the same product written differently gets one key', async (t) => {
  await t.test('word order', () => {
    assert.ok(same('20mg Vidalista Tadalafil Tablets', 'Vidalista 20 Mg Tadalafil Tablets'));
  });
  await t.test('singular vs plural', () => {
    assert.ok(same('80Mg Vidalista Tadalafil Tablets', '80mg Vidalista Tadalafil Tablet'));
  });
  await t.test('a leading "Generic"', () => {
    assert.ok(same('5mg Vidalista Tadalafil Tablet', 'Generic Vidalista 5 mg Tadalafil Tablet'));
  });
  await t.test('casing', () => {
    assert.ok(same('10Mg Vidalista Tadalafil Tablets', '10mg vidalista tadalafil tablets'));
  });
});

test('products that only look similar keep separate keys', async (t) => {
  await t.test('a different strength is a different product', () => {
    assert.ok(!same('60mg Vidalista Tadalafil Tablets', '80mg Vidalista Tadalafil Tablets'));
  });
  await t.test('a different brand is a different product', () => {
    assert.ok(!same('20Mg Tadalee Tadalafil Tablets', 'Vidalista 20 Mg Tadalafil Tablets'));
    assert.ok(!same('20Mg Tadalista Tadalafil Tablet', 'Vidalista 20 Mg Tadalafil Tablets'));
  });
  await t.test('a sub-brand is a different product', () => {
    assert.ok(!same('20mg Vidalista Professional Tadalafil tablets', 'Vidalista 20 Mg Tadalafil Tablets'));
    assert.ok(!same('80mg Vidalista Black Tadalafil Tablets', '80mg Vidalista Tadalafil Tablets'));
  });
});

test('a differing ingredient name is reported, never skipped', async (t) => {
  await t.test('same brand and strength, different ingredient quoted', () => {
    // One of these two is mislabelled at the source: Vidalista Black is Tadalafil.
    assert.ok(isNearMatch('80mg Vidalista Black Sildenafil Tablets', '80mg Vidalista Black Tadalafil Tablets'));
  });
  await t.test('a different brand is NOT a near match', () => {
    assert.ok(!isNearMatch('20Mg Tadalee Tadalafil Tablets', 'Vidalista 20 Mg Tadalafil Tablets'));
    assert.ok(!isNearMatch('5Mg Tadarise Tadalafil Tablets', 'Generic Vidalista 5 mg Tadalafil Tablet'));
  });
  await t.test('a different strength is NOT a near match', () => {
    assert.ok(!isNearMatch('60mg Vidalista Tadalafil Tablets', '80mg Vidalista Sildenafil Tablets'));
  });
  await t.test('identical names are not reported as near matches', () => {
    assert.ok(!isNearMatch('40mg Vidalista Tadalafil Tablets', '40mg Vidalista Tadalafil Tablets'));
  });
});

test('strengths survive normalisation', () => {
  assert.match(listingKey('Vidalista 20 Mg Tadalafil Tablets'), /(^| )20mg( |$)/);
  assert.match(listingKey('2.5mg Tadarise Tadalafil Tablets'), /(^| )2\.5mg( |$)/);
});

/**
 * The key that decides "would two of ours land on the same listing?".
 *
 * listingKey drops packaging nouns on purpose, which is right when asking
 * whether the account already carries a product. It is wrong here: it collapsed
 * "Dutaheal Dutasteride 0.5 mg Tablet" (₹350, 20x10 tablets) into
 * "… 0.5 mg Capsules" (₹300, 30 capsules) and blocked both real products.
 */
test('the upload-name key keeps every word that names a product', async (t) => {
  const { uploadNameKey } = await import('../src/listingKey.js');
  const same = (a, b) => uploadNameKey(a) === uploadNameKey(b);

  await t.test('word order alone is not a difference', () => {
    assert.ok(same('0.1% Adakleen Adapalene Gel', 'Adakleen Adapalene Gel 0.1%'));
    assert.ok(same('2% Minoxytop Minoxidil Topical Solution', 'Minoxytop 2% Minoxidil Topical Solution'));
  });

  await t.test('the dosage form is a difference', () => {
    assert.ok(!same('Dutaheal Dutasteride 0.5 mg Tablet', 'Dutaheal Dutasteride 0.5 mg Capsules'));
    assert.ok(!same('Novadart Dutasteride Softgel Capsules', 'Novadart Dutasteride Tablet'));
  });

  await t.test('strength and pack size stay distinct', () => {
    assert.ok(!same('Minoxidil Tablet 5 mg', 'Minoxidil Tablet 10 mg'));
    assert.ok(!same('Mupiheal 2% w/w Mupirocin Cream 30g', '2% Mupiheal Mupirocin Ointment'));
  });

  await t.test('plurals and "20 mg" spacing still normalise', () => {
    assert.ok(same('Fincar Finasteride 5 mg Tablets', 'Fincar Finasteride 5mg Tablet'));
  });
});
