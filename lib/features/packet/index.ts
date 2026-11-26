import type { Registry } from "../../engine/extensions";

/** The review packet has no hooks: it is built on demand from stored records (see ./service). */
export function register(_reg: Registry): void {}
