# DSH Runtime Environment Watch

English | [中文](README.md)

Periodic status checks for **DeepSeek Harness (DSH)**: the model's runtime environment (cwd, Git, key files, toolchain), **computer hardware** (CPU, memory, disk, battery, GPU, processes, ports, temperature), and **remote devices/robots** (HTTP JSON, SSH/command, TCP, file heartbeat).

Every state carries an observation time, age, thresholds, and an alert flag. The scheduler runs in the Host on wall-clock time, independent of whether the model is taking a step.

It targets two common in-context failures in some large models (such as deepseekV4.1F1017):

- the model runs `pwd` / `git status` / `node -v` once at the start, then assumes nothing changed;
- the model treats the first check as permanently authoritative until a command fails.

The same applies to hardware and robots: temperature, utilization, battery, network, and robot mode all change.

## What it does

1. **Static policy** — fixed rules in the system prompt (`interpolate: false`): environment, hardware, and remote states are timestamped snapshots; the newest audit or tool result wins; refresh when expired. No changing values, so the prompt prefix stays cache-friendly.
2. **Periodic scheduler** — `CheckScheduler` ticks every second and runs each check when its `intervalSeconds` is due; results stay in memory. The config file is hot-reloaded within 5 seconds of an mtime change.
3. **Model-input push** — at `agent/pre-step`, the latest runtime, hardware, and remote states are appended as one timestamped message at the tail. It is pushed on first observation, major environment change, status change, threshold alert, or heartbeat (10 minutes by default).
4. **Tools**:
   - `runtime_env` — runtime environment only (cwd, Git, key files, toolchain).
   - `status_check` — run all or one configured check now and return the combined runtime + hardware + remote report.
5. **Switch** — `enabled` defaults to true. Turning it off stops the policy, the scheduler, and both tools.

## Quick start

### From GitHub

```powershell
dsh plugin --profile desktop add --allow-build=dsh-runtime-env-watch github:ZachT11/dsh-runtime-env-watch --trust-lockfile
```

