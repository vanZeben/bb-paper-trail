import { useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import { BUNDLE_FORMAT, LEGACY_BUNDLE_FORMAT } from "../../lib/features/migrate/formats";
import { PLUGIN_ID, PLUGIN_NAME } from "../../lib/meta";
import { Card, ErrorNote, Pill, relativeTime, errorText, useAsync } from "../common";

/** What a bundle file holds, counted without validating it (the server validates on import). */
interface Preview {
  fileName: string;
  exportedAt: string | null;
  days: number;
  weeks: number;
  records: number;
  hasFramework: boolean;
  /** How many days/weeks are in the original (v1) format and will be converted. */
  converted: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Throws a readable message when the file is not a Paper Trail bundle. */
function previewOf(fileName: string, doc: unknown): Preview {
  if (!isRecord(doc) || (doc.format !== BUNDLE_FORMAT && doc.format !== LEGACY_BUNDLE_FORMAT)) throw new Error(`This file is not a ${PLUGIN_NAME} data bundle.`);
  const days = Array.isArray(doc.days) ? doc.days : [];
  const weeks = Array.isArray(doc.weeks) ? doc.weeks : [];
  const records = Array.isArray(doc.records) ? doc.records : [];
  const converted = [...days, ...weeks].filter((r) => isRecord(r) && r.version === 1).length;
  return { fileName, exportedAt: typeof doc.exportedAt === "string" ? doc.exportedAt : null, days: days.length, weeks: weeks.length, records: records.length, hasFramework: isRecord(doc.framework), converted };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Settings panel: import a data bundle, export your data, and see what the last import did. */
export function MigratePanel(_props: {}) {
  const rpc = useRpc<RpcContract>();
  const status = useAsync(() => rpc.call("migrate.status"), []);
  const input = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState<{ preview: Preview; doc: unknown } | null>(null);
  const [applyFramework, setApplyFramework] = useState(false);
  const [busy, setBusy] = useState<"import" | "export" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    setError(null);
    setNotice(null);
    setBundle(null);
    if (file === undefined) return;
    try {
      const doc: unknown = JSON.parse(await file.text());
      setBundle({ preview: previewOf(file.name, doc), doc });
    } catch (cause) {
      setError(cause instanceof SyntaxError ? "That file is not valid JSON." : errorText(cause));
    }
  };

  const runImport = async () => {
    if (bundle === null) return;
    setBusy("import");
    setError(null);
    setNotice(null);
    try {
      const result = await rpc.call("data.import", { bundle: bundle.doc, applyFramework });
      setNotice(`Imported ${plural(result.imported.days, "day")}, ${plural(result.imported.weeks, "week")} and ${plural(result.imported.records, "record")}; skipped ${result.skipped}.`);
      setBundle(null);
      if (input.current) input.current.value = "";
      status.reload();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const runExport = async () => {
    setBusy("export");
    setError(null);
    try {
      const { bundle: out } = await rpc.call("data.export", {});
      download(`${PLUGIN_ID}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 2));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const last = status.data;
  const hasLast = last !== null && last.at !== null;

  return (
    <div className="grid gap-3">
      <Card title="Import a bundle" aside="A bundle is a JSON file of days, weeks and your notes. Importing is safe to repeat: records you already have at the same or a newer time are skipped.">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={input} type="file" accept="application/json,.json" aria-label="Choose a bundle file" className="sr-only" id={`${PLUGIN_ID}-bundle-file`} onChange={(e) => void pick(e.target.files?.[0])} />
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => input.current?.click()}>
              <Icon name="Upload" className="size-3.5" />
              Choose a file
            </Button>
            {bundle === null ? <span className="text-xs text-muted-foreground">No file chosen</span> : <span className="truncate text-xs text-muted-foreground">{bundle.preview.fileName}</span>}
          </div>

          {bundle === null ? null : (
            <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-3" aria-live="polite">
              <div className="flex flex-wrap gap-1.5">
                <Pill>{plural(bundle.preview.days, "day")}</Pill>
                <Pill>{plural(bundle.preview.weeks, "week")}</Pill>
                <Pill>{plural(bundle.preview.records, "record")}</Pill>
                {bundle.preview.hasFramework ? <Pill>includes a role framework</Pill> : null}
                {bundle.preview.converted > 0 ? <Pill>{plural(bundle.preview.converted, "record")} converted from the original format</Pill> : null}
              </div>
              {bundle.preview.exportedAt === null ? null : <p className="text-xs text-muted-foreground">Exported {relativeTime(bundle.preview.exportedAt)}.</p>}
              {bundle.preview.hasFramework ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={applyFramework} onCheckedChange={(v) => setApplyFramework(v === true)} aria-label="Replace my role framework with the bundle's" />
                  Replace my role framework with the bundle's
                </label>
              ) : null}
              {bundle.preview.hasFramework && !applyFramework ? (
                <p className="text-xs text-muted-foreground">Without this, the bundle's framework is only used when you have none yet.</p>
              ) : null}
              <div>
                <Button size="sm" disabled={busy !== null} onClick={() => void runImport()}>
                  <Icon name={busy === "import" ? "Loader" : "Download"} className="size-3.5" />
                  {busy === "import" ? "Importing…" : "Import"}
                </Button>
              </div>
            </div>
          )}
          {notice === null ? null : (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
        </div>
      </Card>

      <Card title="Export my data" aside="Everything in one JSON file: days, weeks, your framework, your overrides, notes, plans and closure notes.">
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void runExport()}>
          <Icon name={busy === "export" ? "Loader" : "Download"} className="size-3.5" />
          {busy === "export" ? "Preparing…" : "Download bundle"}
        </Button>
      </Card>

      <Card title="Last import">
        {status.error !== null ? <ErrorNote message={status.error} /> : null}
        {!hasLast ? (
          <p className="text-sm text-muted-foreground">Nothing imported yet.</p>
        ) : (
          <div className="grid gap-2 text-sm">
            <p>
              {relativeTime(last.at)}: {plural(last.imported.days, "day")}, {plural(last.imported.weeks, "week")} and {plural(last.imported.records, "record")} imported; {last.skipped} skipped.
            </p>
            {last.warnings.length === 0 ? null : (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {last.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {last.errors.length === 0 ? null : (
              <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <p className="mb-1 font-medium">{plural(last.errors.length, "problem")}</p>
                <ul className="list-disc pl-4">
                  {last.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      <ErrorNote message={error} />
      <p className="text-xs text-muted-foreground">Your data stays in this bb server's plugin database.</p>
    </div>
  );
}
