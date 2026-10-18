# The server image: Bun + the CLIs the backends shell out to (kubectl, docker) + git with SSH for
# mirrors and git_push + Go for warming the private module cache. No credential is baked in.
FROM oven/bun:1.3-debian

ARG TARGETARCH
ARG KUBECTL_VERSION=v1.33.4
ARG DOCKER_VERSION=28.3.3
ARG GO_VERSION=1.25.9

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client perl tar gzip coreutils \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o /usr/local/bin/kubectl \
 && chmod +x /usr/local/bin/kubectl \
 && arch=$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64) \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" | tar -xz -C /tmp \
 && mv /tmp/docker/docker /usr/local/bin/docker && rm -rf /tmp/docker \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" | tar -xz -C /usr/local \
 && ln -s /usr/local/go/bin/go /usr/local/bin/go

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY src ./src

# uid 1000 (the `bun` user of the base image): matches the agent pods and the sandbox image.
RUN mkdir -p /mirrors /gomod /home/bun/.ssh && chown -R bun:bun /app /mirrors /gomod /home/bun
USER bun
ENV PORT=8080 HOME=/home/bun
EXPOSE 8080
CMD ["bun", "run", "src/main.ts"]
