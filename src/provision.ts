import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Handle } from "./backend";
import { config, SECRET_ENV } from "./config";
import { shq } from "./vendor/slaude/shell";

const MARK = ".provisioned";

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.includes(k)) out[k] = v;
  if (config.cloneSsh()) out.GIT_SSH_COMMAND = config.cloneSsh();
  return { ...out, GIT_TERMINAL_PROMPT: "0", ...extra };
}

async function run(argv: string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number; stderr: string }> {
  const p = Bun.spawn(argv, { cwd: o.cwd, env: o.env ?? cleanEnv(), stdout: "ignore", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs ?? 600_000);
  try {
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    return { code, stderr: stderr.trim() };
  } finally { clearTimeout(t); }
}

/** Raw bytes of a command's stdout (bundles and tars are binary). */
async function bytes(argv: string[], o: { cwd?: string; env?: Record<string, string> } = {}): Promise<Uint8Array> {
  const p = Bun.spawn(argv, { cwd: o.cwd, env: o.env ?? cleanEnv(), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${argv[0]} ${argv[1] ?? ""} failed: ${err.trim() || `exit ${code}`}`);
  return out;
}

export const repoName = (url: string) => basename(url).replace(/\.git$/, "");

/**
 * Server-side bare mirrors of the allowlisted repos, refreshed on a timer, plus the Go module
 * cache warmed from them. Sandboxes are seeded from here, so no clone credential ever leaves the server.
 */
export class Mirrors {
  #gosum = new Map<string, string>();
  #timer?: ReturnType<typeof setInterval>;
  constructor(readonly dir = config.mirrorsDir(), readonly repos = config.repos(), readonly gomod = config.gomodDir()) {}

  path(url: string) { return join(this.dir, `${repoName(url)}.git`); }

  async refresh(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const url of this.repos) {
      const p = this.path(url);
      const exists = await stat(p).then(() => true, () => false);
      const r = exists
        ? await run(["git", "-C", p, "fetch", "-q", "--prune", "origin", "+refs/heads/*:refs/heads/*"])
        : await run(["git", "clone", "-q", "--mirror", url, p]);
      if (r.code !== 0) { console.error(JSON.stringify({ at: "mirror", repo: url, error: r.stderr })); continue; }
      await this.#warmGo(url, p).catch((e) => console.error(JSON.stringify({ at: "gomod", repo: url, error: String(e) })));
    }
  }

  /** `go mod download` into the shared cache when a repo's go.sum set changed (go.work monorepos included). */
  async #warmGo(url: string, mirror: string): Promise<void> {
    const sums = await bytes(["git", "-C", mirror, "ls-tree", "-r", "HEAD", "--name-only"]).then((b) => new TextDecoder().decode(b));
    const files = sums.split("\n").filter((f) => f === "go.sum" || f.endsWith("/go.sum") || f === "go.work.sum");
    if (files.length === 0) return;
    const hash = createHash("sha256");
    for (const f of files) hash.update(await bytes(["git", "-C", mirror, "show", `HEAD:${f}`]));
    const digest = hash.digest("hex");
    if (this.#gosum.get(url) === digest) return;
    const work = join(this.dir, `.work-${repoName(url)}`);
    await rm(work, { recursive: true, force: true });
    const c = await run(["git", "clone", "-q", "--shared", "--depth", "1", mirror, work]);
    if (c.code !== 0) throw new Error(c.stderr);
    await mkdir(this.gomod, { recursive: true });
    const r = await run(["go", "mod", "download", "all"], {
      cwd: work,
      // go fetches private modules over https; rewrite to ssh so the clone key is used.
      env: cleanEnv({
        GOMODCACHE: this.gomod, GOFLAGS: "-mod=mod", GOPRIVATE: "bitbucket.org/Amartha", GONOSUMDB: "bitbucket.org/Amartha",
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.ssh://git@bitbucket.org/.insteadOf", GIT_CONFIG_VALUE_0: "https://bitbucket.org/",
      }),
      timeoutMs: 1_800_000,
    });
    await rm(work, { recursive: true, force: true });
    if (r.code !== 0) throw new Error(r.stderr);
    this.#gosum.set(url, digest);
  }

  start(everyMs = config.mirrorRefreshMs()) {
    this.#timer ??= setInterval(() => void this.refresh(), everyMs);
    return this;
  }
  stop() { clearInterval(this.#timer); this.#timer = undefined; }
}

/** Bytes of the plugin tree (`.claude/plugins` relative to its config dir), from a host dir or a pod. */
export async function pluginTar(): Promise<Uint8Array | null> {
  const dir = config.pluginDir();
  if (dir) return bytes(["tar", "-C", join(dir, "..", ".."), "-cz", ".claude/plugins"]);
  const sel = config.pluginSourceSelector();
  if (sel) {
    const ns = config.k8sNamespace();
    const pod = new TextDecoder().decode(await bytes(["kubectl", "-n", ns, "get", "pod", "-l", sel, "--field-selector=status.phase=Running", "-o", "jsonpath={.items[0].metadata.name}"]));
    if (!pod) throw new Error(`no running pod matches ${sel}`);
    return bytes(["kubectl", "-n", ns, "exec", pod, "--", "tar", "-C", "/data", "-cz", ".claude/plugins"]);
  }
  return null;
}

/**
 * Seed a fresh sandbox once: every mirrored repo as a bundle (no remote, factory identity),
 * the plugin tree at /data/.claude/plugins, the Go module cache with GOPROXY=off.
 * Idempotent: a marker file in the workspace skips it on reattach.
 */
export async function provision(h: Handle, m: Mirrors): Promise<void> {
  const mark = `${h.root}/${MARK}`;
  if ((await h.exec(`test -e ${shq(mark)}`, { timeoutMs: 30_000 })).code === 0) return;
  const t0 = performance.now();
  const check = (r: { code: number | null; stderr: string }, what: string) => { if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim() || `exit ${r.code}`}`); };

  for (const url of m.repos) {
    const dest = `${h.root}/${repoName(url)}`;
    const bundle = await bytes(["git", "-C", m.path(url), "bundle", "create", "-", "--all"]);
    const cmd = `t=$(mktemp) && cat > "$t" && rm -rf ${shq(dest)} && git clone -q "$t" ${shq(dest)} && rm -f "$t" && cd ${shq(dest)} ` +
      `&& git remote remove origin && git config user.name ${shq(config.gitUser())} && git config user.email ${shq(config.gitEmail())}`;
    check(await h.pipe(cmd, bundle), `clone ${repoName(url)}`);
  }

  const plugins = await pluginTar();
  if (plugins) check(await h.pipe("mkdir -p /data && tar -C /data -xz", plugins), "plugins");

  // ponytail: a shared read-only mount (docker SANDBOX_GOMOD_VOLUME) replaces the per-sandbox copy.
  const gomod = !config.gomodVolume() && await stat(m.gomod).then((s) => s.isDirectory(), () => false);
  if (gomod) {
    const tar = await bytes(["tar", "-C", m.gomod, "-cz", "."]);
    check(await h.pipe('mkdir -p "$HOME/go/pkg/mod" && tar -C "$HOME/go/pkg/mod" -xz', tar, 900_000), "go module cache");
  }

  check(await h.exec(`touch ${shq(mark)}`, { timeoutMs: 30_000 }), "mark");
  console.log(JSON.stringify({ at: "provision", root: h.root, repos: m.repos.length, plugins: !!plugins, gomod, ms: Math.round(performance.now() - t0) }));
}

/** The provisioner the backends call from ensure(); null when no repos are configured (tests, bare dev). */
export function makeProvisioner(): ((h: Handle) => Promise<void>) | null {
  if (config.repos().length === 0 && !config.pluginDir() && !config.pluginSourceSelector()) return null;
  const m = new Mirrors();
  const ready = m.refresh().then(() => { m.start(); });
  return async (h) => { await ready; await provision(h, m); };
}
