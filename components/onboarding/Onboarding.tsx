// Zero-config setup. Three inputs (name, email, role card) and one button. The agent infers and applies everything else,
// then this page ends on a non-blocking "Here's what I figured out". There is no questionnaire.
import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import type { Profile, RoleCard, SetupProposal } from "../../lib/types";
import { Card, errorText, ErrorNote, useAsync } from "../common";
import type { SettingsSection } from "../settings/sections";
import { dismissFiguredOut } from "./dismiss";
import { FiguredOut } from "./FiguredOut";
import { connectedCount, prefillIdentity } from "./prefill";
import { RoleCardInput } from "./RoleCardInput";
import { progressLine, useSetupRun } from "./useSetupRun";

const CHECK_POLL_MS = 4000;
const CHECK_GIVE_UP_MS = 12 * 60_000;
const FIELD = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const EMPTY_INFERRED = { level: null, scope: null, managerName: null, reviewCadence: null, basis: {} } as const;

type Existing = { profile: Profile | null; proposal: SetupProposal | null; kept?: readonly string[] };

export function Onboarding({ onEdit, onClose }: { onEdit?: (section: SettingsSection) => void; onClose?: () => void } = {}) {
  const rpc = useRpc<RpcContract>();
  const run = useSetupRun();
  const connectors = useAsync(() => rpc.call("connectors.get"), []);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const touched = useRef({ name: false, email: false });
  const [card, setCard] = useState<RoleCard | null>(null);
  const [cardProblem, setCardProblem] = useState<string | null>(null);
  const [existing, setExisting] = useState<Existing>({ profile: null, proposal: null });
  const [result, setResult] = useState<Existing | null>(null);
  const [closed, setClosed] = useState(false);
  const openedAt = useRef(Date.now());
  const check = connectors.data?.check ?? null;
  const fresh = check !== null && Date.parse(check.checkedAt) >= openedAt.current - 2000;
  const [checking, setChecking] = useState(true);

  // Run the connector check once, on open.
  useEffect(() => {
    rpc.call("connectors.check").catch((cause: unknown) => {
      setCheckError(errorText(cause));
      setChecking(false);
    });
  }, [rpc]);
  // Poll connectors.get until the new check lands (the realtime channel usually gets there first).
  useEffect(() => {
    if (!checking) return;
    if (fresh) {
      setChecking(false);
      return;
    }
    const poll = setInterval(connectors.reload, CHECK_POLL_MS);
    const giveUp = setTimeout(() => setChecking(false), CHECK_GIVE_UP_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [checking, fresh, connectors.reload]);

  // Resume: a stored profile prefills the form; a run already in flight shows its progress.
  useEffect(() => {
    rpc.call("setup.get").then(
      (state) => {
        setExisting({ profile: state.profile, proposal: state.proposal });
        if (state.profile) {
          if (!touched.current.name) setName(state.profile.identity.name);
          if (!touched.current.email) setEmail(state.profile.identity.email ?? "");
          if (state.profile.roleCard) {
            setCard(state.profile.roleCard);
          }
        }
        if (state.status === "running") run.resume();
      },
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc]);

  // Prefill from the connector accounts when they agree, unless the user already typed.
  const prefill = prefillIdentity(check);
  useEffect(() => {
    if (!touched.current.name && name === "" && prefill.name !== "") setName(prefill.name);
    if (!touched.current.email && email === "" && prefill.email !== "") setEmail(prefill.email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill.name, prefill.email]);

  // When the run is applied, read back what the agent decided.
  useEffect(() => {
    if (run.phase !== "applied") return;
    rpc.call("setup.get").then((state) => setResult({ profile: state.profile, proposal: state.proposal, kept: state.kept }), (cause: unknown) => setCheckError(errorText(cause)));
  }, [run.phase, rpc]);

  const canRun = name.trim() !== "" && card !== null && cardProblem === null && run.phase !== "running";
  const figureItOut = () => {
    const handles = { ...prefill.handles, ...(existing.profile?.identity.handles ?? {}) };
    const profile: Profile = {
      version: 1,
      identity: { name: name.trim(), email: email.trim() === "" ? null : email.trim(), handles },
      roleCard: card,
      inferred: existing.profile?.inferred ?? { ...EMPTY_INFERRED, basis: {} },
      setupAt: existing.profile?.setupAt ?? null,
    };
    void run.start(profile);
  };
  const close = () => {
    dismissFiguredOut(result?.profile?.setupAt ?? null);
    setClosed(true);
    onClose?.();
  };

  if (run.phase === "applied" && result?.profile && result.proposal && !closed) {
    return (
      <div className="space-y-4">
        <FiguredOut profile={result.profile} proposal={result.proposal} note={run.note} kept={result.kept} onEdit={(section) => onEdit?.(section)} onClose={close} />
      </div>
    );
  }
  if (closed) return null;

  const counts = connectedCount(check);
  return (
    <div className="space-y-4">
      <Card title="Set up Paper Trail" aside="Tell it who you are and give it your role card. It works out your level, areas, work split, guardrails and goals itself, and you can change any of it afterwards.">
        <p className="mb-3 text-xs text-muted-foreground" role="status">
          {checkError
            ? `Could not check your connectors: ${checkError}`
            : checking
              ? "Checking which of your tools it can reach…"
              : check === null
                ? "No connector check yet."
                : `${counts.found} of ${counts.total} sources reachable${check.hostName ? ` on ${check.hostName}` : ""}.`}
        </p>
        <fieldset disabled={run.phase === "running"} className="space-y-3 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Name</span>
              <input value={name} onChange={(e) => { touched.current.name = true; setName(e.target.value); }} className={FIELD} placeholder="As it appears in meeting transcripts" autoComplete="name" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Email</span>
              <input value={email} onChange={(e) => { touched.current.email = true; setEmail(e.target.value); }} className={FIELD} placeholder="you@example.com" autoComplete="email" inputMode="email" />
            </label>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium">Role card</span>
            <RoleCardInput key={existing.profile ? "loaded" : "empty"} initial={existing.profile?.roleCard ?? null} onChange={(c, problem) => { setCard(c); setCardProblem(problem); }} />
          </div>
        </fieldset>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={!canRun} onClick={figureItOut}>
            <Icon name={run.phase === "running" ? "Loader" : "Sparkles"} className="size-3.5" />
            {run.phase === "failed" ? "Try again" : "Figure it out"}
          </Button>
          {run.phase === "running" ? (
            <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {progressLine(run.seconds)} <span className="tabular-nums">({run.seconds}s)</span>
            </span>
          ) : null}
        </div>
        <div className="mt-3">
          <ErrorNote message={run.phase === "failed" ? `Setup did not finish: ${run.error ?? "unknown error"}` : null} />
        </div>
      </Card>
    </div>
  );
}
