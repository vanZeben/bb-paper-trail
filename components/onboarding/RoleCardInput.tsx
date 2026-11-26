// Role card input: upload a .md/.txt (read here, in the browser), paste text, or give a note path or link that the agent
// reads with its own tools. Reports a card (or null while it is empty or invalid) plus a problem line.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RoleCard } from "../../lib/types";
import { Segmented } from "../common";
import { MAX_ROLE_CARD_CHARS, roleCardProblem } from "./prefill";

type Mode = "upload" | "paste" | "note" | "url";
const MODES = [
  { id: "upload", label: "Upload", icon: "Upload" },
  { id: "paste", label: "Paste", icon: "ClipboardPaste" },
  { id: "note", label: "Note path", icon: "FileText" },
  { id: "url", label: "Link", icon: "Link" },
] as const;

const FIELD = "w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function RoleCardInput({ initial, onChange }: { initial?: RoleCard | null; onChange: (card: RoleCard | null, problem: string | null) => void }) {
  const [mode, setMode] = useState<Mode>(initial?.kind === "note" ? "note" : initial?.kind === "url" ? "url" : initial ? "paste" : "upload");
  const [text, setText] = useState(initial?.kind === "text" ? initial.value : "");
  const [title, setTitle] = useState<string | undefined>(initial?.kind === "text" ? initial.title : undefined);
  const [note, setNote] = useState(initial?.kind === "note" ? initial.value : "");
  const [url, setUrl] = useState(initial?.kind === "url" ? initial.value : "");
  const [fileError, setFileError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const cb = useRef(onChange);
  cb.current = onChange;

  const kind: "text" | "note" | "url" = mode === "note" ? "note" : mode === "url" ? "url" : "text";
  const value = kind === "note" ? note : kind === "url" ? url : text;
  const problem = value.trim() === "" ? null : roleCardProblem(kind, value);
  useEffect(() => {
    const card: RoleCard | null = value.trim() === "" || problem !== null ? null : { kind, value: value.trim(), ...(kind === "text" && title ? { title } : {}) };
    cb.current(card, problem ?? fileError);
  }, [kind, value, title, problem, fileError]);

  const onFile = async (picked: File | undefined) => {
    setFileError(null);
    if (!picked) return;
    if (!/\.(md|markdown|txt)$/i.test(picked.name) && !picked.type.startsWith("text/")) {
      setFileError("Upload a .md or .txt file.");
      return;
    }
    if (picked.size > MAX_ROLE_CARD_CHARS * 4) {
      setFileError(`That file is too large. The limit is ${MAX_ROLE_CARD_CHARS.toLocaleString("en-US")} characters.`);
      return;
    }
    const body = await picked.text();
    setText(body);
    setTitle(picked.name.slice(0, 120));
    setMode("paste");
  };

  return (
    <div className="space-y-2">
      <Segmented label="Role card source" value={mode} onChange={setMode} options={MODES} />
      {mode === "upload" ? (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="sr-only" aria-label="Role card file" onChange={(event) => void onFile(event.target.files?.[0])} />
          <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
            <Icon name="Upload" className="size-3.5" />Choose a .md or .txt file
          </Button>
          <span className="text-xs text-muted-foreground">Read in your browser; up to {MAX_ROLE_CARD_CHARS.toLocaleString("en-US")} characters.</span>
        </div>
      ) : null}
      {mode === "paste" ? (
        <div className="space-y-1">
          <textarea value={text} onChange={(event) => { setText(event.target.value); setTitle(undefined); }} rows={8} aria-label="Role card text" placeholder="Paste your role card or level description" className={`${FIELD} font-mono text-xs`} />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{title ? `From ${title}` : ""}</span>
            <span className={text.length > MAX_ROLE_CARD_CHARS ? "text-destructive" : ""}>{text.length.toLocaleString("en-US")} / {MAX_ROLE_CARD_CHARS.toLocaleString("en-US")}</span>
          </div>
        </div>
      ) : null}
      {mode === "note" ? (
        <div className="space-y-1">
          <input value={note} onChange={(event) => setNote(event.target.value)} aria-label="Role card note path" placeholder="Notes/Role card.md" className={FIELD} />
          <p className="text-[11px] text-muted-foreground">The agent opens this note with its own tools.</p>
        </div>
      ) : null}
      {mode === "url" ? (
        <div className="space-y-1">
          <input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Role card link" placeholder="https://…" className={FIELD} />
          <p className="text-[11px] text-muted-foreground">The agent fetches this page with its own tools, so it must be reachable from the capture host.</p>
        </div>
      ) : null}
      {problem ?? fileError ? <p role="alert" className="text-xs text-destructive">{problem ?? fileError}</p> : null}
    </div>
  );
}
