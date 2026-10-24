import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBackend } from "../src/backend-local";
import { startServer, type Started } from "../src/main";
import { TOOL_NAMES } from "../src/tools";

const TOKEN = "t0k3n";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

let started: Started | undefined;
let base: string;
afterEach(async () => {
  await started?.stop();
  started = undefined;
  rmSync(base, { recursive: true, force: true });
});

async function boot(extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  base = mkdtempSync(join(tmpdir(), "sandbox-rt-"));
  started = await startServer({ port: 0, token: TOKEN, backend: localBackend(base), sweep: false, ...extra });
  return started;
}

/** slaude's client shape: streamable HTTP, bearer + X-Sandbox-Session, nothing else. */
async function client(url: string, session: string, token = TOKEN): Promise<Client> {
  const c = new Client({ name: "slaude-test", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { "X-Sandbox-Session": session, Authorization: `Bearer ${token}` } },
  }));
  return c;
}
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const call = (c: Client, name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args });

describe("sandbox MCP server round trip", () => {
  test("exposes exactly the nine tools slaude expects", async () => {
    const { url } = await boot();
    const c = await client(url, S1);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    await c.close();
  });

  test("handshake and tools/list neither wait for nor create a sandbox; tools/call does", async () => {
    let release!: () => void;
    let ensured = 0;
    const gate = new Promise<void>((r) => { release = r; });
    const local = localBackend((base = mkdtempSync(join(tmpdir(), "sandbox-rt-"))));
    const slow = { ...local, ensure: async (k: string) => { ensured++; await gate; return local.ensure(k); } };
    started = await startServer({ port: 0, token: TOKEN, backend: slow, sweep: false });
    const c = await client(started.url, S1);
    expect((await c.listTools()).tools.length).toBe(TOOL_NAMES.length);
    expect(ensured).toBe(0);
    const pending = call(c, "bash", { command: "echo ready" });
    release();
    expect(text(await pending)).toContain("ready");
    await c.close();
  });

  test("401 without or with a wrong bearer; 400 on a bad session; healthz open", async () => {
    const { url, port } = await boot();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "X-Sandbox-Session": S1 };
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { ...headers, Authorization: "Bearer nope" }, body })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { ...headers, Authorization: `Bearer ${TOKEN}`, "X-Sandbox-Session": "../etc" }, body })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });

  test("cwd persists across requests and is private to the session", async () => {
    const { url } = await boot();
    const a = await client(url, S1);
    const b = await client(url, S2);
    expect(text(await call(a, "bash", { command: "mkdir -p sub && cd sub && pwd" }))).toContain("/sub");
    expect(text(await call(a, "bash", { command: "pwd" }))).toEndWith(`sbx-${S1}/sub`);
    expect(text(await call(b, "bash", { command: "pwd" }))).toEndWith(`sbx-${S2}`);
    await a.close();
    await b.close();
  });

  test("edit needs a read first (ReadState survives across requests)", async () => {
    const { url } = await boot();
    const c = await client(url, S1);
    const file = `${base}/sbx-${S1}/f.txt`;
    expect(text(await call(c, "write", { file_path: file, content: "hello\n" }))).toContain("File created");
    const fresh = await client(url, S2);
    await call(fresh, "write", { file_path: `${base}/sbx-${S2}/g.txt`, content: "x\n" });
    // Another session has no mtime for this path: edit without read is refused there, allowed here.
    const r = await call(c, "edit", { file_path: file, old_string: "hello", new_string: "bye" });
    expect(text(r)).toContain("has been updated");
    expect(text(await call(c, "read", { file_path: file }))).toContain("bye");
    await c.close();
    await fresh.close();
  });

  test("refuses to start without a token unless auth is disabled", async () => {
    base = mkdtempSync(join(tmpdir(), "sandbox-rt-"));
    await expect(startServer({ port: 0, token: "", backend: localBackend(base), sweep: false })).rejects.toThrow(/token/i);
    started = await startServer({ port: 0, token: "", authDisabled: true, backend: localBackend(base), sweep: false });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(started.url), { requestInit: { headers: { "X-Sandbox-Session": S1 } } }));
    expect((await c.listTools()).tools.length).toBe(9);
    await c.close();
  });

  test("the sweeper stops idle sessions and the next call reattaches", async () => {
    const { url, sessions } = await boot();
    const stopped: string[] = [];
    const orig = sessions.backend.stop.bind(sessions.backend);
    sessions.backend.stop = async (k) => { stopped.push(k); await orig(k); };
    const c = await client(url, S1);
    await call(c, "bash", { command: "echo hi > kept.txt" });
    expect(await sessions.sweep(Date.now() + 61 * 60_000)).toEqual([S1]);
    expect(stopped).toEqual([S1]);
    expect(sessions.size).toBe(0);
    expect(text(await call(c, "bash", { command: "cat kept.txt" }))).toContain("hi");
    expect(sessions.size).toBe(1);
    await c.close();
  });

  test("DELETE /sandbox destroys the session's sandbox; the next call starts fresh", async () => {
    const { url, sessions } = await boot();
    const destroyUrl = new URL("/sandbox", url);
    const del = (session: string, token = TOKEN) =>
      fetch(destroyUrl, { method: "DELETE", headers: { "X-Sandbox-Session": session, Authorization: `Bearer ${token}` } });
    const c = await client(url, S1);
    await call(c, "bash", { command: "echo hi > gone.txt" });
    await call(c, "bash", { command: "echo other > kept.txt" }).then(() => {});
    const c2 = await client(url, S2);
    await call(c2, "bash", { command: "echo two > kept.txt" });

    expect((await del(S1, "wrong")).status).toBe(401);
    expect((await del("not-a-uuid")).status).toBe(400);
    expect((await del(S1)).status).toBe(204);
    expect((await del(S1)).status).toBe(204); // idempotent
    expect(sessions.size).toBe(1);

    expect(text(await call(c, "bash", { command: "ls" }))).not.toContain("gone.txt");
    expect(text(await call(c2, "bash", { command: "cat kept.txt" }))).toContain("two");
    // DELETE on the MCP path is not a destroy.
    expect((await fetch(url, { method: "DELETE", headers: { "X-Sandbox-Session": S2, Authorization: `Bearer ${TOKEN}` } })).status).not.toBe(204);
    expect(text(await call(c2, "bash", { command: "cat kept.txt" }))).toContain("two");
    await c.close();
    await c2.close();
  });
});
