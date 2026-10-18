import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliExec, type Backend, type Handle } from "./backend";

/** A directory per session on this machine. Tests and development only: no isolation. */
export function localBackend(base = join(tmpdir(), "sandbox-mcp")): Backend {
  const dir = (key: string) => join(base, `sbx-${key}`);
  const handle = (root: string): Handle => {
    const env = { ...process.env, HOME: root };
    return {
      root,
      exec: (cmd, o) => cliExec([o.login ? "bash" : "/bin/sh", o.login ? "-lc" : "-c", cmd], { timeoutMs: o.timeoutMs, maxOutput: o.maxOutput, stdin: o.stdin, cwd: root, env }),
      pipe: (cmd, stdin, timeoutMs = 300_000) => cliExec(["/bin/sh", "-c", cmd], { timeoutMs, stdin, cwd: root, env }),
    };
  };
  return {
    async ensure(key) {
      await mkdir(dir(key), { recursive: true });
      return handle(dir(key));
    },
    async stop() {},
    async destroy(key) { await rm(dir(key), { recursive: true, force: true }); },
    async list() {
      const { readdir } = await import("node:fs/promises");
      return (await readdir(base).catch(() => [] as string[])).filter((n) => n.startsWith("sbx-")).map((n) => n.slice(4));
    },
  };
}
