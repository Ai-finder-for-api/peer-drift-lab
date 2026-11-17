# Security model

Registry inspection uses `npm pack --ignore-scripts`; candidates are extracted to
a disposable directory. Path traversal, hard links and symbolic links are filtered.
Do not inspect untrusted packages on a machine containing sensitive credentials:
archive bombs, compiler resource exhaustion and npm/tool vulnerabilities remain
possible. Pin trusted dependency versions and review the lockfile.

Simulation is explicit. It never falls back to host execution when Docker is
unavailable. A disposable project copy is mounted read/write; the original,
Docker socket, home directory and host environment variables are not mounted or
forwarded. The root filesystem is read-only and capabilities are dropped. CPU,
memory, process and time limits are enforced. Install scripts are disabled.
Install needs network; tests have no network unless explicitly enabled. Test
scripts themselves do execute inside the container.

Secret exclusion is best-effort, not a data-loss-prevention boundary: `.env*`,
`.npmrc`, common key files and credential directories are excluded, but secrets
can be embedded in arbitrary source files or lockfile URLs. Review the project
before simulation. Test logs can contain application secrets. Docker containers
share the host kernel and are not a sufficient boundary for hostile code. Use an
isolated disposable VM/runner for untrusted projects. Docker image tags are
mutable; use `--image name@sha256:...` for reproducibility.

Default limitations: no private registry credential forwarding, no install
lifecycle hooks, npm-only simulation, and no Docker-in-Docker.

Report vulnerabilities privately to the repository owner. Never include tokens
or secrets in issues, logs, npm package files or reproduction projects.
