import { SESSION_KEY, type Backend, type Handle } from "./backend";
import { config } from "./config";
import type { BashCtx } from "./vendor/slaude/tools/bash";
import { ReadState, type FileCtx } from "./vendor/slaude/tools/files";

/** The two closure objects slaude's createRemoteMcp keeps per thread: file mtimes, cwd, background job offsets. */
export interface SessionState { files: FileCtx; shell: BashCtx }

export interface Session {
  key: string;
  handle: Handle;
  state: SessionState;
  lastUsed: number;
}

export function sessionState(key: string, h: Handle): SessionState {
  return {
    files: { exec: h.exec, root: h.root, state: new ReadState() },
    shell: { exec: h.exec, root: h.root, sessionKey: key, cwd: { value: h.root }, bg: new Map() },
  };
}

/** Per-session cache in front of a backend, plus the idle and keep sweeps.
 *  ponytail: in memory; a server restart only forgets mtimes, cwd and bg offsets.
 *  Disk-level age (keep-days) is the backend's job, since it owns the disk. */
export class Sessions {
  #live = new Map<string, Promise<Session>>();
  #timer?: ReturnType<typeof setInterval>;
  constructor(readonly backend: Backend, private idleMs = config.idleTtlMs()) {}

  get(key: string): Promise<Session> {
    if (!SESSION_KEY.test(key)) return Promise.reject(new BadSession("X-Sandbox-Session must be a UUID"));
    let s = this.#live.get(key);
    if (!s) {
      s = this.backend.ensure(key).then((handle) => ({ key, handle, state: sessionState(key, handle), lastUsed: Date.now() }));
      s.catch(() => this.#live.delete(key));
      this.#live.set(key, s);
    }
    return s.then((x) => { x.lastUsed = Date.now(); return x; });
  }

  /** Stop every session idle longer than the TTL. Returns the keys stopped. */
  async sweep(now = Date.now()): Promise<string[]> {
    const stopped: string[] = [];
    for (const [key, p] of this.#live) {
      const s = await p.catch(() => null);
      if (!s || now - s.lastUsed < this.idleMs) continue;
      this.#live.delete(key);
      await this.backend.stop(key).catch((e) => console.error(JSON.stringify({ at: "sweep", key, error: String(e) })));
      stopped.push(key);
    }
    if (this.backend.reap) {
      const gone = await this.backend.reap(config.keepMs()).catch((e) => { console.error(JSON.stringify({ at: "reap", error: String(e) })); return []; });
      if (gone.length) console.log(JSON.stringify({ at: "reap", destroyed: gone }));
    }
    return stopped;
  }

  start(everyMs = config.sweepMs()) {
    this.#timer ??= setInterval(() => void this.sweep(), everyMs);
    return this;
  }
  stop() { clearInterval(this.#timer); this.#timer = undefined; }
  get size() { return this.#live.size; }
}

export class BadSession extends Error {}
