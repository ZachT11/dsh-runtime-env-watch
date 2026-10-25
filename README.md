# DSH Runtime Environment Watch

[English](README.en.md) | 中文

给 **DeepSeek Harness（DSH）** 的定时状态巡检插件：不只检查模型的工作环境（cwd、Git、关键文件、工具链），还可以定时检查**电脑硬件**（CPU、内存、磁盘、电池、GPU、进程、端口、温度）和**远程设备/机器人**（HTTP JSON、SSH/命令、TCP、文件心跳）。

每条状态都带采集时间、数据年龄、阈值和异常标记；定时器在 Host 里按秒调度，和模型是否有动作无关。

它解决一些大模型（如 deepseekV4.1F1017）在上下文里最常见的两类失误：

- 模型在会话开头跑一次 `pwd` / `git status` / `node -v`，之后默认环境没变；
- 模型把第一次检查结果当成永久权威，直到命令失败才回头怀疑。

硬件和机器人状态同理：温度、占用、电量、网络、机器人模式都会变，不能只看一次。

## 它做什么

1. **静态规则**：系统提示里只放固定规则（`interpolate: false`），说明环境/硬件/远程状态都是带时间戳的快照，最新巡检或工具结果才有效，过期先刷新。没有会变的数值，系统提示前缀保持稳定。
2. **定时调度**：`CheckScheduler` 每秒 tick，按每个 check 的 `intervalSeconds` 到期执行；结果保存在内存里。配置文件的 mtime 变化会在 5 秒内热加载。
3. **模型输入推送**：在 `agent/pre-step` 时把最新运行时/硬件/远程状态拼成一条带时间戳的消息放到模型输入尾部；首次、环境重大变化、状态变化、阈值告警或心跳（默认 10 分钟）时推送。
4. **工具**：
   - `runtime_env`：只看模型工作环境（cwd、Git、关键文件、工具链）。
   - `status_check`：立即跑全部或指定的状态检查，返回运行时 + 硬件 + 远程设备的合并报告。
5. **开关**：`enabled` 默认开启。关掉后静态规则、定时检查、两个工具一起停用。

## 快速开始

### 从 GitHub 安装

```powershell
dsh plugin --profile desktop add --allow-build=dsh-runtime-env-watch github:ZachT11/dsh-runtime-env-watch --trust-lockfile
```

新仓库不足 24 小时时 pnpm 的 `minimumReleaseAge` 会拦截，所以需要 `--trust-lockfile`。如果 pnpm 拒绝执行构建，在 profile 的 `pnpm-workspace.yaml` 加：

```yaml
allowBuilds:
  dsh-runtime-env-watch: true
```

### 从本地 checkout 安装

```powershell
dsh plugin --profile desktop add .\dsh-runtime-env-watch
dsh --profile desktop --dump-config   # 可选
```

重启 DSH 后生效。卸载：

```powershell
dsh plugin --profile desktop remove dsh-runtime-env-watch
```

### 默认行为

没有 `runtime-checks.json` 时，只跑内置硬件检查：

- CPU 使用率 / 核数
- 内存已用 / 总量
- 系统盘已用 / 剩余
- 开机时长

这些走 Node 的 `os` / `fs.statfs`，不需要 PowerShell。

## 配置检查项

检查项定义在 `runtime-checks.json`，路径由 `checksFile` 控制，默认相对于当前 workspace。它是普通 JSON，支持热加载；**不要提交带密钥的实际配置**，仓库已把 `runtime-checks.json` 加进 `.gitignore`。

完整样例见 [runtime-checks.example.json](runtime-checks.example.json)。

最小硬件示例：

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

### 通用字段

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一名称，报告和 `status_check({id})` 用它 |
| `kind` | `hardware` / `http` / `command` / `tcp` / `file` |
| `intervalSeconds` | 该检查的周期，5–3600，缺省用 `statusIntervalSeconds` |
| `timeoutMs` | 单次检查超时，缺省由周期推导，最多 15 秒 |
| `enabled` | `false` 时不执行 |
| `expect` | 阈值/断言，见下 |

### hardware

`metrics` 可选：`cpu`、`memory`、`disk`、`uptime`、`battery`、`gpu`、`processes`、`ports`、`temperature`。

- `cpu` / `memory` / `uptime`：Node `os`，无外部依赖。
- `disk`：Node `fs.statfs`；`diskPaths` 可指定盘符/挂载点，默认系统盘。
- `battery`：PowerShell `Win32_Battery`（WMI），笔记本/带电池设备可用。
- `gpu`：`nvidia-smi`，没有 NVIDIA 驱动会记为失败项。
- `processes` / `ports`：PowerShell `Get-Process` / `Get-NetTCPConnection`。
- `temperature`：WMI `MSAcpi_ThermalZoneTemperature`，很多主板不暴露，失败会明确写出。

示例：

```json
{
  "id": "battery",
  "kind": "hardware",
  "intervalSeconds": 60,
  "metrics": ["battery"],
  "expect": { "battery.percent": { "min": 20 } }
}
```

