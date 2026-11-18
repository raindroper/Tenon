FROM ubuntu:24.04@sha256:77eb101c607d6e3d4f5ad0c8a02c2136c689b98aba1f359e6502ba517e5c57ec

ARG RAE_RELEASE
LABEL org.opencontainers.image.title="Tenon" \
      org.opencontainers.image.version="${RAE_RELEASE}"

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates git libgcc-s1 libgssapi-krb5-2 libicu74 libssl3t64 libstdc++6 tzdata zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 20001 anotherrae \
    && useradd --no-create-home --uid 20001 --gid 20001 --home-dir /var/lib/anotherrae/data anotherrae \
    && mkdir -p /var/lib/anotherrae/data /var/lib/anotherrae/private

COPY --chmod=0755 bin/node /usr/local/bin/node
WORKDIR /opt/anotherrae
COPY --chown=20001:20001 package.json package-lock.json ./
COPY --chown=20001:20001 server/ server/
COPY --chown=20001:20001 shared/ shared/
COPY --chown=20001:20001 dist/ dist/
COPY --chown=20001:20001 .local/ews-runtime/linux-x64/ .local/ews-runtime/linux-x64/
COPY --chown=20001:20001 node_modules/ node_modules/

RUN --mount=type=bind,source=bind-container.mjs,target=/tmp/bind-container.mjs,ro \
    test -n "$RAE_RELEASE" \
    && node /tmp/bind-container.mjs server/index.ts

ENV HOME=/var/lib/anotherrae/data \
    TZ=UTC \
    NODE_OPTIONS=--max-old-space-size=512
USER 20001:20001
RUN test "$(node --version)" = v24.22.1 \
    && test -r server/index.ts \
    && node --import tsx -e "require('node:sqlite'); require('sharp'); require('@libsql/client'); require('onnxruntime-node')" \
    && test -x .local/ews-runtime/linux-x64/AnotherRae.Ews
EXPOSE 4317
STOPSIGNAL SIGTERM
CMD ["/bin/sh", "-c", "umask 077; exec node --import tsx server/index.ts"]
