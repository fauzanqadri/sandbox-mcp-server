import { describe, expect, test } from "bun:test";
import { runArgs, volumesOf } from "../src/backend-docker";

const K = "11111111-1111-4111-8111-111111111111";
const base = { root: "/workspace", image: "img:1" };
const has = (args: string[], ...seq: string[]) => args.some((_, i) => seq.every((s, j) => args[i + j] === s));

describe("docker run arguments", () => {
  test("default runtime: uid 1000, no capabilities, no new privileges, no docker volume, sleeps", () => {
    const a = runArgs(K, base);
    expect(has(a, "--user", "1000:1000")).toBe(true);
    expect(has(a, "--cap-drop", "ALL")).toBe(true);
    expect(has(a, "--security-opt", "no-new-privileges")).toBe(true);
    expect(a.includes("--runtime")).toBe(false);
    expect(a.some((x) => x.endsWith(":/var/lib/docker"))).toBe(false);
    expect(a.slice(-3)).toEqual(["img:1", "sleep", "infinity"]);
  });

  test("sysbox: own runtime, root init with its own /var/lib/docker volume, sandbox-init", () => {
    const a = runArgs(K, { ...base, runtime: "sysbox-runc" });
    expect(has(a, "--runtime", "sysbox-runc")).toBe(true);
    expect(has(a, "--user", "0:0")).toBe(true);
    expect(has(a, "-v", `sbx-${K}-docker:/var/lib/docker`)).toBe(true);
    expect(a.includes("--cap-drop")).toBe(false);
    expect(a.slice(-2)).toEqual(["img:1", "sandbox-init"]);
  });

  test("memory and cpu caps only when set; swap capped to memory", () => {
    expect(runArgs(K, base).includes("--memory")).toBe(false);
    const a = runArgs(K, { ...base, memory: "6g", cpus: "2" });
    expect(has(a, "--memory", "6g", "--memory-swap", "6g")).toBe(true);
    expect(has(a, "--cpus", "2")).toBe(true);
  });

  test("destroy removes every volume a sandbox can own", () => {
    expect(volumesOf(K)).toEqual([`sbx-${K}-ws`, `sbx-${K}-data`, `sbx-${K}-docker`]);
  });
});
