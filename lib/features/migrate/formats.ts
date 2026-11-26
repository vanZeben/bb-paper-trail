/** formats.ts — bundle format names. No imports, so the app bundle can use it without pulling in zod. */
export const BUNDLE_FORMAT = "paper-trail-bundle";
/** Bundles exported before the rename carry this format; they are still accepted on import. */
export const LEGACY_BUNDLE_FORMAT = "receipts-bundle";
export const BUNDLE_VERSION = 1;
