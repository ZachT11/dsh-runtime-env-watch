# DSH Runtime Environment Watch

[English](README.en.md) | 中文

给 **DeepSeek Harness（DSH）** 的 AI 运行环境巡检插件：工作目录、Git 分支/HEAD/已跟踪改动、关键文件 mtime、Node/pnpm/git 版本、Shell 和平台。

它解决一些大模型（如 deepseekV4.1F1017）在上下文里最常见的两类失误：

- 模型在会话开头跑一次 `pwd` / `git status` / `node -v`，之后默认环境没变；
- 模型把第一次检查结果当成永久权威，直到命令失败才回头怀疑。

## 功能

- **带时间戳的巡检消息**：首次巡检、cwd / Git 分支 / HEAD 变化立即推送；文件 mtime、改动数等普通变化有 60 秒合并窗口；默认每 10 分钟一次心跳。消息出现在模型输入尾部，带采集时间、数据年龄和变化量。
- **静态规则段**：系统提示里只放固定规则（`interpolate: false`），说明运行环境是快照、最新巡检或 `runtime_env` 才有效、过期先刷新。没有会变的数值，系统提示前缀保持稳定。
- **`runtime_env` 工具**：模型可随时主动检查；`refresh: true` 强制重新探测。
- **开关**：`enabled` 默认开启。关掉后静态规则、自动巡检和 `runtime_env` 一起停用。

这样模型不需要“记得去检查”：变化和心跳会主动到达；每次结果都带时间戳和 TTL，第一次检查不会被当成永久结论。

## 监控事实

- 工作目录（按 Session 的 `workingDirectory` 服务读取）
- 平台 / 架构 / OS release / Shell / Node 版本
- Git：分支、短 HEAD、已跟踪改动数量（修改 / 新增 / 删除）
- `package.json` 的 `packageManager` 字段（如 `pnpm@11.19.0`）
- 关键文件 mtime / size：默认 `package.json`、`pnpm-lock.yaml`、`package-lock.json`、`yarn.lock`、`AGENTS.md`、`tsconfig.json`

Shell 优先探测 `pwsh` / `powershell` 的版本，探测不到才回退 `ComSpec` / `SHELL`。

## 一条巡检长这样

```text
【AI 运行环境巡检】第 3 轮 · 第 1 步 · 采集于 2026/10/26 01:19:11（0 秒前）
工作目录：D:\Project\DSH\寻找
平台：Windows_NT 10.0.26100（x64） / Node v24.21.0 / pnpm@11.19.0 / git version 2.56.0.windows.1
Shell：PowerShell 7.6.6
Git：当前目录不是 Git 仓库（git 可用）
关键文件：package.json 20:06:21；package-lock.json 20:06:21；AGENTS.md 不存在
变化：首次巡检，无历史可比
规则：运行环境是带时间戳的快照，不是常量。会话早期的 pwd、git status、node -v 只能作历史；
执行依赖目录、Git、关键文件或工具链的操作前，以最新巡检或 runtime_env 结果为准；过期就先刷新。
```

## 安装

### 从 GitHub 安装

```powershell
dsh plugin --profile desktop add --allow-build=dsh-runtime-env-watch github:ZachT11/dsh-runtime-env-watch --trust-lockfile
```

- `--allow-build`：允许 Git 源码包执行 `prepare` 构建。
- `--trust-lockfile`：新仓库首次发布不足 24 小时时，pnpm 的 `minimumReleaseAge` 会拦截；不接受该选项时可去掉。
- 桌面应用 profile 是 `desktop`；`dsh web` 用 `web`。
- 如果 pnpm 拒绝执行构建，按它打印的包键在 profile 的 `pnpm-workspace.yaml` 里加：
  ```yaml
  allowBuilds:
    dsh-runtime-env-watch: true
  ```

### 从本地 checkout 安装

```powershell
dsh plugin --profile desktop add .\dsh-runtime-env-watch
dsh --profile desktop --dump-config   # 可选：确认出现 runtime-env-watch 层
```

重启 DSH 后生效。卸载：

```powershell
dsh plugin --profile desktop remove dsh-runtime-env-watch
```

## 使用

1. 正常对话即可。第一次 `agent/pre-step` 后会收到 `【AI 运行环境巡检】`；之后在环境变化或心跳时更新。
2. 需要确认当前状态时，让模型“检查运行环境”；它会调用 `runtime_env`。也可以要求强制刷新（`refresh: true`）。
3. **设置 → 插件** 里应有 `runtime-env-watch` 的自动表单，只有 `enabled` 一个勾选框。没有出现时，在 profile 的 `cordis.patch.yml` 里设置 `enabled: false` 并重启。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（volatile，切换后下一次请求生效） |
| `probeSeconds` | `30` | 两次探测之间的最小间隔 |
| `reminderMinutes` | `10` | 无变化时的心跳间隔 |
| `staleMinutes` | `10` | 巡检超过该年龄时在文本里标 TTL 提醒 |
| `watchFiles` | 见上 | 关键文件列表 |
| `sectionOrder` | `21` | 静态规则段在系统提示中的位置 |

`probeSeconds`、`reminderMinutes`、`staleMinutes`、`watchFiles` 是普通配置，不在自动表单里；修改后需要重启。

## 它不是什么

这是**运行环境巡检**，不是**项目依赖预检（doctor）**：

- 它能报出 Node / git / pnpm 的版本，但不会读 `engines`、`.nvmrc`、`requirements.txt`、`pyproject.toml` 去做 semver 比对；
- 它不会检查 Python / Java / .NET / Docker / 数据库 / 系统库是否安装；
- 它只看 DSH 所在的这台机器，不检查目标部署机。

“这个项目在这台电脑上还缺什么才能跑”需要单独的 `runtime_doctor`：读项目清单 → 探测已安装 → 比对 → 返回 missing/mismatch。两者可以并存，但职责不同。

## 开发与验证

```powershell
pnpm install --node-linker=hoisted
pnpm run check
```

`pnpm run check` 覆盖：类型检查、构建、快照解析、增量、TTL、真实 `SystemPrompt` + `agent/pre-step` waterfall、`runtime_env` 工具执行。

## 限制

- `git status` 只统计已跟踪改动；未跟踪文件变化不会触发推送（避免大仓库扫描过慢）。
- 探测走 DSH 的 `ctx.subprocess`，受 Host 的 PATH 和执行环境限制；`git` 不可用时会明确写出来。
- 不监控进程、端口、完整环境变量；这些需要单独的数据源。
- 关掉开关不会撤回已经产生的历史巡检消息。

## License

MIT
