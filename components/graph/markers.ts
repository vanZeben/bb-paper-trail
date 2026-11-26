// Week-header markers: which of them show and in what order. Pure.
import type { Severity, WeekMarkers } from "../../lib/types";

/** Status-palette colours (guardrail dot / drift caret). The shape and the count carry the meaning too. */
export const SEVERITY_COLOR: Record<Severity, string> = { info: "#898781", warning: "#fab219", breach: "#d03b3b" };
export const DRIFT_COLOR = { watch: "#fab219", off: "#ec835a" } as const;

export interface MarkerItems {
  /** Worst-severity guardrail dot with its count. */
  guardrail: { severity: Severity; count: number } | null;
  drift: "watch" | "off" | null;
  /** Shipped and need-closure counts; shown only when the header has room (at most one other marker). */
  badge: { shipped: number; needClosure: number } | null;
}

/**
 * At most two markers above a week number. Guardrail first, drift second; the shipped/closure badge is the last to
 * get a place and only appears when it leaves the header with two items or fewer.
 */
export function weekMarkerItems(m: WeekMarkers): MarkerItems {
  const guardrail = m.guardrail !== null ? { severity: m.guardrail, count: m.guardrailCount } : null;
  const drift = m.drift;
  const used = (guardrail !== null ? 1 : 0) + (drift !== null ? 1 : 0);
  const hasBadge = m.shipped > 0 || m.needClosure > 0;
  return { guardrail, drift, badge: hasBadge && used <= 1 ? { shipped: m.shipped, needClosure: m.needClosure } : null };
}

export const hasMarkers = (m: WeekMarkers): boolean => {
  const items = weekMarkerItems(m);
  return items.guardrail !== null || items.drift !== null || items.badge !== null;
};
