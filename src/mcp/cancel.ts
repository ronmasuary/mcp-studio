// In-flight call registry. The CLIENT generates the callId and sends it with the request; the
// server registers an AbortController under it BEFORE issuing tools/call. A server-minted id
// would be useless: POST /call does not resolve until the tool returns, so by the time the
// caller learned the id there would be nothing left to cancel.
import { randomUUID } from "node:crypto";
import { StudioError } from "./errors.js";

/** What a client calls to mint a callId. */
export function newCallId(): string {
  return randomUUID();
}

/** callId to AbortController for every call currently in flight. */
export class CallRegistry {
  private readonly inflight = new Map<string, AbortController>();

  /** Registers a call. Must happen BEFORE the request is issued. */
  register(callId: string): AbortController {
    if (!callId) throw new StudioError("duplicate_call", "callId must be a non-empty string");
    if (this.inflight.has(callId)) throw new StudioError("duplicate_call", `callId ${callId} is already in flight`);
    const controller = new AbortController();
    this.inflight.set(callId, controller);
    return controller;
  }

  release(callId: string): void {
    this.inflight.delete(callId);
  }

  has(callId: string): boolean {
    return this.inflight.has(callId);
  }

  get size(): number {
    return this.inflight.size;
  }

  /** Aborts an in-flight call. False when the callId is unknown or already finished. */
  cancel(callId: string): boolean {
    const controller = this.inflight.get(callId);
    if (!controller) return false;
    controller.abort(new StudioError("cancelled", `call ${callId} was cancelled`));
    return true;
  }
}

/** The process-wide registry callTool uses unless told otherwise. */
export const defaultCalls = new CallRegistry();

/** Cancels a call started with the default registry. This is what DELETE /call/:callId will use. */
export function cancelCall(callId: string): boolean {
  return defaultCalls.cancel(callId);
}
