# Tenon Docker deployment

Build from the verified Linux x86-64 release and dependency snapshot. Use a separate build directory containing `package.json`, `package-lock.json`, `server/`, `shared/`, `dist/`, `.local/ews-runtime/linux-x64/`, `node_modules/`, and `bin/node` from Node 24.22.1. Keep production state and credentials outside this directory.

Copy `Dockerfile` and `bind-container.mjs` into that directory. Build with the frozen release identifier as `RAE_RELEASE` and use a unique image tag for each release.

```sh
docker build --platform linux/amd64 \
  --build-arg RAE_RELEASE="$release" \
  --tag "anotherrae:$release" "$build_context"
```

The build checks the required native modules and changes the listener inside the container. Compose publishes that port on the host loopback for Nginx.

The default host state directory is `/srv/anotherrae`. Provide the complete data directory and two private files before starting the service.

| Host path | Use |
| --- | --- |
| `data/` | Persistent application data, writable by UID/GID `20001` |
| `private/anotherrae.env` | Root-readable service environment, including `RAE_PUBLIC_ORIGIN` |
| `private/web-user.json` | Existing web authentication file, readable by UID `20001` |

Restrict the data directory and credential files to their owners. The bind mounts retain the existing absolute data and authentication paths inside the container. Set the service's network environment for the destination host.

```sh
export ANOTHERRAE_IMAGE="anotherrae:$release"
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml up -d
curl --fail http://127.0.0.1:4317/api/health
```

For a smoke check, set `AR_STATE_DIR` and `AR_HOST_PORT` to isolated values, set a separate project name with `-p`, and use data without active connectors or inference. During a production cutover, pause and drain the old runtime before stopping it. Verify the runtime lock has cleared before snapshotting the data and starting the destination. Compose sends SIGTERM and waits for the service to finish its shutdown.

## Linux task worker

The worker is a separate Compose service with one concurrent project. The API registers its deployment UUID and name through `RAE_SERVER_WORKER_ID` and `RAE_SERVER_WORKER_NAME`, and authenticates it using `RAE_SERVER_WORKER_CREDENTIAL_HASH`. Keep the randomly generated bearer in the worker's own `credential` file (mode 0600, UID 20002). Pass only its SHA-256 digest to the application. Keep the same UUID for ordinary upgrades and preserve `journal/` (mode 0700, UID 20002).

Run `node ops/linux/build-worker.mjs <context> <profile>` from the repo root with the [Moby seccomp v0.2.4 baseline](https://raw.githubusercontent.com/moby/profiles/seccomp/v0.2.4/seccomp/default.json). The build script downloads and verifies the complete pinned Linux App Server distribution into `codex/`. Build the image using `worker.Dockerfile` and the verified app image tag as `RAE_BASE_IMAGE`. The archive and component hashes are recorded in [shared/codex-runtime.ts](../../shared/codex-runtime.ts). Store the generated `seccomp.json`, `worker.compose.yaml`, `worker.resolv.conf` and `worker-egress.nft` in `/srv/anotherrae-worker-ops`. Keep image and device ID in that Compose project's `.env`.

Load the dedicated AppArmor profile and install the two socket relay units and worker service from this directory. Register the local system group `anotherrae-worker-api` with GID 20002 for the relay socket. The worker service applies its own nftables table before starting. It uses a dedicated IPv4 bridge for public egress and a Unix socket for the device API. Keep that socket, the credential, the journal and all production mounts outside the job sandbox. The worker verifies the pinned engine, namespace enforcement, cgroup limits and scratch size before reporting availability.

Verify changes with `scripts/verify-linux-project-worker.ts` bundled for Node as an entrypoint in a disposable worker container using the same limits and profiles. Use fixture data and an isolated journal. Confirm that only the worker bridge is affected by the firewall rules, and check public egress as well as denied host and private addresses. Never mount the live journal into an acceptance container. For rollback, pause and drain the runtime, stop the worker and relay, restore the application and frontend pointers, and keep the worker's journal and task receipts for audit. Remove only the worker's dedicated nftables table after its container stops.
