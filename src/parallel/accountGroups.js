import { Uploader } from '../uploader/indiamartUploader.js';

/**
 * Read the product groups this account carries.
 *
 * Opens the shared browser profile, reads the group menu and closes again, so
 * the UI can offer a lane's group as a choice from the account's own list. A
 * category page's name is not a group name — this seller has a
 * "pain-killer-medicines" category and the account has no pain-killer group at
 * all — so the alternative to reading them is guessing, which would file real
 * listings under a group nobody picked.
 */
export async function readAccountGroups() {
  const up = new Uploader();
  await up.open();
  try {
    return await up.readAccountGroups();
  } finally {
    await up.close().catch(() => {});
  }
}
