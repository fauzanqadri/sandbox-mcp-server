import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitPushTool } from "./git-push";
import type { SessionState } from "./sessions";
import { bashKillTool, bashOutputTool, bashTool } from "./vendor/slaude/tools/bash";
import { editTool, fail, readTool, writeTool, type ToolText } from "./vendor/slaude/tools/files";
import { globTool, grepTool } from "./vendor/slaude/tools/search";

/** The nine tools slaude's sandbox MCP mode expects, by exact name (slaude tests/remote/mcp.test.ts). */
export const TOOL_NAMES = ["bash", "bash_output", "bash_kill", "read", "write", "edit", "glob", "grep", "git_push"] as const;

/** Register the tools on a fresh McpServer over one session's state. */
export function registerTools(server: McpServer, st: SessionState, sessionKey: string) {
  const reg = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (i: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolText>) =>
    // ponytail: ToolText is a CallToolResult minus the SDK's index signature; the cast keeps the vendored type untouched.
    server.registerTool(name, { description, inputSchema: shape }, (async (i: any) => guarded(sessionKey, name, i, () => fn(i))) as any);

  reg("bash", "Run a shell command in this thread's sandbox. Same contract as Bash.", {
    command: z.string(),
    timeout: z.number().optional(),
    description: z.string().optional(),
    run_in_background: z.boolean().optional(),
  }, (i) => bashTool(st.shell, i));
  reg("bash_output", "Read new output and status of a sandbox background job.", { bash_id: z.string() }, (i) => bashOutputTool(st.shell, i));
  reg("bash_kill", "Stop a sandbox background job and its whole process group.", { shell_id: z.string() }, (i) => bashKillTool(st.shell, i));
  reg("read", "Read a file in the sandbox. Same contract as Read.", {
    file_path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }, (i) => readTool(st.files, i));
  reg("write", "Write a file in the sandbox. Same contract as Write.", { file_path: z.string(), content: z.string() }, (i) => writeTool(st.files, i));
  reg("edit", "Edit a file in the sandbox. Same contract as Edit.", {
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }, (i) => editTool(st.files, i));
  reg("glob", "Find files by glob in the sandbox. Same contract as Glob.", { pattern: z.string(), path: z.string().optional() }, (i) => globTool(st.files, i));
  reg("grep", "Search file contents in the sandbox. Same contract as Grep.", {
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
    type: z.string().optional(),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    "-i": z.boolean().optional(),
    "-n": z.boolean().optional(),
    "-A": z.number().optional(),
    "-B": z.number().optional(),
    "-C": z.number().optional(),
    head_limit: z.number().optional(),
    multiline: z.boolean().optional(),
  }, (i) => grepTool(st.files, i));
  reg("git_push", "Publish commits from the sandbox: push branch factory/<name> of the repo in `dir` to an allowed remote. The sandbox holds no credential, so `git push` from bash fails; use this. Always asks for approval. No force push.", {
    branch: z.string(),
    remote: z.string(),
    dir: z.string().optional(),
  }, (i) => gitPushTool(st.files, i));
}

/** Strip the audit-only exit code, log one JSON line per call, never throw into the transport. */
async function guarded(session: string, tool: string, input: any, fn: () => Promise<ToolText>): Promise<ToolText> {
  const t0 = performance.now();
  let r: ToolText;
  let outcome = "ok";
  try {
    r = await fn();
    if (r.isError) outcome = "error";
  } catch (e) {
    outcome = "exception";
    r = fail(`sandbox ${tool} failed: ${(e as Error).message}`);
  }
  const { exitCode, ...out } = r;
  const subject = tool === "bash" ? String(input?.command ?? "").trim().split(/\s+/)[0]
    : String(input?.file_path ?? input?.path ?? input?.bash_id ?? input?.shell_id ?? input?.branch ?? "").split("/").pop();
  console.log(JSON.stringify({ ts: new Date().toISOString(), session, tool, subject, outcome, code: exitCode, ms: Math.round(performance.now() - t0) }));
  return out;
}
