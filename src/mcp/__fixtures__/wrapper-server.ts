// Stands in for `npx some-server`: a launcher that spawns the real server as a grandchild, plus a
// second grandchild that only a process-TREE kill can reach. Unlike a well-behaved server it
// does NOT exit when stdin closes, which is how a hung launcher behaves.
//
// argv[2] is a file this process writes its pid tree to, as JSON.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("usage: wrapper-server.ts <pid-file>");

const echo = fileURLToPath(new URL("./echo-server.ts", import.meta.url));
// stdio inherited: the grandchild speaks MCP over the same pipes the client opened.
const server = spawn(process.execPath, ["--import", "tsx", echo], { stdio: "inherit" });
// detached: on Windows libuv puts ordinary children in a kill-on-close job object, so they die
// with their parent anyway. A detached child escapes that, which is what an orphaned grandchild
// of a non-node launcher (cmd.exe, python) looks like, and only a tree kill reaches it.
const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
sleeper.unref();

writeFileSync(pidFile, JSON.stringify({ wrapper: process.pid, server: server.pid, sleeper: sleeper.pid }));
setInterval(() => {}, 1000);
