const opt = (k: string, d = ""): string => process.env[k] ?? d;
const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const num = (k: string, d: number) => {
  const n = Number(opt(k));
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Every knob the server reads. Read at call time so tests can flip them. */
export const config = {
  port: () => num("PORT", 8080),
  host: () => opt("HOST", "0.0.0.0"),
  /** Shared bearer the slaude deployment sends (SLAUDE_SANDBOX_MCP_TOKEN there too). */
  token: () => opt("SLAUDE_SANDBOX_MCP_TOKEN").trim(),
  /** local | docker | vps | k8s | vercel */
  backend: () => opt("SANDBOX_BACKEND", "local"),
  /** Working directory inside every sandbox; the model's cwd starts here. */
  root: () => opt("SANDBOX_ROOT", "/workspace"),
  idleTtlMs: () => num("SANDBOX_IDLE_TTL_MIN", 60) * 60_000,
  keepMs: () => num("SANDBOX_KEEP_DAYS", 7) * 86_400_000,
  sweepMs: () => num("SANDBOX_SWEEP_SEC", 60) * 1000,
  /** Image every backend starts a sandbox from. */
  image: () => opt("SANDBOX_IMAGE", "ghcr.io/fauzanqadri/factory-sandbox:latest"),

  // provisioning
  repos: () => csv(opt("SANDBOX_REPOS")),
  mirrorsDir: () => opt("SANDBOX_MIRRORS_DIR", "/mirrors"),
  mirrorRefreshMs: () => num("SANDBOX_MIRROR_REFRESH_MIN", 10) * 60_000,
  gomodDir: () => opt("SANDBOX_GOMOD_DIR", "/gomod"),
  /** docker: named volume holding gomodDir, mounted read-only as every sandbox's GOMODCACHE instead of a 4 GB copy each. */
  gomodVolume: () => opt("SANDBOX_GOMOD_VOLUME"),
  gitUser: () => opt("SANDBOX_GIT_USER", "Samson"),
  gitEmail: () => opt("SANDBOX_GIT_EMAIL", "samson.aux@amartha.com"),
  /** ssh command for the read-only clone key (mirrors, go mod download). */
  cloneSsh: () => opt("SANDBOX_CLONE_SSH_COMMAND"),
  /** Plugin tree source: a directory on this host, or (k8s) a pod selector to tar it out of. */
  pluginDir: () => opt("SANDBOX_PLUGIN_DIR"),
  pluginSourceSelector: () => opt("SANDBOX_PLUGIN_SOURCE_SELECTOR"),

  // backends
  k8sNamespace: () => opt("SANDBOX_NAMESPACE", "default"),
  k8sStorageClass: () => opt("SANDBOX_K8S_STORAGE_CLASS", "standard-rwo"),
  k8sDiskSize: () => opt("SANDBOX_K8S_DISK", "10Gi"),
  /** `key: value` pairs as they appear inside a YAML flow mapping, e.g. `dedicated: ai-agent`. Empty = none. */
  k8sNodeSelector: () => opt("SANDBOX_K8S_NODE_SELECTOR"),
  /** One toleration as YAML flow fields, e.g. `key: dedicated, operator: Equal, value: ai-agent, effect: NoSchedule`. */
  k8sToleration: () => opt("SANDBOX_K8S_TOLERATION"),
  k8sCpuRequest: () => opt("SANDBOX_K8S_CPU_REQUEST", "1"),
  k8sCpuLimit: () => opt("SANDBOX_K8S_CPU_LIMIT", "4"),
  k8sMemRequest: () => opt("SANDBOX_K8S_MEM_REQUEST", "2Gi"),
  k8sMemLimit: () => opt("SANDBOX_K8S_MEM_LIMIT", "8Gi"),
  vercelImage: () => opt("SANDBOX_VERCEL_IMAGE"),
  vercelVcpus: () => num("SANDBOX_VERCEL_VCPUS", 2),
  /** Session wall clock per resume, ms. Vercel caps it per plan. */
  vercelTimeoutMs: () => num("SANDBOX_VERCEL_TIMEOUT_MIN", 60) * 60_000,
  dockerHost: () => opt("SANDBOX_DOCKER_HOST"),
  vpsHost: () => opt("SANDBOX_VPS_HOST"),

  // git_push (same names as slaude so one Vault path serves both)
  pushRemotes: () => csv(opt("SLAUDE_GIT_PUSH_REMOTES")),
  pushToken: () => opt("SLAUDE_GIT_PUSH_TOKEN").trim(),
  pushTokenUser: () => opt("SLAUDE_GIT_PUSH_TOKEN_USER", "x-access-token").trim(),
};

/** Secrets that must not reach a git child or a sandbox. */
export const SECRET_ENV = ["SLAUDE_SANDBOX_MCP_TOKEN", "SLAUDE_GIT_PUSH_TOKEN", "VERCEL_TOKEN"];
