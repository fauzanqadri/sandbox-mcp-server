import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { pickBackend, SESSION_KEY, type Backend, type Handle } from "./backend";
import { config } from "./config";
import { BadSession, Sessions, sessionState } from "./sessions";
import { registerTools } from "./tools";

export interface ServerOpts {
  port: number;
  host?: string;
  /** Shared bearer. Empty refuses to start unless authDisabled (tests). */
  token: string;
  authDisabled?: boolean;
  backend: Backend;
  /** Start the idle sweeper (default true). */
  sweep?: boolean;
}

export interface Started { url: string; port: number; sessions: Sessions; stop(): Promise<void> }

const MCP_PATH = "/mcp";
/** Not `DELETE /mcp`: an MCP client may send that when it closes its session, and a
 *  slaude reload must never wipe the thread's sandbox. */
const DESTROY_PATH = "/sandbox";
const HEADER = "x-sandbox-session";

/** Stand-in handle for requests that list tools but never run one. */
const NO_SANDBOX: Handle = {
  root: config.root(),
  exec: () => Promise.reject(new Error("no sandbox for this request")),
  pipe: () => Promise.reject(new Error("no sandbox for this request")),
};

export async function startServer(o: ServerOpts): Promise<Started> {
  if (!o.token && !o.authDisabled) throw new Error("SLAUDE_SANDBOX_MCP_TOKEN is empty; refusing to serve unauthenticated");
  const sessions = new Sessions(o.backend);
  if (o.sweep !== false) sessions.start();

  const server = Bun.serve({
    port: o.port,
    hostname: o.host ?? "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") return new Response("ok");
      const destroy = req.method === "DELETE" && url.pathname === DESTROY_PATH;
      if (url.pathname !== MCP_PATH && !destroy) return new Response("not found", { status: 404 });

      if (!o.authDisabled) {
        const auth = req.headers.get("authorization") ?? "";
        const ok = auth.startsWith("Bearer ") && timingSafeEqual(auth.slice(7).trim(), o.token);
        if (!ok) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
      }

      const key = (req.headers.get(HEADER) ?? "").trim().toLowerCase();
      if (destroy) {
        if (!SESSION_KEY.test(key)) return new Response("X-Sandbox-Session must be a UUID", { status: 400 });
        try {
          await sessions.destroy(key);
        } catch (e) {
          console.error(JSON.stringify({ at: "destroy", session: key, error: String(e) }));
          return new Response(`destroy failed: ${(e as Error).message}`, { status: 502 });
        }
        return new Response(null, { status: 204 });
      }
      // Only tools/call needs the sandbox, so it is created on the thread's first file or shell
      // call. initialize and tools/list answer at once: a slow provision must not time out the
      // client's MCP handshake (which then drops every sandbox tool for that turn), and a thread
      // that never touches files never costs a sandbox.
      const body = req.method === "POST" ? await req.clone().json().catch(() => null) : null;
      const calls = (Array.isArray(body) ? body : [body]).some((m) => m?.method === "tools/call");
      let s;
      try {
        if (!calls) {
          if (!SESSION_KEY.test(key)) throw new BadSession("X-Sandbox-Session must be a UUID");
          s = { state: sessionState(key, NO_SANDBOX) };
        } else s = await sessions.get(key);
      } catch (e) {
        if (e instanceof BadSession) return new Response(e.message, { status: 400 });
        console.error(JSON.stringify({ at: "ensure", session: key, error: String(e) }));
        return new Response(`sandbox unavailable: ${(e as Error).message}`, { status: 503 });
      }

      // Fresh server per request over the cached state: parallel tool calls from one
      // thread each get their own transport, the state they mutate is shared.
      const mcp = new McpServer({ name: "sandbox", version: "0.1.0" });
      registerTools(mcp, s.state, key);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      const res = await transport.handleRequest(req);
      void mcp.close();
      return res;
    },
  });

  const port = server.port!;
  return {
    url: `http://${o.host ?? "127.0.0.1"}:${port}${MCP_PATH}`,
    port,
    sessions,
    async stop() { sessions.stop(); await server.stop(true); },
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

if (import.meta.main) {
  const backend = await pickBackend(config.backend());
  const started = await startServer({ port: config.port(), host: config.host(), token: config.token(), backend });
  console.log(JSON.stringify({ at: "boot", backend: config.backend(), url: started.url }));
}
