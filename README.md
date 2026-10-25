# DSH Runtime Environment Watch

给 DeepSeek Harness 的**AI 运行环境**巡检插件：工作目录、Git 分支/HEAD/已跟踪改动、关键文件 mtime、Node/pnpm/git 版本、Shell 和平台。它解决的是长上下文里最常见的两类失误：

- 模型在会话开头跑一次 `pwd` / `git status` / `node -v`，之后默认环境没变；
- 模型把第一次检查结果当成永久权威，直到出错才回头怀疑。

## 做法

1. **静态规则**：系统提示里只放一段固定规则（`interpolate: false`），说明运行环境是带时间戳的快照、最新巡检或 `runtime_env` 结果才有效、过期先刷新。没有会变的数值，前缀缓存稳定。
2. **`agent/pre-step` 推送**：首次巡检、cwd/Git 分支/HEAD 变化立即推送；文件 mtime、改动数等普通变化有 60 秒合并窗口；默认每 10 分钟至少推送一次心跳。消息在模型输入尾部，带采集时间、数据年龄和变化量。
3. **`runtime_env` 工具**：模型可随时主动检查；`refresh: true` 强制重新探测，返回同一份带时间戳的文本。

这样模型不需要“记得去检查”：变化和心跳会主动到达；而每次结果都带时间戳和 TTL，第一次检查不会被当成永久结论。

## 监控事实

- 工作目录（按 Session 的 `workingDirectory` 服务读取）
- 平台 / 架构 / OS release / Shell / Node 版本
- Git：分支、短 HEAD、已跟踪改动数量（修改/新增/删除）
- `packageManager` 字段（如 `pnpm@11.19.0`）
- 关键文件 mtime/size：默认 `package.json`、`pnpm-lock.yaml`、`package-lock.json`、`yarn.lock`、`AGENTS.md`、`tsconfig.json`

未跟踪文件不计入 `git status`（避免大仓库扫描过慢）；进程、端口、环境变量不在默认范围内，需要时可扩展。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（volatile，保存后下一次请求生效） |
| `probeSeconds` | `30` | 两次探测之间的最小间隔 |
| `reminderMinutes` | `10` | 无变化时的心跳间隔 |
| `staleMinutes` | `10` | 巡检超过该年龄时在文本里标 TTL 提醒 |
| `watchFiles` | 见上 | 关键文件列表 |
| `sectionOrder` | `21` | 静态规则段在系统提示中的位置 |

## 安装

从本地 checkout（`dsh plugin` 会把包追加到 profile 的 `dsh.profile.bundles`）：

```powershell
dsh plugin --profile desktop add .\dsh-runtime-env-watch
dsh --profile desktop --dump-config   # 可选：确认出现 runtime-env-watch 层
```

重启 DSH 后生效。卸载：

```powershell
dsh plugin --profile desktop remove dsh-runtime-env-watch
```

## 验证

- 设置里不需要页面；插件没有客户端部分。
- 对话里第一次 `agent/pre-step` 后会出现一条 `【AI 运行环境巡检】` 上下文消息。
- 让模型“检查一下运行环境”，它应调用 `runtime_env` 或引用最新巡检，而不是复述会话开头的结果。
- `pnpm run check` 覆盖快照解析、增量、TTL、pre-step 推送和工具执行。

## 限制

- `git status` 只统计已跟踪改动；未跟踪文件变化不会触发推送。
- 探测走 `ctx.subprocess`，受 Host 的执行环境与 PATH 影响；`git` 不在 PATH 时巡检会标记为“非 Git 仓库/不可用”。
- 插件不监控进程、端口、完整环境变量；这些需要单独的数据源。
