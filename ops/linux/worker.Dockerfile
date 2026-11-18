ARG RAE_BASE_IMAGE=anotherrae:local
FROM ${RAE_BASE_IMAGE} AS runtime

FROM ubuntu:24.04@sha256:77eb101c607d6e3d4f5ad0c8a02c2136c689b98aba1f359e6502ba517e5c57ec
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bubblewrap ca-certificates curl git make python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 20002 rae-worker \
    && useradd --no-create-home --uid 20002 --gid 20002 --home-dir /var/lib/rae-worker rae-worker \
    && mkdir -p /work /var/lib/rae-worker /run/rae-device-api /opt/rae-worker

COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --chmod=0555 codex/ /opt/rae-worker/codex/
COPY --chmod=0444 codex-notices/ /opt/rae-worker/codex-notices/
COPY --chmod=0444 linux-project-worker.mjs project-hook.cjs /opt/rae-worker/
COPY --from=runtime --chown=0:0 /opt/anotherrae/node_modules/undici /opt/rae-worker/node_modules/undici
RUN chmod -R a+rX /opt/rae-worker/node_modules/undici

ENV RAE_WORKER_WORK_DIR=/work \
    RAE_WORKER_STATE_DIR=/var/lib/rae-worker \
    RAE_WORKER_CODEX=/opt/rae-worker/codex/bin/codex-app-server \
    RAE_WORKER_HOOK=/opt/rae-worker/project-hook.cjs \
    RAE_WORKER_API_SOCKET=/run/rae-device-api/device.sock \
    RAE_WORKER_CREDENTIAL_FILE=/run/rae-worker-credential \
    HOME=/var/lib/rae-worker
USER 20002:20002
ENTRYPOINT ["/usr/bin/flock", "--no-fork", "--nonblock", "/var/lib/rae-worker/worker.lock", "/usr/local/bin/node", "/opt/rae-worker/linux-project-worker.mjs"]
