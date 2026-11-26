// Range presets for the Review tab. Pure; dates are YYYY-MM-DD in the user's local calendar.
export type RangePreset = "this_quarter" | "last_quarter" | "this_half" | "last_half" | "custom";

export const RANGE_OPTIONS: readonly { id: RangePreset; label: string }[] = [
  { id: "this_quarter", label: "This quarter" },
  { id: "last_quarter", label: "Last quarter" },
  { id: "this_half", label: "This half" },
  { id: "last_half", label: "Last half" },
  { id: "custom", label: "Custom" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month1: number) => new Date(Date.UTC(year, month1, 0)).getUTCDate();
const span = (year: number, m1: number, m2: number) => ({ from: `${year}-${pad(m1)}-01`, to: `${year}-${pad(m2)}-${pad(lastDay(year, m2))}` });

/** `today` is YYYY-MM-DD. Quarters and halves are calendar ones. */
export function presetRange(preset: Exclude<RangePreset, "custom">, today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const q = Math.floor((month - 1) / 3);
  const h = month <= 6 ? 0 : 1;
  switch (preset) {
    case "this_quarter":
      return span(year, q * 3 + 1, q * 3 + 3);
    case "last_quarter":
      return q === 0 ? span(year - 1, 10, 12) : span(year, (q - 1) * 3 + 1, (q - 1) * 3 + 3);
    case "this_half":
      return span(year, h * 6 + 1, h * 6 + 6);
    case "last_half":
      return h === 0 ? span(year - 1, 7, 12) : span(year, 1, 6);
  }
}

export const localDate = (now = new Date()): string => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
