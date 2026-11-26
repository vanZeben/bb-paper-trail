// Pure text for the invisible-work cards. No imports, so tests can load it without the SDK.
/** Why every card surfaced. */
export const SURFACED_WHY = "Not mentioned in any weekly summary";

/** "6 code reviews in acme/api, over 3 weeks". */
export const clusterHeadline = (c: { label: string; weeks: readonly string[] }): string => `${c.label}, over ${c.weeks.length} week${c.weeks.length === 1 ? "" : "s"}`;
