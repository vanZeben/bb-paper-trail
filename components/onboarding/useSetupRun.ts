// Drives "Figure it out": saves identity + role card (setup.answer), starts the synthesis (setup.synthesize) and polls
// setup.get until it settles. The agent applies its own result, so "applied" means everything is already in place.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../lib/contract";
import type { Profile } from "../../lib/types";
import { errorText } from "../common";

export type RunPhase = "idle" | "running" | "applied" | "failed";
const POLL_MS = 2000;
const GIVE_UP_MS = 25 * 60_000;

/** A calm one-line status for how long the run has taken. */
export function progressLine(seconds: number): string {
  if (seconds < 10) return "Reading your role card…";
  if (seconds < 40) return "Looking for patterns in your calendar and tools…";
  if (seconds < 100) return "Drafting your areas, work split, guardrails and goals…";
  return "Still working. This can take a few minutes; you can leave this page open.";
}

export function useSetupRun() {
  const rpc = useRpc<RpcContract>();
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);

  const begin = useCallback((from = Date.now()) => {
    setPhase("running");
    setError(null);
    setNote(null);
    setSince(from);
    setSeconds(Math.max(0, Math.round((Date.now() - from) / 1000)));
  }, []);

  /** Save the profile, start the run. Failures land in `error` with phase "failed". */
  const start = useCallback(
    async (profile: Profile) => {
      begin();
      try {
        await rpc.call("setup.answer", { profile });
        await rpc.call("setup.synthesize");
      } catch (cause) {
        setPhase("failed");
        setError(errorText(cause));
      }
    },
    [rpc, begin],
  );

  useEffect(() => {
    if (phase !== "running" || since === null) return;
    const tick = setInterval(() => setSeconds(Math.round((Date.now() - since) / 1000)), 1000);
    const poll = setInterval(() => {
      if (Date.now() - since > GIVE_UP_MS) {
        setPhase("failed");
        setError("Setup is taking much longer than expected. Check that your capture host is online, then try again.");
        return;
      }
      rpc.call("setup.get").then(
        (state) => {
          if (state.status === "applied") {
            setNote(state.error);
            setPhase("applied");
          } else if (state.status === "failed") {
            setError(state.error ?? "Setup failed.");
            setPhase("failed");
          }
        },
        () => undefined, // a missed poll is not a failure; the next one tries again
      );
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [phase, since, rpc]);

  return { phase, error, note, seconds, start, resume: begin };
}
