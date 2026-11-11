// Killing a child process AND its descendants. On win32, kill('SIGTERM') is a hard terminate of
// that one pid and does not reach grandchildren, so an `npx some-server` (npx -> node -> server)
// leaks orphans. `taskkill /T /F` walks the tree. See ADR-0005.
import { spawnSync } from "node:child_process";

/** True while a process with this pid exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function descendants(pid: number): number[] {
  const res = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  const kids = (res.stdout ?? "").split(/\s+/).filter(Boolean).map(Number);
  return kids.flatMap((kid) => [...descendants(kid), kid]);
}

/**
 * Synchronously kills `pid` and everything below it. Safe on a dead or unknown pid. Synchronous
 * on purpose: it must work inside a process "exit" handler, where nothing async runs.
 */
export function killTree(pid: number | null | undefined): void {
  if (!pid || pid === process.pid || !isAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  for (const child of descendants(pid)) {
    try {
      process.kill(child, "SIGKILL");
    } catch {
      // already gone
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

const tracked = new Set<number>();
let hookInstalled = false;

/** Kills every tracked tree. Runs on process "exit" so a crashed or interrupted API leaves no orphans. */
export function killTracked(): void {
  for (const pid of tracked) killTree(pid);
  tracked.clear();
}

/** Remembers a spawned child so the exit hook can reap it. Installs the hook on first use. */
export function trackPid(pid: number): void {
  tracked.add(pid);
  if (!hookInstalled) {
    hookInstalled = true;
    process.on("exit", killTracked);
  }
}

export function untrackPid(pid: number | null | undefined): void {
  if (pid) tracked.delete(pid);
}

/** Pids currently tracked. For tests. */
export function trackedPids(): number[] {
  return [...tracked];
}
