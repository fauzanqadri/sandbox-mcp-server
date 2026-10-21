import { cliExec, wrap, type Backend, type Handle } from "./backend";
import { config } from "./config";
import { makeProvisioner } from "./provision";
import type { ExecOpts } from "./vendor/slaude/types";

const CLI_TIMEOUT = 120_000;

/**
 * A container per session. `docker` talks to the local socket, or over SSH to a VPS
 * (`vps`: DOCKER_HOST=ssh://user@host, the key in this pod's ~/.ssh). Two named volumes per
 * session carry the workspace and the plugin tree across stop/start.
 */
export function dockerBackend(kind: "docker" | "vps"): Backend {
  const env: Record<string, string | undefined> = { ...process.env };
  if (kind === "vps") env.DOCKER_HOST = `ssh://${config.vpsHost()}`;
  else if (config.dockerHost()) env.DOCKER_HOST = config.dockerHost();
  const root = config.root();
  const provision = makeProvisioner();
  const name = (key: string) => `sbx-${key}`;
  const docker = (args: string[], o: { timeoutMs?: number; stdin?: Uint8Array; maxOutput?: number } = {}) =>
    cliExec(["docker", ...args], { timeoutMs: o.timeoutMs ?? CLI_TIMEOUT, stdin: o.stdin, maxOutput: o.maxOutput, env });

  const handle = (key: string): Handle => ({
    root,
    exec: (cmd, o: ExecOpts) =>
      docker(["exec", "-i", name(key), ...wrap(cmd, o)], { timeoutMs: o.timeoutMs, stdin: o.stdin === undefined ? undefined : Buffer.from(o.stdin), maxOutput: o.maxOutput }),
    pipe: (cmd, stdin, timeoutMs = 300_000) =>
      docker(["exec", "-i", name(key), "/bin/sh", "-c", cmd], { timeoutMs, stdin }),
  });

  return {
    async ensure(key) {
      const n = name(key);
      const st = await docker(["inspect", "-f", "{{.State.Running}}", n]);
      if (st.code !== 0) {
        for (const v of [`${n}-ws`, `${n}-data`]) await docker(["volume", "create", "--label", `sandbox.session=${key}`, v]);
        const r = await docker([
          "run", "-d", "--name", n, "--label", `sandbox.session=${key}`,
          "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
          "-e", `HOME=${root}/.home`, "-e", "CLAUDE_CONFIG_DIR=/data/.claude", "-e", "GOPROXY=off", "-e", "GOFLAGS=-mod=mod", "-e", "GONOSUMDB=*",
          "-v", `${n}-ws:${root}`, "-v", `${n}-data:/data`, "-w", root,
          ...(config.gomodVolume() ? ["-v", `${config.gomodVolume()}:/gomod:ro`, "-e", "GOMODCACHE=/gomod"] : []),
          config.image(), "sleep", "infinity",
        ], { timeoutMs: 600_000 });
        if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr}`);
      } else if (st.stdout.trim() !== "true") {
        const r = await docker(["start", n]);
        if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
      }
      const h = handle(key);
      await h.exec(`mkdir -p "$HOME"`, { timeoutMs: 30_000 });
      if (provision) await provision(h);
      return h;
    },
    async stop(key) { await docker(["stop", "-t", "5", name(key)]); },
    async destroy(key) {
      await docker(["rm", "-f", name(key)]);
      await docker(["volume", "rm", "-f", `${name(key)}-ws`, `${name(key)}-data`]);
    },
    async list() {
      const r = await docker(["ps", "-a", "--filter", "label=sandbox.session", "--format", "{{.Label \"sandbox.session\"}}"]);
      return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    },
    async reap(olderThanMs) {
      // Stopped containers whose last exit is older than the keep window.
      const r = await docker(["ps", "-a", "--filter", "label=sandbox.session", "--filter", "status=exited", "--format", "{{.Label \"sandbox.session\"}}"]);
      const gone: string[] = [];
      for (const key of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
        const at = await docker(["inspect", "-f", "{{.State.FinishedAt}}", name(key)]);
        const t = Date.parse(at.stdout.trim());
        if (Number.isFinite(t) && Date.now() - t > olderThanMs) { await this.destroy(key); gone.push(key); }
      }
      return gone;
    },
  };
}
