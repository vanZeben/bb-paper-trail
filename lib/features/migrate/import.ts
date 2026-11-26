/**
 * import.ts — bring a data bundle into the store. Validate each item on its own (one bad record is reported, never
 * fatal), skip what the store already has at the same or a newer time, save the rest through the service, then rebuild
 * the index and replay every week hook so drift, guardrails, threads and the radar fill in deterministically.
 */
import type { FeatureCtx } from "../../engine/extensions";
import type { WorklogService } from "../../engine/service";
import { KIND } from "../../storage/port";
import { roleFrameworkSchema, type RoleFramework } from "../../types";
import { dayStamp, normalizeDay, normalizeWeek, parseBundle, shouldReplace, validateRecord, weekStamp } from "./bundle";

export const IMPORT_META = "import";

export interface ImportSummary {
  imported: { days: number; weeks: number; records: number };
  skipped: number;
  errors: string[];
  warnings: string[];
  /** ISO time the import finished. */
  at: string | null;
}

export interface ImportDeps {
  ctx: FeatureCtx;
  service: WorklogService;
}

export interface ImportOptions {
  /** Replace the stored framework with the bundle's even when one exists. */
  applyFramework?: boolean;
}

/** Keep the summary small: the first errors, then a count. */
const MAX_LISTED = 20;
const capped = (list: string[]): string[] => (list.length <= MAX_LISTED ? list : [...list.slice(0, MAX_LISTED), `…and ${list.length - MAX_LISTED} more`]);
const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Validate the shape and import it. Throws only when `input` is not a bundle at all. */
export async function importBundle(input: unknown, deps: ImportDeps, opts: ImportOptions = {}): Promise<ImportSummary> {
  const { ctx, service } = deps;
  const { store } = ctx;
  const bundle = parseBundle(input);
  const errors: string[] = [];
  const warnings: string[] = [];
  const imported = { days: 0, weeks: 0, records: 0 };
  let skipped = 0;

  // The framework: stored once when none exists (or on request); v1 weeks snapshot the bundle's framework either way.
  const records = bundle.records ?? [];
  const fwRecord = records.find((r) => r.kind === KIND.framework && r.id === "active");
  const fwFromRecord = fwRecord === undefined ? null : roleFrameworkSchema.safeParse(fwRecord.value);
  const bundleFramework: RoleFramework | null = bundle.framework ?? (fwFromRecord?.success ? fwFromRecord.data : null);
  const stored = await store.get(KIND.framework, "active", roleFrameworkSchema);
  if (bundleFramework !== null && (stored === null || opts.applyFramework === true)) {
    await store.set(KIND.framework, "active", bundleFramework);
    imported.records += 1;
  }
  const snapshotFramework = bundleFramework ?? (await ctx.framework());

  // Feature records first, so the replayed hooks see them.
  for (const rec of records) {
    if (rec.kind === KIND.framework) continue;
    try {
      const valid = validateRecord(rec);
      const existing = await store.get(valid.kind, valid.id, valid.spec.schema);
      if (existing !== null && !shouldReplace(valid.spec, existing, valid.value)) {
        skipped += 1;
        continue;
      }
      await store.set(valid.kind, valid.id, valid.value);
      imported.records += 1;
    } catch (cause) {
      errors.push(`record ${rec.kind}/${rec.id}: ${message(cause)}`);
    }
  }

  for (const [at, raw] of bundle.days.entries()) {
    try {
      const day = normalizeDay(raw);
      const have = await service.day(day.date);
      if (have !== null && dayStamp(have) >= dayStamp(day)) {
        skipped += 1;
        continue;
      }
      await service.importDay(day);
      imported.days += 1;
    } catch (cause) {
      errors.push(`day #${at + 1}: ${message(cause)}`);
    }
  }

  const unknownAreas = new Set<string>();
  const knownAreas = new Set([...snapshotFramework.areas.map((a) => a.key), ...Object.keys(snapshotFramework.areaAliases), ...Object.values(snapshotFramework.areaAliases)]);
  for (const [at, raw] of bundle.weeks.entries()) {
    try {
      const week = normalizeWeek(raw, snapshotFramework);
      const have = await service.week(week.week);
      if (have !== null && weekStamp(have) >= weekStamp(week)) {
        skipped += 1;
        continue;
      }
      for (const row of week.scorecard) if (!knownAreas.has(row.area)) unknownAreas.add(row.area);
      await service.importWeek(week);
      imported.weeks += 1;
    } catch (cause) {
      errors.push(`week #${at + 1}: ${message(cause)}`);
    }
  }
  if (unknownAreas.size > 0) {
    warnings.push(`Scorecard areas not in the active framework (add them or map them with areaAliases): ${[...unknownAreas].sort().join(", ")}`);
  }

  // Derived state: the index, then every week hook (oldest first) over the stored weeks.
  try {
    await service.rebuildIndex();
    await service.replayWeekHooks();
  } catch (cause) {
    errors.push(`rebuild: ${message(cause)}`);
  }

  const summary: ImportSummary = { imported, skipped, errors: capped(errors), warnings: capped(warnings), at: ctx.now().toISOString() };
  await store.setMeta(IMPORT_META, JSON.stringify(summary));
  ctx.publish();
  return summary;
}

/** The last import's summary, or null before the first. */
export async function lastImport(ctx: FeatureCtx): Promise<ImportSummary | null> {
  const raw = await ctx.store.getMeta(IMPORT_META);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<ImportSummary>;
    return {
      imported: { days: v.imported?.days ?? 0, weeks: v.imported?.weeks ?? 0, records: v.imported?.records ?? 0 },
      skipped: v.skipped ?? 0,
      errors: v.errors ?? [],
      warnings: v.warnings ?? [],
      at: v.at ?? null,
    };
  } catch {
    return null;
  }
}
