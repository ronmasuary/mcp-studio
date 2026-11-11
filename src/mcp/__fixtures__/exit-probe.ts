// A process that connects to the launcher fixture and then exits WITHOUT calling disconnect. The
// launcher ignores stdin closing, so only the "exit" hook in process-tree.ts can reap its tree.
// argv[2] is the launcher's pid file. Prints the launcher's pid tree as JSON on stdout.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect } from "../connect.js";
import { SessionRegistry } from "../registry.js";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("usage: exit-probe.ts <pid-file>");

const wrapper = fileURLToPath(new URL("./wrapper-server.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
await connect(
  "probe",
  { transport: "stdio", command: process.execPath, args: ["--import", "tsx", wrapper, pidFile], cwd: repoRoot },
  { registry: new SessionRegistry() },
);
while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
process.stdout.write(`${readFileSync(pidFile, "utf8")}\n`);
process.exit(0);
