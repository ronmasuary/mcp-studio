// serverId to connection state. Owned by the long-lived API process, so connections survive a
// browser refresh. All four statuses are reachable, because the UI renders all four.
import { StudioError, errorMessage, isStudioError, type ErrorKind } from "./errors.js";
import type { ServerConfig } from "./server-config.js";
import { closeSession, dropError, type Session } from "./session.js";

export type ServerStatus = "connected" | "connecting" | "failed" | "disconnected";

export interface RegistryError {
  kind: ErrorKind;
  message: string;
}

export interface RegistryEntry {
  config: ServerConfig;
  status: ServerStatus;
  session?: Session;
  lastError?: RegistryError;
}

function toRegistryError(err: unknown): RegistryError {
  return isStudioError(err)
    ? { kind: err.kind, message: err.message }
    : { kind: "initialize_failed", message: errorMessage(err) };
}

export class SessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  has(serverId: string): boolean {
    return this.entries.has(serverId);
  }

  get(serverId: string): RegistryEntry | undefined {
    return this.entries.get(serverId);
  }

  list(): { serverId: string; entry: RegistryEntry }[] {
    return [...this.entries].map(([serverId, entry]) => ({ serverId, entry }));
  }

  /** Records a definition without connecting. Status is `disconnected`. Replaces a non-live entry. */
  define(serverId: string, config: ServerConfig): RegistryEntry {
    const existing = this.entries.get(serverId);
    if (existing && (existing.status === "connected" || existing.status === "connecting")) {
      throw new StudioError("already_connected", `"${serverId}" is ${existing.status}; disconnect it first`);
    }
    const entry: RegistryEntry = { config, status: "disconnected" };
    this.entries.set(serverId, entry);
    return entry;
  }

  /** connecting. Refuses a serverId that is already connected or connecting. */
  begin(serverId: string, config: ServerConfig): RegistryEntry {
    this.define(serverId, config);
    const entry = this.entries.get(serverId)!;
    entry.status = "connecting";
    return entry;
  }

  /** connected. If the transport later drops without a disconnect(), the entry becomes disconnected with lastError. */
  attach(serverId: string, session: Session): void {
    const entry = this.entries.get(serverId);
    if (!entry) throw new StudioError("not_connected", `"${serverId}" is not registered`);
    entry.status = "connected";
    entry.session = session;
    delete entry.lastError;
    const onClose = (closed: Session): void => {
      if (entry.session !== closed) return;
      entry.status = "disconnected";
      delete entry.session;
      if (!closed.closing) entry.lastError = toRegistryError(dropError(closed));
    };
    session.closeListeners.add(onClose);
    // The transport may have dropped between initialize and now.
    if (session.closed) onClose(session);
  }

  /** failed. */
  fail(serverId: string, err: unknown): void {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    entry.status = "failed";
    delete entry.session;
    entry.lastError = toRegistryError(err);
  }

  /** The live session, or a not_connected StudioError that carries the registry's reason. */
  requireSession(serverId: string): Session {
    const entry = this.entries.get(serverId);
    if (!entry) throw new StudioError("not_connected", `"${serverId}" is not registered`);
    if (entry.status !== "connected" || !entry.session) {
      const why = entry.lastError ? `: ${entry.lastError.message}` : "";
      throw new StudioError("not_connected", `"${serverId}" is ${entry.status}${why}`);
    }
    return entry.session;
  }

  /** Closes the session, keeps the definition. Status becomes `disconnected`. No-op when not live. */
  async disconnect(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    const session = entry.session;
    entry.status = "disconnected";
    delete entry.session;
    delete entry.lastError;
    if (session) await closeSession(session);
  }

  /** Disconnects, then forgets the definition. */
  async remove(serverId: string): Promise<void> {
    await this.disconnect(serverId);
    this.entries.delete(serverId);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.disconnect(id)));
  }
}

/** The process-wide registry the API layer uses. Tests construct their own. */
export const defaultRegistry = new SessionRegistry();
