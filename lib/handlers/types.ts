/**
 * handlers/types.ts — shared types for lib/handlers/*.ts. Each handler module exports
 * `handlers(ctx, service, env)` and returns the contract methods it owns, typed from the contract so the
 * compiler checks input and output shapes. server.ts spreads all of them into `bb.rpc.register`.
 */
import type { z } from "zod";
import type { rpcContract } from "../contract";
import type { FeatureCtx } from "../engine/extensions";
import type { WorkerPort } from "../engine/runner";
import type { WorklogService } from "../engine/service";
import type { PingResult } from "../worker";

type Contract = typeof rpcContract;
export type RpcMethod = keyof Contract & string;
export type RpcIn<M extends RpcMethod> = z.output<Contract[M]["input"]>;
export type RpcOut<M extends RpcMethod> = z.input<Contract[M]["output"]>;
export type RpcHandler<M extends RpcMethod> = (input: RpcIn<M>) => RpcOut<M> | Promise<RpcOut<M>>;
export type RpcHandlers = { [M in RpcMethod]: RpcHandler<M> };
/** The handlers one module owns. */
export type HandlerGroup<K extends RpcMethod> = { [M in K]: RpcHandler<M> };

/** Things only server.ts can build (SDK-backed); passed as the third argument. */
export interface HandlerEnv {
  /** bb hosts (machines) for the connectors UI. */
  hosts(): Promise<Array<{ id: string; name: string; connected: boolean }>>;
  /** The worker (a `WorkerPort` plus `ping`), for one-off agent jobs outside the runner pool. */
  /** Turns the plugin's "Scheduled capture" setting on (setup.apply). Absent when the host cannot write settings. */
  enableSchedule?: () => Promise<void>;
  worker: WorkerPort & { ping(): Promise<PingResult> };
}

export type HandlersFn<K extends RpcMethod> = (ctx: FeatureCtx, service: WorklogService, env: HandlerEnv) => HandlerGroup<K>;

export const notImplemented = (): never => {
  throw new Error("not implemented");
};