### http（远程机器人/服务）

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

- `fields` 用点路径从 JSON 里取值，也支持 `[0]` 数组下标。
- 没有 `fields` 时，整个 JSON 对象作为数据；`_status` 是 HTTP 状态码。
- 非 2xx 直接算失败；超时由 `timeoutMs` 控制。

### command（SSH/ROS/本地脚本）

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

- `command` 是 argv 数组，不经过 shell，避免引号/注入问题。
- `json: true` 时解析 stdout；否则把 stdout 放进 `stdout` 字段。
- 可以用 SSH、`ros2 topic echo --once`、本地桥接脚本、PLC/机器人厂商 CLI。
- 命令以 Host 权限执行，只配置可信命令。

### tcp（端口/链路）

```json
{
  "id": "robot-link",
  "kind": "tcp",
  "intervalSeconds": 5,
  "host": "192.168.1.50",
  "port": 8080
}
```

连不上/超时记为失败。

### file（心跳文件）

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

- `exists: false` 表示“文件必须不存在”。
- `minSize` / `maxAgeSeconds` 不满足会告警。

### expect 断言

`expect` 的 key 是数据路径，value 支持：

- `min` / `max`：数值范围
- `equals`：严格相等（对象/数组按稳定序列化比较）
- `contains`：字符串包含
- `exists`：是否存在（`null` 是否算存在由这条规则决定）

不满足时该 check 标记为“异常”，报告里带具体原因。

## 插件配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（volatile，切换后下一次请求生效） |
| `probeSeconds` | `30` | 运行时环境（`runtime_env`）的最小探测间隔 |
| `statusIntervalSeconds` | `30` | 检查项没有写 `intervalSeconds` 时的默认周期 |
| `reminderMinutes` | `10` | 无变化时的心跳间隔 |
| `staleMinutes` | `10` | 状态超过该年龄时在报告里标“数据已过期” |
| `watchFiles` | 见源码 | 运行时巡检关注的关键文件 |
| `checksFile` | `runtime-checks.json` | 检查项配置文件，相对 workspace 或绝对路径 |
| `sectionOrder` | `21` | 静态规则段在系统提示里的位置 |

`probeSeconds`、`statusIntervalSeconds`、`reminderMinutes`、`staleMinutes`、`watchFiles`、`checksFile` 是普通配置，不在自动设置表单里；改 profile 的 `cordis.patch.yml` 后重启。

## 使用

正常对话即可。第一次 `agent/pre-step` 后会看到：

```text
【AI 运行环境巡检】第 3 轮 · 第 1 步 · 采集于 2026/10/26 07:51:55（0 秒前）
工作目录：D:/Project/DSH/寻找
平台：Windows_NT 10.0.26100（x64） / Node v24.21.0 / git version 2.56.0.windows.1
Shell：PowerShell 7.6.6
Git：当前目录不是 Git 仓库（git 可用）
关键文件：package.json 20:06:21；package-lock.json 20:06:21
变化：首次巡检，无历史可比
规则：……

【硬件与远程状态】按配置周期巡检；采集于 2026/10/26 07:51:55
- 硬件：正常；CPU 12%（12 核）；内存 63%（9.6 GB/15.2 GB）；磁盘 C:\ 已用 63.2%（剩余 73.6 GB）；开机 6d 15h
- robot：正常；battery=78；mode=AUTO；x=1.2；error=null
异常：robot battery=12 < 20
```

- 让模型“检查运行环境”：调用 `runtime_env`。
- 让模型“检查所有状态/机器人状态”：调用 `status_check`；可传 `{ "id": "robot" }` 或 `{ "refresh": true }`。
- 设置 → 插件里的 `runtime-env-watch` 自动表单只有 `enabled` 一个开关。

## 安全与限制

- `command` / `http` 检查以 Host 权限执行；只配置可信地址和命令。`runtime-checks.json` 已被 `.gitignore` 忽略，不要把 token、密码提交到仓库。
- 定时器只在 DSH 运行时工作；DSH 关闭后不会检查。
- 检查结果在**下一次模型 step** 才注入会话；模型空闲时不会主动弹聊天通知。需要“无人值守告警”要再接通知渠道（邮件/IM/webhook）或 DSH automation。
- 硬件指标依赖平台：battery/processes/ports/temperature 需要 PowerShell/WMI；GPU 需要 `nvidia-smi`；没有对应能力时会在报告里明确写失败项，不会假装正常。
- 它是“状态巡检”，不是“项目依赖预检（doctor）”：不读 `engines`/requirements 做 semver 比对，也不检查目标部署机。
- 不原生支持 MQTT/ROS 协议；用 `command` 调 `ros2`、`mosquitto_sub` 或本地桥接脚本即可。

## 开发与验证

```powershell
pnpm install --node-linker=hoisted
pnpm run check
```

`pnpm run check` 覆盖：运行时巡检、硬件解析、HTTP/命令/TCP/文件检查、阈值、配置解析、调度器、pre-step 推送和两个工具。

## License

MIT
