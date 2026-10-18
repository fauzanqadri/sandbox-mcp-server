# sandbox-mcp-server

One isolated sandbox per slaude thread. slaude's sandbox MCP mode (`SLAUDE_SANDBOX_MCP_URL`) mounts this server under the name `remote`, sends `X-Sandbox-Session: <session uuid>` and `Authorization: Bearer <SLAUDE_SANDBOX_MCP_TOKEN>`, and aliases Bash, Read, Write, Edit, Glob and Grep to the nine tools here. The first call from a new session creates its sandbox; later calls reuse it; idle sandboxes are stopped and, after `SANDBOX_KEEP_DAYS`, destroyed.

The tools (`src/vendor/slaude/`) are vendored verbatim from the slaude fork so the contract stays identical; `src/git-push.ts` is a port that pushes from this process with the key mounted here. The sandbox never holds a credential.

## Run

```sh
bun install
SLAUDE_SANDBOX_MCP_TOKEN=secret SANDBOX_BACKEND=local bun run src/main.ts
bun test
```

## Backends (`SANDBOX_BACKEND`)

| Value | Sandbox | Needs |
|---|---|---|
| `local` | a directory per session on this host (tests, dev; no isolation) | nothing |
| `docker` | a container per session | the Docker socket (`SANDBOX_DOCKER_HOST` or `/var/run/docker.sock`) |
| `vps` | a container per session on a remote host | `SANDBOX_VPS_HOST=user@host`, an SSH key (`DOCKER_HOST=ssh://`) |
| `k8s` | a Pod plus PVC per session | kubeconfig or in-cluster ServiceAccount with pods, pods/exec, persistentvolumeclaims |
| `vercel` | a Vercel Sandbox per session | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` |

Every sandbox starts from `SANDBOX_IMAGE` and is provisioned once: the repos in `SANDBOX_REPOS` (cloned from server-side mirrors, remote stripped, identity `SANDBOX_GIT_USER` / `SANDBOX_GIT_EMAIL`), the plugin tree at `/data/.claude/plugins`, and the Go module cache with `GOPROXY=off`.

## Push

`git_push` bundles `factory/<name>` out of the sandbox and pushes it from here, only to a remote listed in `SLAUDE_GIT_PUSH_REMOTES`, never with force. SSH remotes use `GIT_SSH_COMMAND`; HTTPS remotes use `SLAUDE_GIT_PUSH_TOKEN`.
