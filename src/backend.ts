import type { Exec, ExecOpts, ExecResult } from "./vendor/slaude/types";

/** One live sandbox. `root` is where the model's cwd starts; `pipe` feeds bytes to a command's stdin (tar, bundles). */
export interface Handle {
  exec: Exec;
  root: string;
  pipe(cmd: string, stdin: Uint8Array, timeoutMs?: number): Promise<ExecResult>;
}

export interface Backend {
  /** Create or reattach the sandbox for a session key. */
  ensure(key: string): Promise<Handle>;
  /** Idle: free compute, keep the disk. The next ensure() reattaches. */
  stop(key: string): Promise<void>;
  /** Gone for good: disk too. */
  destroy(key: string): Promise<void>;
  /** Session keys that still have a disk. */
  list(): Promise<string[]>;
  /** Destroy stopped sandboxes idle longer than this; returns the keys destroyed. The backend owns the disk, so it owns the clock. */
  reap?(olderThanMs: number): Promise<string[]>;
}

const TAIL = 4_000;

/** Head and tail of a stream with the middle dropped (same shape as slaude's Capped). */
export class Capped {
  #head = "";
  #tail = "";
  #dropped = 0;
  constructor(private head: number) {}
  push(s: string) {
    if (this.#head.length < this.head) {
      const room = this.head - this.#head.length;
      this.#head += s.slice(0, room);
      s = s.slice(room);
    }
    if (!s) return;
    this.#tail += s;
    if (this.#tail.length > TAIL) {
      this.#dropped += this.#tail.length - TAIL;
      this.#tail = this.#tail.slice(-TAIL);
    }
  }
  get truncated() { return this.#dropped > 0; }
  text(): string {
    return this.#dropped > 0 ? `${this.#head}\n[truncated ${this.#dropped} chars]\n${this.#tail}` : this.#head + this.#tail;
  }
}

export interface CliOpts {
  timeoutMs: number;
  maxOutput?: number;
  stdin?: string | Uint8Array;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** Run a local argv (kubectl, docker, sh) with the Exec result contract: capped output, SIGKILL on timeout. */
export async function cliExec(argv: string[], o: CliOpts): Promise<ExecResult> {
  const p = Bun.spawn(argv, {
    cwd: o.cwd,
    env: o.env as Record<string, string> | undefined,
    stdin: o.stdin === undefined ? undefined : typeof o.stdin === "string" ? Buffer.from(o.stdin) : o.stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, o.timeoutMs);
  const out = new Capped(o.maxOutput ?? 30_000);
  const err = new Capped(o.maxOutput ?? 30_000);
  const drain = async (s: ReadableStream<Uint8Array>, c: Capped) => {
    const dec = new TextDecoder();
    for await (const chunk of s) c.push(dec.decode(chunk, { stream: true }));
    c.push(dec.decode());
  };
  try {
    await Promise.all([drain(p.stdout, out), drain(p.stderr, err)]);
    const code = await p.exited;
    return { stdout: out.text(), stderr: err.text(), code: timedOut ? null : code, truncated: out.truncated || err.truncated, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** The command as run inside a sandbox. GNU `timeout` kills the whole thing a second after
 *  the server side gives up, so a lost kubectl or docker session leaves no orphan. */
export function wrap(cmd: string, o: ExecOpts): string[] {
  const s = Math.ceil(o.timeoutMs / 1000) + 1;
  return ["timeout", "-s", "KILL", `${s}s`, ...(o.login ? ["bash", "-lc", cmd] : ["/bin/sh", "-c", cmd])];
}

/** Session keys are slaude session row ids (UUIDs); anything else is refused before it reaches a backend. */
export const SESSION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function pickBackend(name: string): Promise<Backend> {
  switch (name) {
    case "local": return (await import("./backend-local")).localBackend();
    case "docker":
    case "vps": return (await import("./backend-docker")).dockerBackend(name);
    case "k8s": return (await import("./backend-k8s")).k8sBackend();
    case "vercel": return (await import("./backend-vercel")).vercelBackend();
    default: throw new Error(`unknown SANDBOX_BACKEND: ${name}`);
  }
}
