import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../lib/contract";
import { errorText } from "../common";

export type RunInput =
  | { kind: "day"; date: string }
  | { kind: "week"; week: string; recapture: boolean }
  | { kind: "backfill"; weeks: number; force: boolean }
  | { kind: "fill_gaps"; weeks: number };

/** Start a capture/rating run. Returns at once (progress arrives on the realtime channel); failures go to `onError`. */
export function useRun(onError: (message: string | null) => void) {
  const rpc = useRpc<RpcContract>();
  return async (input: RunInput) => {
    onError(null);
    try {
      await rpc.call("run.start", input);
    } catch (cause) {
      onError(errorText(cause));
    }
  };
}
