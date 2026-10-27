import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitFetchTool, type MirrorSource } from "../src/git-fetch";
import type { Exec } from "../src/vendor/slaude/types";

const sh = (cmd: string, cwd: string, stdin?: Uint8Array) => {
  const p = Bun.spawnSync(["sh", "-c", cmd], { cwd, stdin, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } });
  return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), code: p.exitCode };
};

/** The sandbox is a local directory: same contract as the docker exec and pipe. */
const localExec = (cwd: string): Exec => async (cmd, opts) => {
  const r = sh(cmd, cwd);
  const max = opts.maxOutput ?? 30_000;
  return { ...r, stdout: r.stdout.slice(0, max), truncated: r.stdout.length > max, timedOut: false };
};
const localPipe = (cwd: string) => async (cmd: string, stdin: Uint8Array) => sh(cmd, cwd, stdin);

let tmp: string, origin: string, mirror: string, dev: string, work: string;
const text = (r: any): string => r.content.map((c: any) => c.text).join("\n");
const rev = (ref: string, cwd: string) => sh(`git rev-parse ${ref}`, cwd).stdout.trim();

const mirrors: MirrorSource = {
  path: (name) => join(tmp, `${name}.git`),
  async refresh(name) {
    const r = sh(`git -C ${join(tmp, `${name}.git`)} fetch -q --prune origin '+refs/heads/*:refs/heads/*'`, tmp);
    return r.code === 0 ? null : r.stderr;
  },
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "git-fetch-test-"));
  origin = join(tmp, "origin.git");
  mirror = join(tmp, "go-recovery.git"); // the mirror is named after the repo, as Mirrors.path does
  dev = join(tmp, "dev");
  work = join(tmp, "go-recovery"); // the sandbox clone sits at <root>/<repoName>
  sh(`git init -q --bare ${origin}`, tmp);
  sh(
    `git clone -q ${origin} dev && cd dev && git config user.name Dev && git config user.email dev@x && ` +
      `git switch -qc master && echo a > a && git add a && git commit -qm base && git push -q origin master`,
    tmp,
  );
  sh(`git clone -q --mirror ${origin} ${mirror}`, tmp);
  // Provision as the server does: bundle from the mirror, clone, drop the remote.
  sh(`git -C ${mirror} bundle create -q ${tmp}/b.bundle --all && git clone -q ${tmp}/b.bundle go-recovery && cd go-recovery && git remote remove origin && git config user.name Samson && git config user.email s@x`, tmp);
  sh(`git switch -qc factory/PL-1 && echo s > s && git add s && git commit -qm "feat: sandbox work"`, work);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("git_fetch", () => {
  it("brings a branch pushed after provisioning into the sandbox as mirror/<branch>, after refreshing the mirror", async () => {
    sh(`echo m > m && git add m && git commit -qm "feat: master moved" && git push -q origin master`, dev);
    expect(rev("master", mirror)).not.toBe(rev("master", dev)); // the mirror is stale until refresh
    const ctx = { exec: localExec(work), root: work, pipe: localPipe(work) };
    const r = await gitFetchTool(ctx, { refs: ["master"] }, mirrors);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("mirror/master");
    expect(text(r)).toContain("feat: master moved");
    expect(rev("refs/remotes/mirror/master", work)).toBe(rev("master", dev));
    // The sandbox's own branches are untouched and it still has no remote.
    expect(sh("git log -1 --format=%s factory/PL-1", work).stdout.trim()).toBe("feat: sandbox work");
    expect(sh("git remote", work).stdout.trim()).toBe("");
  });

  it("fetches a human-rewritten factory branch so the agent can reset to it", async () => {
    sh(`git switch -qc factory/PL-1 && echo h > h && git add h && git commit -qm "rebased by human" && git push -q origin factory/PL-1`, dev);
    const ctx = { exec: localExec(work), root: work, pipe: localPipe(work) };
    const r = await gitFetchTool(ctx, { refs: ["factory/PL-1", "master"], dir: "." }, mirrors);
    expect(r.isError).toBeUndefined();
    expect(rev("refs/remotes/mirror/factory/PL-1", work)).toBe(rev("factory/PL-1", dev));
    expect(rev("factory/PL-1", work)).not.toBe(rev("factory/PL-1", dev)); // adopt it is the agent's call
  });

  it("refuses bad refs, unknown branches, and a repo without a mirror", async () => {
    const ctx = { exec: localExec(work), root: work, pipe: localPipe(work) };
    for (const refs of [[], ["refs/heads/master"], ["../x"], ["a//b"], ["x/"], ["x.lock"], ["m@{1}"]]) {
      expect((await gitFetchTool(ctx, { refs }, mirrors)).isError).toBe(true);
    }
    expect(text(await gitFetchTool(ctx, { refs: ["nope"] }, mirrors))).toContain("not on the mirror");
    sh(`git init -q other && cd other && git commit -q --allow-empty -m x`, tmp);
    const other = join(tmp, "other");
    expect(text(await gitFetchTool({ exec: localExec(other), root: other, pipe: localPipe(other) }, { refs: ["master"] }, mirrors))).toContain("no mirror");
    expect(sh("git for-each-ref refs/remotes", work).stdout.trim()).toBe("");
  });

  it("still serves the last refreshed state when the mirror refresh fails, and says so", async () => {
    const stale: MirrorSource = { path: mirrors.path, refresh: async () => "ssh: connect to host bitbucket.org port 22: Network is unreachable" };
    const ctx = { exec: localExec(work), root: work, pipe: localPipe(work) };
    const r = await gitFetchTool(ctx, { refs: ["master"] }, stale);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("refresh failed");
    expect(rev("refs/remotes/mirror/master", work)).toBe(rev("master", mirror));
  });
});
