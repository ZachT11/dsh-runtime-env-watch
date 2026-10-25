# DSH Runtime Environment Watch

English | [中文](README.md)

A runtime-environment watchdog for **DeepSeek Harness (DSH)**: working directory, Git branch/HEAD/tracked changes, key file mtimes, Node/pnpm/git versions, Shell, and platform.

> The audit text emitted by this version is Chinese; the example below is translated for readability.

It targets two common in-context failures in some large models (such as deepseekV4.1F1017):

- the model runs `pwd` / `git status` / `node -v` once at the start, then assumes nothing changed;
- the model treats the first check as permanently authoritative until a command fails.

## Features

- **Timestamped audits**: the first probe, cwd / Git branch / HEAD changes are pushed immediately; ordinary file mtime and tracked-change updates are merged into a 60-second window; a heartbeat runs every 10 minutes by default. Messages arrive at the tail of the model input with observation time, age, and deltas.
- **Static policy section**: the system prompt contains only fixed rules (`interpolate: false`) — runtime facts are snapshots, the newest audit or `runtime_env` result wins, and expired facts must be refreshed. No changing values, so the prompt prefix stays cache-friendly.
- **`runtime_env` tool**: on-demand inspection; `refresh: true` forces a new probe.
- **Switch**: `enabled` defaults to true. Turning it off stops the policy, the automatic audits, and the tool.

The model does not need to remember to check: changes and heartbeats arrive on their own, and every result is timestamped with a TTL, so the first reading never becomes a permanent conclusion.

## What it observes

- Working directory (from the Session's `workingDirectory` service)
- Platform / architecture / OS release / Shell / Node version
- Git: branch, short HEAD, tracked change count (modified / added / deleted)
- `packageManager` from `package.json` (e.g. `pnpm@11.19.0`)
- Key file mtime/size: by default `package.json`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `AGENTS.md`, `tsconfig.json`

Shell detection prefers `pwsh` / `powershell` version probing and falls back to `ComSpec` / `SHELL`.

## Example

```text
[AI runtime audit] turn 3 step 1 · collected 2026-10-26 01:19:11 (0s ago)
Working directory: D:\Project\DSH\寻找
Platform: Windows_NT 10.0.26100 (x64) / Node v24.21.0 / pnpm@11.19.0 / git version 2.56.0.windows.1
Shell: PowerShell 7.6.6
Git: not a Git work tree (git is available)
Key files: package.json 20:06:21; package-lock.json 20:06:21; AGENTS.md missing
Changes: first audit, no history to compare
Rules: runtime facts are timestamped snapshots, not constants. Earlier pwd/git status/node -v readings are history only;
before actions that depend on cwd, Git, key files, or toolchain, rely on the newest audit or runtime_env; refresh when expired.
```

## Install

### From GitHub

```powershell
dsh plugin --profile desktop add --allow-build=dsh-runtime-env-watch github:ZachT11/dsh-runtime-env-watch --trust-lockfile
```

- `--allow-build` lets the Git source package run its `prepare` build.
- `--trust-lockfile` skips pnpm's `minimumReleaseAge` gate for a repository published less than 24 hours ago; drop it if your pnpm does not accept the flag.
- The desktop app uses the `desktop` profile; `dsh web` uses `web`.
- If pnpm refuses the build, add the package key it prints to the profile's `pnpm-workspace.yaml`:
  ```yaml
  allowBuilds:
    dsh-runtime-env-watch: true
  ```

### From a local checkout

```powershell
dsh plugin --profile desktop add .\dsh-runtime-env-watch
dsh --profile desktop --dump-config   # optional: confirm the runtime-env-watch layer
```

Restart DSH. Uninstall:

```powershell
dsh plugin --profile desktop remove dsh-runtime-env-watch
```

## Usage

1. Chat normally. After the first `agent/pre-step` you get an audit; later audits appear on change or heartbeat.
2. Ask the model to "check the runtime environment"; it should call `runtime_env`. Use `refresh: true` for a forced probe.
3. **Settings → Plugins** should show an auto-generated `runtime-env-watch` form with the single `enabled` checkbox. If it does not, set `enabled: false` in the profile's `cordis.patch.yml` and restart.

## Configuration

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch (volatile; applies on the next request) |
| `probeSeconds` | `30` | Minimum interval between probes |
| `reminderMinutes` | `10` | Heartbeat interval when nothing changes |
| `staleMinutes` | `10` | Age after which the audit reports a TTL warning |
| `watchFiles` | see above | Key file list |
| `sectionOrder` | `21` | Placement of the static policy section |

`probeSeconds`, `reminderMinutes`, `staleMinutes`, and `watchFiles` are ordinary configuration, not in the auto form; edit and restart.

## What it is not

This is a **runtime audit**, not a **project preflight/doctor**:

- It reports Node / git / pnpm versions but does not read `engines`, `.nvmrc`, `requirements.txt`, or `pyproject.toml` and compare semver ranges.
- It does not check Python / Java / .NET / Docker / databases / system libraries.
- It only inspects the machine running DSH, not a separate deployment target.

Answering "what is missing on this machine to run this project" requires a separate `runtime_doctor`: read manifests → probe installed tools → compare → report missing/mismatch. The two can coexist.

## Development

```powershell
pnpm install --node-linker=hoisted
pnpm run check
```

`pnpm run check` covers type checking, build, snapshot parsing, deltas, TTL, the real `SystemPrompt` + `agent/pre-step` waterfall, and `runtime_env` execution.

## Limitations

- `git status` only counts tracked changes; untracked files do not trigger pushes (to keep large repos fast).
- Probes go through DSH's `ctx.subprocess`, so PATH and the Host execution environment apply; a missing `git` is reported explicitly.
- Processes, ports, and the full environment variable set are not monitored.
- Turning the switch off does not retract audits already in the session history.

## License

MIT
