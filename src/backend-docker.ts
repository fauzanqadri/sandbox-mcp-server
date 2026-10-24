import { cliExec, wrap, type Backend, type Handle } from "./backend";
import { config } from "./config";
import { makeProvisioner } from "./provision";
import type { ExecOpts } from "./vendor/slaude/types";

const CLI_TIMEOUT = 120_000;
/** Tool commands always run as the sandbox user, also when the container itself starts as root.
 *  The bare uid (not uid:gid) makes `docker exec` add the user's groups, so `docker` reaches the
 *  inner daemon's socket under Sysbox. */
const EXEC_USER = "1000";
const RUN_USER = "1000:1000";

/**
 * `docker run` arguments for one sandbox. Default: uid 1000, every capability dropped, no
 * new privileges. With a runtime such as `sysbox-runc` the container starts as root so the
 * image's init can start its own dockerd (Sysbox maps that root to an unprivileged host user),
 * gets a third volume for /var/lib/docker, and tool commands still run as uid 1000.
 */
export function runArgs(key: string, o: {
  root: string; image: string; gomodVolume?: string; runtime?: string; memory?: string; cpus?: string;
}): string[] {
  const n = `sbx-${key}`;
  const isolation = o.runtime
    ? ["--runtime", o.runtime, "--user", "0:0", "-v", `${n}-docker:/var/lib/docker`]
    : ["--user", RUN_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
  return [
    "run", "-d", "--name", n, "--label", `sandbox.session=${key}`,
    ...isolation, "--pids-limit", o.runtime ? "4096" : "512",
    ...(o.memory ? ["--memory", o.memory, "--memory-swap", o.memory] : []),
    ...(o.cpus ? ["--cpus", o.cpus] : []),
    "-e", `HOME=${o.root}/.home`, "-e", "CLAUDE_CONFIG_DIR=/data/.claude", "-e", "GOPROXY=off", "-e", "GOFLAGS=-mod=mod", "-e", "GONOSUMDB=*",
    "-v", `${n}-ws:${o.root}`, "-v", `${n}-data:/data`, "-w", o.root,
    ...(o.gomodVolume ? ["-v", `${o.gomodVolume}:/gomod:ro`, "-e", "GOMODCACHE=/gomod"] : []),
    // sandbox-init starts dockerd when root (Sysbox); older images lack it, so only Sysbox needs it.
    o.image, ...(o.runtime ? ["sandbox-init"] : ["sleep", "infinity"]),
  ];
}

/** Every named volume one sandbox owns. */
export const volumesOf = (key: string) => [`sbx-${key}-ws`, `sbx-${key}-data`, `sbx-${key}-docker`];

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
      docker(["exec", "-i", "-u", EXEC_USER, name(key), ...wrap(cmd, o)], { timeoutMs: o.timeoutMs, stdin: o.stdin === undefined ? undefined : Buffer.from(o.stdin), maxOutput: o.maxOutput }),
    pipe: (cmd, stdin, timeoutMs = 300_000) =>
      docker(["exec", "-i", "-u", EXEC_USER, name(key), "/bin/sh", "-c", cmd], { timeoutMs, stdin }),
  });

  return {
    async ensure(key) {
      const n = name(key);
      const st = await docker(["inspect", "-f", "{{.State.Running}}", n]);
      if (st.code !== 0) {
        const runtime = config.dockerRuntime();
        for (const v of volumesOf(key).slice(0, runtime ? 3 : 2)) await docker(["volume", "create", "--label", `sandbox.session=${key}`, v]);
        const r = await docker(runArgs(key, {
          root, image: config.image(), gomodVolume: config.gomodVolume() || undefined,
          runtime: runtime || undefined, memory: config.dockerMemory() || undefined, cpus: config.dockerCpus() || undefined,
        }), { timeoutMs: 600_000 });
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
      await docker(["volume", "rm", "-f", ...volumesOf(key)]);
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
