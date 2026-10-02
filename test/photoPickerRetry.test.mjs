/**
 * The photo step may only be retried while IndiaMART still holds nothing.
 *
 * Four products in one batch of forty failed because the portal's picker never
 * appeared ("locator.waitFor: Timeout 10000ms exceeded") or its cropper read
 * none of the files — in both cases nothing had been handed over, so the
 * listing was untouched and a second attempt was free. A failure AFTER the
 * cropper's Upload Photos has been clicked is the opposite case: retrying
 * could attach the same photo twice, so it must be reported as it stands.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Uploader } from '../src/uploader/indiamartUploader.js';

const galleryFailure = (message, handedOver) => {
  const error = new Error(`Gallery upload failed (1 photos): ${message}`);
  error.handedOver = handedOver;
  return error;
};

/** An uploader whose only live parts are the retry policy itself. */
const stubbed = (attempts) => {
  const uploader = new Uploader();
  uploader.page = { waitForTimeout: async () => {} };
  uploader._drainImageReview = async () => {};
  uploader.calls = 0;
  uploader._uploadPhotosOnce = async () => {
    uploader.calls += 1;
    const outcome = attempts[uploader.calls - 1];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return uploader;
};

test('a picker that never opened is retried once', async () => {
  const uploader = stubbed([
    galleryFailure('locator.waitFor: Timeout 10000ms exceeded.', false),
    1,
  ]);
  assert.equal(await uploader._uploadPhotos({ id: 'p1' }), 1);
  assert.equal(uploader.calls, 2);
});

test('a cropper that read none of the files is retried once', async () => {
  const uploader = stubbed([
    galleryFailure('IndiaMART read only 0 of 1 photos into the crop popup within 35s', false),
    1,
  ]);
  assert.equal(await uploader._uploadPhotos({ id: 'p2' }), 1);
  assert.equal(uploader.calls, 2);
});

test('a failure after the photos were handed over is never retried', async () => {
  const uploader = stubbed([galleryFailure('locator.waitFor: Timeout 30000ms exceeded.', true)]);
  await assert.rejects(() => uploader._uploadPhotos({ id: 'p3' }), /Gallery upload failed/);
  assert.equal(uploader.calls, 1, 'retrying here could attach the same photo twice');
});

test('a failure that is not a timeout is reported as it stands', async () => {
  const uploader = stubbed([
    galleryFailure('IndiaMART file input accepted only one file; 3 were prepared', false),
  ]);
  await assert.rejects(() => uploader._uploadPhotos({ id: 'p4' }), /accepted only one file/);
  assert.equal(uploader.calls, 1);
});

test('the second attempt is allowed to fail for good', async () => {
  const uploader = stubbed([
    galleryFailure('locator.waitFor: Timeout 10000ms exceeded.', false),
    galleryFailure('locator.waitFor: Timeout 10000ms exceeded.', false),
  ]);
  await assert.rejects(() => uploader._uploadPhotos({ id: 'p5' }), /Gallery upload failed/);
  assert.equal(uploader.calls, 2, 'one retry, not a loop');
});
