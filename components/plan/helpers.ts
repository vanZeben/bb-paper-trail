// UI-side helpers for the Week tab. Pure; no runtime import from the server side.
import type { WeekPlan } from "../../lib/types";

export type Status = "done" | "partial" | "not_done" | "dropped";

/** Hit, Partial and Missed always show an icon and a label next to the colour. */
export const MARKS: Record<Status, { label: string; icon: string; tone: string }> = {
  done: { label: "Hit", icon: "CircleCheck", tone: "bg-green-700/20 text-green-800 dark:text-green-300" },
  partial: { label: "Partial", icon: "CircleDot", tone: "bg-amber-500/20 text-amber-800 dark:text-amber-300" },
  not_done: { label: "Missed", icon: "CircleX", tone: "bg-orange-500/20 text-orange-800 dark:text-orange-300" },
  dropped: { label: "Dropped", icon: "Ban", tone: "bg-muted text-muted-foreground" },
};

export const KIND_ICON: Record<string, { label: string; icon: string }> = {
  deliver: { label: "Deliver", icon: "PackageCheck" },
  decide: { label: "Decide", icon: "Scale" },
  review: { label: "Review", icon: "Eye" },
  prep: { label: "Prep", icon: "ClipboardList" },
  unblock: { label: "Unblock", icon: "Unlock" },
  other: { label: "Other", icon: "Circle" },
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const dayName = (date: string): string => DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? date;

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Widths (percent) of the meetings and focus parts of the week-shape bar. */
export function shapeWidths(shape: Pick<NonNullable<WeekPlan["shape"]>, "meetingHours" | "focusHours">): { meetings: number; focus: number } {
  const total = shape.meetingHours + shape.focusHours;
  if (total <= 0) return { meetings: 0, focus: 0 };
  const meetings = Math.round((shape.meetingHours / total) * 100);
  return { meetings, focus: 100 - meetings };
}
