// UI-side link guard: only https links are ever rendered as an href. Anything else (javascript:, data:, http:, relative)
// comes back undefined, so the anchor is inert. No imports, so any component may use it.
export function safeHref(s: string | null | undefined): string | undefined {
  return typeof s === "string" && /^https:\/\//.test(s) ? s : undefined;
}
