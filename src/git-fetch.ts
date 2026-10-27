// The inbound half of git_push: bring branches from the server-side mirror into the sandbox.
// The mirror is refreshed with the clone key here; the sandbox receives a bundle over stdin and
// never sees a remote or a credential. Fetched refs land under refs/remotes/mirror/<branch>.
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "./config";
import { bytes, run } from "./provision";
import { shq } from "./vendor/slaude/shell";
import { fail, ok, resolveRemotePath, type FileCtx, type ToolText } from "./vendor/slaude/tools/files";

/** Branch names only: the server builds every refspec, the model names the branch. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_REFS = 20;
/** The on-demand mirror refresh is best effort; a slow Bitbucket must not hang the turn. */
const REFRESH_TIMEOUT_MS = 60_000;

export interface FetchCtx extends Pick<FileCtx, "exec" | "root"> {
  pipe(cmd: string, stdin: Uint8Array, timeoutMs?: number): Promise<{ code: number | null; stderr: string }>;
}

/** Where a repo's mirror lives and how to refresh it; injected so tests run without SANDBOX_REPOS. */
export interface MirrorSource {
  path(repoName: string): string;
  /** Fetch the mirror from its origin; resolves to an error message, or null when it refreshed. */
  refresh(repoName: string): Promise<string | null>;
}

export const defaultMirrorSource: MirrorSource = {
  path: (name) => join(config.mirrorsDir(), `${name}.git`),
  async refresh(name) {
    const r = await run(["git", "-C", this.path(name), "fetch", "-q", "--prune", "origin", "+refs/heads/*:refs/heads/*"], { timeoutMs: REFRESH_TIMEOUT_MS });
    return r.code === 0 ? null : r.stderr || `exit ${r.code}`;
  },
};

function badRef(b: string): boolean {
  return !REF.test(b) || b.includes("..") || b.includes("//") || b.includes("@{") || b.endsWith("/") || b.endsWith(".lock");
}

export async function gitFetchTool(c: FetchCtx, i: { refs: string[]; dir?: string }, m: MirrorSource = defaultMirrorSource): Promise<ToolText> {
  const refs = [...new Set(i.refs.map((r) => r.trim()).filter(Boolean))];
  if (refs.length === 0) return fail("refs must name at least one branch, e.g. [\"master\"].");
  if (refs.length > MAX_REFS) return fail(`at most ${MAX_REFS} refs per call.`);
  const bad = refs.filter(badRef);
  if (bad.length) return fail(`refs must be branch names (no refs/ prefix, no ..): ${bad.join(", ")}`);
  let dir: string;
  try {
    dir = resolveRemotePath(c.root, i.dir ?? ".");
  } catch (e) {
    return fail((e as Error).message);
  }

  const top = await c.exec(`cd ${shq(dir)} && git rev-parse --show-toplevel`, { timeoutMs: 30_000 });
  if (top.code !== 0 || !top.stdout.trim()) return fail(`${dir} is not inside a git repository in the sandbox.`);
  const repo = top.stdout.trim();
  const name = basename(repo);
  const mirror = m.path(name);
  if (!(await stat(mirror).then((s) => s.isDirectory(), () => false))) {
    return fail(`no mirror for ${name} on this server (mirrors exist only for SANDBOX_REPOS). Nothing was fetched.`);
  }

  const refreshError = await m.refresh(name);
  const missing: string[] = [];
  for (const r of refs) {
    const v = await run(["git", "-C", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${r}^{commit}`], { timeoutMs: 30_000 });
    if (v.code !== 0) missing.push(r);
  }
  if (missing.length) {
    return fail(`not on the mirror of ${name}: ${missing.join(", ")}.` + (refreshError ? ` The mirror refresh also failed (${refreshError}), so a branch pushed in the last ${config.mirrorRefreshMs() / 60_000} minutes may be missing.` : " Was it pushed under that name?"));
  }

  const bundle = await bytes(["git", "-C", mirror, "bundle", "create", "-", ...refs.map((r) => `refs/heads/${r}`)]);
  const specs = refs.map((r) => shq(`+refs/heads/${r}:refs/remotes/mirror/${r}`)).join(" ");
  const cmd = `t=$(mktemp) && cat > "$t" && cd ${shq(repo)} && git fetch -q "$t" ${specs}; s=$?; rm -f "$t"; exit $s`;
  const fetched = await c.pipe(cmd, bundle, 300_000);
  if (fetched.code !== 0) return fail(`the bundle did not fetch in the sandbox: ${fetched.stderr.trim() || `exit ${fetched.code}`}`);

  const lines: string[] = [];
  for (const r of refs) {
    const log = await c.exec(`cd ${shq(repo)} && git log -1 --format='%h %cs %s' ${shq(`refs/remotes/mirror/${r}`)}`, { timeoutMs: 30_000 });
    lines.push(`  mirror/${r}  ${log.stdout.trim()}`);
  }
  const freshness = refreshError ? `mirror refresh failed (${refreshError}); refs are as of the last successful refresh` : "mirror refreshed just now";
  return ok(
    `Fetched into ${repo} (${freshness}):\n${lines.join("\n")}\n` +
    `Use them as mirror/<branch>: \`git rebase mirror/master\` to pick up master, or \`git reset --hard mirror/<branch>\` to adopt a branch someone else rewrote. Nothing was pushed.`,
  );
}
