#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// MiniMax Code runs on both Windows and Linux/cloud environments.  Python's
// conventional command name differs across those platforms, while Node is the
// common runtime used by MiniMax Code itself.  Keep the business bridge in
// Python 3.8+ stdlib and centralize only this interpreter-name difference here.
const root = dirname(fileURLToPath(import.meta.url));
const python = process.platform === "win32" ? "python" : "python3";
const child = spawn(python, [join(root, "bridge.py"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});

let settled = false;
child.once("error", (error) => {
  if (settled) return;
  settled = true;
  process.stderr.write(
    `webagenttools-home: failed to launch ${python}: ${error.message}\n`,
  );
  process.exitCode = 127;
});
child.once("exit", (code, signal) => {
  if (settled) return;
  settled = true;
  if (signal) {
    process.stderr.write(
      `webagenttools-home: Python bridge exited from signal ${signal}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // Child may already be gone; its exit/error handler owns final status.
    }
  });
}
