/** export.ts — write the stored days, weeks, framework and feature records as a v2 bundle. */
import type { FeatureCtx } from "../../engine/extensions";
import { isoWeekOf } from "../../engine/dates";
import { KIND } from "../../storage/port";
import { workDaySchema, workWeekSchema } from "../../types";
import { BUNDLE_FORMAT, BUNDLE_VERSION, RECORD_SPECS, type Bundle, type BundleRecord } from "./bundle";

export interface ExportRange {
  from?: string;
  to?: string;
}

/** Everything in range. With no range, everything stored. Time-free records (rules, closure notes, thread edits, ghost states) always go along. */
export async function exportBundle(ctx: FeatureCtx, range: ExportRange = {}): Promise<Bundle> {
  const { store } = ctx;
  const { from, to } = range;
  const bounded = from !== undefined || to !== undefined;
  const inDates = (date: string) => (from === undefined || date >= from) && (to === undefined || date <= to);

  const days = (await store.list(KIND.day, workDaySchema, { from, to })).map((r) => r.value);
  const weeks = (await store.list(KIND.week, workWeekSchema)).map((r) => r.value).filter((w) => (from === undefined || w.to >= from) && (to === undefined || w.from <= to));
  const inWeeks = new Set([...weeks.map((w) => w.week), ...days.map((d) => d.week || isoWeekOf(d.date))]);

  const records: BundleRecord[] = [];
  for (const spec of Object.values(RECORD_SPECS)) {
    if (spec.kind === KIND.framework) continue;
    for (const row of await store.list(spec.kind, spec.schema)) {
      const week = spec.weekOf?.(row.id) ?? null;
      const date = spec.dateOf?.(row.id) ?? null;
      if (bounded && week !== null && !inWeeks.has(week)) continue;
      if (bounded && date !== null && !inDates(date)) continue;
      records.push({ kind: spec.kind, id: row.id, value: row.value });
    }
  }

  // The active framework (the default when none is stored), so a bundle always says which areas its weeks use.
  const framework = await ctx.framework();
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: ctx.now().toISOString(),
    framework,
    timeZoneHint: ctx.settings().timeZone,
    days,
    weeks,
    ...(records.length === 0 ? {} : { records }),
  };
}
