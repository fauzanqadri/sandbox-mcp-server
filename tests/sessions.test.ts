import { expect, test } from "bun:test";
import type { Backend } from "../src/backend";
import { Sessions } from "../src/sessions";

test("stopOrphans stops sandboxes this process has not served, and only those", async () => {
  const stopped: string[] = [];
  const live = "11111111-1111-4111-8111-111111111111";
  const orphan = "22222222-2222-4222-8222-222222222222";
  const backend = {
    ensure: async () => ({ root: "/w", exec: async () => ({ code: 0, stdout: "", stderr: "" }), pipe: async () => ({ code: 0, stdout: "", stderr: "" }) }),
    stop: async (k: string) => { stopped.push(k); },
    destroy: async () => {},
    list: async () => [live, orphan],
  } as unknown as Backend;
  const s = new Sessions(backend);
  await s.get(live);
  expect(await s.stopOrphans()).toEqual([orphan]);
  expect(stopped).toEqual([orphan]);
});
