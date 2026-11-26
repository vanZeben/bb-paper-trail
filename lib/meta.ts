// The plugin's identity. Everything else imports from here, so a rename is a two-file edit (this file and package.json).
export const PLUGIN_ID = "paper-trail";
export const PLUGIN_NAME = "Paper Trail";
/** Realtime channel: published whenever stored state or the run queue moves. Payload `{ at: number }`. */
export const CHANNEL = `${PLUGIN_ID}-changed`;
/** Prefix of the hidden worker threads' titles. */
export const THREAD_TITLE_PREFIX = `${PLUGIN_NAME}: `;
