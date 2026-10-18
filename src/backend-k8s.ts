import { cliExec, wrap, type Backend, type Handle } from "./backend";
import { config } from "./config";
import { makeProvisioner } from "./provision";
import type { ExecOpts } from "./vendor/slaude/types";

const CLI_TIMEOUT = 120_000;
const LABEL = "sandbox/session";
const LAST_USED = "sandbox/last-used";

/**
 * A Pod plus PVC per session, driven by kubectl (in-cluster ServiceAccount or kubeconfig).
 * ponytail: kubectl exec per tool call, 200 to 400 ms through the API server; @kubernetes/client-node
 * over a WebSocket is the upgrade if that ever hurts.
 */
export function k8sBackend(): Backend {
  const ns = config.k8sNamespace();
  const root = config.root();
  const provision = makeProvisioner();
  const name = (key: string) => `sbx-${key}`;
  const kubectl = (args: string[], o: { timeoutMs?: number; stdin?: string | Uint8Array; maxOutput?: number } = {}) =>
    cliExec(["kubectl", "-n", ns, ...args], { timeoutMs: o.timeoutMs ?? CLI_TIMEOUT, stdin: o.stdin, maxOutput: o.maxOutput });

  const handle = (key: string): Handle => ({
    root,
    exec: (cmd, o: ExecOpts) =>
      kubectl(["exec", "-i", name(key), "-c", "dev", "--", ...wrap(cmd, o)], { timeoutMs: o.timeoutMs, stdin: o.stdin, maxOutput: o.maxOutput }),
    pipe: (cmd, stdin, timeoutMs = 300_000) =>
      kubectl(["exec", "-i", name(key), "-c", "dev", "--", "/bin/sh", "-c", cmd], { timeoutMs, stdin }),
  });

  const manifests = (key: string) => `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name(key)}
  labels: { ${LABEL}: "${key}" }
  annotations: { ${LAST_USED}: "${new Date().toISOString()}" }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${config.k8sStorageClass()}
  resources: { requests: { storage: ${config.k8sDiskSize()} } }
---
apiVersion: v1
kind: Pod
metadata:
  name: ${name(key)}
  labels: { app: factory-sandbox-box, ${LABEL}: "${key}" }
  annotations: { sidecar.istio.io/inject: "false" }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  ${config.k8sNodeSelector() ? `nodeSelector: { ${config.k8sNodeSelector()} }` : ""}
  ${config.k8sToleration() ? `tolerations: [{ ${config.k8sToleration()} }]` : ""}
  securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, runAsNonRoot: true }
  containers:
    - name: dev
      image: ${config.image()}
      command: ["sleep", "infinity"]
      env:
        - { name: HOME, value: ${root}/.home }
        - { name: CLAUDE_CONFIG_DIR, value: /data/.claude }
        - { name: GOPROXY, value: "off" }
        - { name: GOFLAGS, value: "-mod=mod" }
        - { name: GONOSUMDB, value: "*" }
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      resources:
        requests: { cpu: ${config.k8sCpuRequest()}, memory: ${config.k8sMemRequest()} }
        limits: { cpu: ${config.k8sCpuLimit()}, memory: ${config.k8sMemLimit()} }
      volumeMounts:
        - { name: data, mountPath: ${root}, subPath: workspace }
        - { name: data, mountPath: /data, subPath: data }
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: ${name(key)} }
`;

  return {
    async ensure(key) {
      const n = name(key);
      const phase = await kubectl(["get", "pod", n, "-o", "jsonpath={.status.phase}"]);
      const alive = phase.code === 0 && (phase.stdout === "Running" || phase.stdout === "Pending");
      if (!alive) {
        if (phase.code === 0) await kubectl(["delete", "pod", n, "--ignore-not-found", "--wait=true"], { timeoutMs: 300_000 });
        const r = await kubectl(["apply", "-f", "-"], { stdin: manifests(key) });
        if (r.code !== 0) throw new Error(`kubectl apply failed: ${r.stderr}`);
      }
      const w = await kubectl(["wait", `pod/${n}`, "--for=condition=Ready", "--timeout=180s"], { timeoutMs: 200_000 });
      if (w.code !== 0) throw new Error(`sandbox pod not ready: ${w.stderr || w.stdout}`);
      const h = handle(key);
      await h.exec(`mkdir -p "$HOME"`, { timeoutMs: 30_000 });
      if (provision) await provision(h);
      return h;
    },
    async stop(key) {
      await kubectl(["annotate", "pvc", name(key), `${LAST_USED}=${new Date().toISOString()}`, "--overwrite"]);
      await kubectl(["delete", "pod", name(key), "--ignore-not-found", "--wait=false"]);
    },
    async destroy(key) {
      await kubectl(["delete", "pod", name(key), "--ignore-not-found", "--wait=false"]);
      await kubectl(["delete", "pvc", name(key), "--ignore-not-found", "--wait=false"]);
    },
    async list() {
      const r = await kubectl(["get", "pvc", "-l", LABEL, "-o", `jsonpath={range .items[*]}{.metadata.labels.sandbox/session}{"\\n"}{end}`]);
      return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    },
    async reap(olderThanMs) {
      // PVCs with no pod and a last-used older than the keep window.
      const r = await kubectl(["get", "pvc", "-l", LABEL, "-o", `jsonpath={range .items[*]}{.metadata.labels.sandbox/session} {.metadata.annotations.sandbox/last-used}{"\\n"}{end}`]);
      const gone: string[] = [];
      for (const line of r.stdout.split("\n")) {
        const [key, used] = line.trim().split(" ");
        if (!key) continue;
        const t = Date.parse(used ?? "");
        if (!Number.isFinite(t) || Date.now() - t < olderThanMs) continue;
        const pod = await kubectl(["get", "pod", name(key), "-o", "jsonpath={.status.phase}"]);
        if (pod.code === 0 && pod.stdout === "Running") continue;
        await this.destroy(key);
        gone.push(key);
      }
      return gone;
    },
  };
}
