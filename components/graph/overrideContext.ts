// What the confirm/override control needs to know about a target, supplied by the panel that already loaded it
// (day.get / week.get), so a scorecard of six rows does not make six more reads.
import { createContext } from "react";
import type { Override, OverrideTarget } from "../../lib/types";

export interface OverrideInfo {
  /** The AI's current value (rating or scorecard status), null when there is nothing to review. */
  ai: string | null;
  override: Override | null;
}
export const OverrideContext = createContext<(target: OverrideTarget) => OverrideInfo>(() => ({ ai: null, override: null }));

export const RATING_OPTIONS = ["exceeds", "meets", "needs_improvement"] as const;
export const STATUS_OPTIONS = ["hit", "partial", "missed"] as const;
export const STATUS_LABEL: Record<string, string> = { hit: "Hit", partial: "Partial", missed: "Missed" };
