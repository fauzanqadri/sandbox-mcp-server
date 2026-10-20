# The sandbox image every backend starts a session from. Toolchain only, no credential, uid 1000.
# Must provide what the vendored tools shell out to: bash, perl, sed, base64, tr, ps, nohup, find, grep,
# git, GNU timeout (coreutils), plus rg for glob/grep speed.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG GO_VERSION=1.25.9
ARG NODE_MAJOR=22

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client bash perl procps coreutils findutils grep sed \
      ripgrep python3 python3-venv make gcc libc6-dev unzip xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" | tar -xz -C /usr/local \
 # bash -lc sources Debian's /etc/profile, which resets PATH for non-root and drops /usr/local/go/bin.
 && ln -s /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/ \
 && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
 && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL=/usr/local/bin sh \
 && curl -fsSL "https://github.com/golangci/golangci-lint/releases/latest/download/golangci-lint-$(curl -fsSL https://api.github.com/repos/golangci/golangci-lint/releases/latest | grep -m1 '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')-linux-${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 --wildcards '*/golangci-lint' || true

ENV PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin
RUN useradd -m -u 1000 -s /bin/bash sandbox && mkdir -p /workspace /data && chown -R 1000:1000 /workspace /data
USER 1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
