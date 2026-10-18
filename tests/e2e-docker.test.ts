// End to end against a real Docker engine. Opt in: SANDBOX_E2E=docker SANDBOX_IMAGE=<sandbox image> bun test tests/e2e-docker.test.ts
// With SANDBOX_VPS_HOST set and SANDBOX_E2E=vps the same runs over DOCKER_HOST=ssh://.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerBackend } from "../src/backend-docker";

const kind = process.env.SANDBOX_E2E as "docker" | "vps" | undefined;
const KEY = "e2e00000-0000-4000-8000-00000000d0ck";
const text = (r: { stdout: string; stderr: string }) => (r.stdout + r.stderr).trim();

describe.skipIf(kind !== "docker" && kind !== "vps")("docker backend e2e", () => {
  // A tiny local "repo" so provisioning (mirror → bundle → clone) is exercised without a credential.
  const base = mkdtempSync(join(tmpdir(), "sandbox-e2e-"));
  const repo = join(base, "demo.git");
  Bun.spawnSync(["sh", "-c", `git init -q -b main src && cd src && git config user.email a@b && git config user.name a && echo hi > README && git add . && git commit -qm init && git clone -q --bare . ../demo.git`], { cwd: base });
  process.env.SANDBOX_REPOS = repo;
  process.env.SANDBOX_MIRRORS_DIR = join(base, "mirrors");
  process.env.SANDBOX_GOMOD_DIR = join(base, "nope");
  const be = dockerBackend(kind!);

  afterAll(async () => {
    await be.destroy(KEY);
    rmSync(base, { recursive: true, force: true });
  });

  test("ensure creates a container, provisions the repo, exec works, state survives stop/start, destroy removes it", async () => {
    const h = await be.ensure(KEY);
    expect(text(await h.exec("id -u && pwd", { timeoutMs: 30_000 }))).toBe(`1000\n${h.root}`);
    expect(text(await h.exec("git -C demo log --oneline && git -C demo remote", { timeoutMs: 30_000 }))).toContain("init");
    expect(text(await h.exec("git -C demo remote", { timeoutMs: 30_000 }))).toBe("");
    expect(text(await h.exec("echo keep > marker.txt", { timeoutMs: 30_000, login: true }))).toBe("");
    const slow = await h.exec("sleep 5", { timeoutMs: 1_000 });
    expect(slow.timedOut).toBe(true);
    expect((await be.list()).includes(KEY)).toBe(true);

    await be.stop(KEY);
    const again = await be.ensure(KEY);
    expect(text(await again.exec("cat marker.txt", { timeoutMs: 30_000 }))).toBe("keep");
    expect(text(await again.exec("test -e .provisioned && echo yes", { timeoutMs: 30_000 }))).toBe("yes");

    await be.destroy(KEY);
    expect((await be.list()).includes(KEY)).toBe(false);
  }, 600_000);
});
