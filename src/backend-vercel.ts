import { Readable } from "node:stream";
import { Sandbox } from "@vercel/sandbox";
import { wrap, type Backend, type Handle } from "./backend";
import { config } from "./config";
import { makeProvisioner } from "./provision";
import type { ExecOpts, ExecResult } from "./vendor/slaude/types";

/**
 * A Vercel Sandbox (persistent microVM) per session. Credentials come from VERCEL_TOKEN,
 * VERCEL_TEAM_ID and VERCEL_PROJECT_ID. Persistence is Vercel's: stop() snapshots the
 * filesystem and the next runCommand resumes it, so there is no bundle-out on idle.
 * Unverified until step 6 runs: the SDK under Bun, the plan's max timeout, a custom image with /workspace and uid 1000.
 */
export function vercelBackend(): Backend {
  const root = config.root();
  const provision = makeProvisioner();
  const name = (key: string) => `sbx-${key}`;
  const boxes = new Map<string, Sandbox>();

  const get = async (key: string): Promise<Sandbox> => {
    let s = boxes.get(key);
    if (!s) {
      s = await Sandbox.getOrCreate({
        name: name(key),
        ...(config.vercelImage() ? { image: config.vercelImage() } : { runtime: "node22" as const }),
        resources: { vcpus: config.vercelVcpus() },
        timeout: config.vercelTimeoutMs(),
        snapshotExpiration: config.keepMs(),
        keepLastSnapshots: { count: 1 },
        env: { HOME: `${root}/.home`, CLAUDE_CONFIG_DIR: "/data/.claude", GOPROXY: "off", GOFLAGS: "-mod=mod", GONOSUMDB: "*" },
      } as any);
      boxes.set(key, s);
    }
    return s;
  };

  const run = async (s: Sandbox, argv: string[], o: { timeoutMs: number; stdin?: string | Uint8Array; maxOutput?: number }): Promise<ExecResult> => {
    const t0 = Date.now();
    const cmd = await s.runCommand({
      cmd: argv[0]!,
      args: argv.slice(1),
      cwd: root,
      ...(o.stdin !== undefined ? { stdin: Readable.from([Buffer.from(o.stdin)]) } : {}),
    } as any);
    const [stdout, stderr] = await Promise.all([cmd.output("stdout"), cmd.output("stderr")]);
    const max = o.maxOutput ?? 30_000;
    // The sandbox-side `timeout` wrapper is the kill; a null exit after the deadline reads as a timeout.
    const timedOut = cmd.exitCode === null && Date.now() - t0 >= o.timeoutMs;
    return { stdout: stdout.slice(0, max), stderr: stderr.slice(0, max), code: cmd.exitCode, truncated: stdout.length > max || stderr.length > max, timedOut };
  };

  const handle = (key: string): Handle => ({
    root,
    exec: async (cmd, o: ExecOpts) => run(await get(key), wrap(cmd, o), { timeoutMs: o.timeoutMs, stdin: o.stdin, maxOutput: o.maxOutput }),
    pipe: async (cmd, stdin, timeoutMs = 300_000) => run(await get(key), ["/bin/sh", "-c", cmd], { timeoutMs, stdin }),
  });

  return {
    async ensure(key) {
      const s = await get(key);
      await run(s, ["/bin/sh", "-c", `mkdir -p ${root}/.home /data`], { timeoutMs: 30_000 });
      const h = handle(key);
      if (provision) await provision(h);
      return h;
    },
    async stop(key) {
      const s = boxes.get(key) ?? (await Sandbox.get({ name: name(key) }).catch(() => null));
      boxes.delete(key);
      await s?.stop();
    },
    async destroy(key) {
      const s = boxes.get(key) ?? (await Sandbox.get({ name: name(key) }).catch(() => null));
      boxes.delete(key);
      await s?.delete();
    },
    async list() {
      const out: string[] = [];
      for await (const s of await Sandbox.list({ namePrefix: "sbx-" } as any)) out.push(String((s as any).name ?? "").slice(4));
      return out.filter(Boolean);
    },
    // ponytail: no reap; snapshotExpiration = keep-days lets Vercel expire idle sandboxes itself.
  };
}