The `minimumReleaseAge` gate needs `--trust-lockfile` for a repository published less than 24 hours ago. If pnpm refuses the build, add this to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-runtime-env-watch: true
```

### From a local checkout

```powershell
dsh plugin --profile desktop add .\dsh-runtime-env-watch
dsh --profile desktop --dump-config   # optional
```

Restart DSH. Uninstall:

```powershell
dsh plugin --profile desktop remove dsh-runtime-env-watch
```

### Defaults

Without `runtime-checks.json`, only the built-in hardware check runs:

- CPU usage / cores
- Memory used / total
- System disk used / free
- Uptime

These use Node `os` / `fs.statfs` and need no PowerShell.

## Configuring checks

Checks live in `runtime-checks.json` (path controlled by `checksFile`, relative to the workspace by default). It is plain JSON, hot-reloaded, and **must not be committed with secrets** — the repository ignores `runtime-checks.json`.

See [runtime-checks.example.json](runtime-checks.example.json). The `battery`, `gpu`, and `robot` entries require the actual hardware or service; remove the checks/metrics you do not have.

Minimal hardware example:

```json
{
  "checks": [
    {
      "id": "hardware",
      "kind": "hardware",
      "intervalSeconds": 15,
      "metrics": ["cpu", "memory", "disk", "uptime"]
    }
  ]
}
```

### Common fields

| Field | Meaning |
| --- | --- |
| `id` | Unique name used in the report and `status_check({id})` |
| `kind` | `hardware` / `http` / `command` / `tcp` / `file` |
| `intervalSeconds` | Per-check period, 5–3600; defaults to `statusIntervalSeconds` |
| `timeoutMs` | Per-run timeout; derived from the period by default, capped at 15 seconds |
| `enabled` | `false` skips the check |
| `expect` | Thresholds/assertions, see below |

### hardware

`metrics`: `cpu`, `memory`, `disk`, `uptime`, `battery`, `gpu`, `processes`, `ports`, `temperature`.

- `cpu` / `memory` / `uptime`: Node `os`, no external dependencies.
- `disk`: Node `fs.statfs`; `diskPaths` defaults to the system drive.
- `battery`: PowerShell `Win32_Battery` (WMI).
- `gpu`: `nvidia-smi`; a machine without NVIDIA drivers reports a failed metric.
- `processes` / `ports`: PowerShell `Get-Process` / `Get-NetTCPConnection`.
- `temperature`: WMI `MSAcpi_ThermalZoneTemperature`; many boards do not expose it, and the failure is reported explicitly.

```json
{
  "id": "battery",
  "kind": "hardware",
  "intervalSeconds": 60,
  "metrics": ["battery"],
  "expect": { "battery.percent": { "min": 20 } }
}
```

### http (remote robot/service)

```json
{
  "id": "robot",
  "kind": "http",
  "intervalSeconds": 10,
  "url": "http://192.168.1.50:8080/api/status",
  "headers": { "Authorization": "Bearer REPLACE_ME" },
  "fields": {
    "battery": "battery.level",
    "mode": "mode",
    "x": "pose.x",
    "y": "pose.y",
    "error": "error"
  },
  "expect": {
    "battery": { "min": 20 },
    "error": { "equals": null }
  }
}
```

- `fields` maps names to dot paths; `[0]` array indexes are supported.
- Without `fields`, the parsed JSON is the data; `_status` holds the HTTP status.
- Non-2xx responses fail immediately; timeouts use `timeoutMs`.

### command (SSH/ROS/local scripts)

```json
{
  "id": "robot-camera",
  "kind": "command",
  "intervalSeconds": 15,
  "command": ["ssh", "robot@192.168.1.50", "cat /run/camera.json"],
  "json": true,
  "fields": { "fps": "fps", "online": "online" },
  "expect": { "fps": { "min": 5 } }
}
```

- `command` is an argv array; no shell, so quoting/injection is avoided.
- `json: true` parses stdout; otherwise stdout goes into the `stdout` field.
- Use SSH, `ros2 topic echo --once`, a local bridge, or a vendor CLI.
- Commands run with Host privileges; only configure trusted commands.

### tcp (port/link)

```json
{
  "id": "robot-link",
  "kind": "tcp",
  "intervalSeconds": 5,
  "host": "192.168.1.50",
  "port": 8080
}
```

A refused connection or timeout is a failure.

### file (heartbeat)

```json
{
  "id": "robot-heartbeat",
  "kind": "file",
  "intervalSeconds": 15,
  "path": "D:/robot/heartbeat.json",
  "maxAgeSeconds": 60,
  "minSize": 1
}
```

- `exists: false` means “the file must not exist”.
- `minSize` / `maxAgeSeconds` violations alert.

### expect

Keys are data paths; values support:

- `min` / `max`: numeric range
- `equals`: strict equality (objects/arrays compare by stable serialization)
- `contains`: substring
- `exists`: presence (`null` handling follows the rule)

A failed rule marks the check as unhealthy with the concrete reason.

## Plugin configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch (volatile; next request) |
| `probeSeconds` | `30` | Minimum probe interval for `runtime_env` |
| `statusIntervalSeconds` | `30` | Default period for checks without `intervalSeconds` |
| `reminderMinutes` | `10` | Heartbeat when nothing changes |
| `staleMinutes` | `10` | Age at which a report marks data as expired |
| `watchFiles` | see source | Runtime key-file list |
| `checksFile` | `runtime-checks.json` | Check config, workspace-relative or absolute |
| `sectionOrder` | `21` | Static policy section placement |

`probeSeconds`, `statusIntervalSeconds`, `reminderMinutes`, `staleMinutes`, `watchFiles`, and `checksFile` are ordinary config, not in the auto form; edit the profile's `cordis.patch.yml` and restart.

## Usage

Chat normally. The first `agent/pre-step` produces:

```text
[AI runtime audit] turn 3 step 1 · collected 2026-10-26 07:51:55 (0s ago)
Working directory: D:/Project/DSH/寻找
Platform: Windows_NT 10.0.26100 (x64) / Node v24.21.0 / git version 2.56.0.windows.1
Shell: PowerShell 7.6.6
Git: not a Git work tree (git is available)
Key files: package.json 20:06:21; package-lock.json 20:06:21
Changes: first audit, no history to compare
Rules: ...

[Hardware and remote status] per configured interval; collected 2026-10-26 07:51:55
- hardware: ok; CPU 12% (12 cores); memory 63% (9.6 GB/15.2 GB); disk C:\ used 63.2% (73.6 GB free); uptime 6d 15h
- robot: ok; battery=78; mode=AUTO; x=1.2; error=null
Alerts: robot battery=12 < 20
```

- “check the runtime environment” → `runtime_env`.
- “check all statuses / the robot” → `status_check`, optionally `{ "id": "robot" }` or `{ "refresh": true }`.
- **Settings → Plugins** shows the auto `runtime-env-watch` form with the single `enabled` checkbox.

## Security and limitations

- `command` / `http` checks run with Host privileges; only configure trusted addresses and commands. `runtime-checks.json` is gitignored; never commit tokens or passwords.
- The scheduler only runs while DSH is running.
- Results are injected at the **next model step**; no chat notification appears while the model is idle. For unattended alerting, add a webhook/IM/email channel or a DSH automation.
- Hardware metrics are platform-dependent: battery/processes/ports/temperature need PowerShell/WMI; GPU needs `nvidia-smi`. Missing capabilities are reported as failures, never silently treated as healthy.
- This is a **status audit**, not a **project preflight/doctor**: it does not compare manifest requirements or inspect a separate deployment target.
- MQTT/ROS are not native; use `command` to call `ros2`, `mosquitto_sub`, or a local bridge.

## Development

```powershell
pnpm install --node-linker=hoisted
pnpm run check
```

`pnpm run check` covers runtime audit, hardware parsing, HTTP/command/TCP/file checks, thresholds, config parsing, scheduler, pre-step push, and both tools.

## License

MIT
