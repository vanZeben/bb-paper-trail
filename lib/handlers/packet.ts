/** handlers/packet.ts — packet.build, packet.markdown, packet.narrative.start, packet.writeNote. Logic in lib/features/packet. */
import { loadPacket, narrativeStatus, packetDoc, startNarrative, writeNote } from "../features/packet/service";
import type { HandlersFn } from "./types";

type Methods = "packet.build" | "packet.markdown" | "packet.narrative.start" | "packet.writeNote";

export const handlers: HandlersFn<Methods> = (ctx, _service, _env) => ({
  "packet.build": async ({ from, to }) => ({ ...(await loadPacket(ctx, { from, to })), narrativeStatus: await narrativeStatus(ctx, { from, to }) }),
  "packet.markdown": ({ from, to, includeNarrative }) => packetDoc(ctx, { from, to }, includeNarrative),
  "packet.narrative.start": ({ from, to }) => {
    startNarrative(ctx, { from, to });
    return { ok: true as const };
  },
  "packet.writeNote": async ({ from, to, path }) => {
    await writeNote(ctx, { from, to }, path);
    return { ok: true as const };
  },
});
