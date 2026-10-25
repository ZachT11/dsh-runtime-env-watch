import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-subprocess'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-working-directory'
import { collectRuntimeFacts, formatRuntimeAudit, runtimeFingerprint, runtimePolicy, type CommandRunner, type RuntimeFacts } from './runtime.ts'
import { CheckScheduler, hasStatusAlerts, statusFingerprint, type CheckState } from './checks.ts'

export { collectRuntimeFacts, describeRuntimeChanges, formatRuntimeAudit, runtimeFingerprint, runtimePolicy } from './runtime.ts'
export type { RuntimeFacts } from './runtime.ts'
export * from './checks.ts'

export const name = 'runtime-env-watch'
export const inject = ['tools', 'systemPrompt', 'workingDirectory', 'subprocess']

const DEFAULT_FILES = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'AGENTS.md', 'tsconfig.json']
const CHANGE_COOLDOWN_MS = 60_000

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  probeSeconds: z.number().min(5).max(600).default(30),
  statusIntervalSeconds: z.number().min(5).max(3600).default(30),
  reminderMinutes: z.number().min(1).max(120).default(10),
  staleMinutes: z.number().min(1).max(120).default(10),
  watchFiles: z.array(z.string()).default(DEFAULT_FILES),
  checksFile: z.string().default('runtime-checks.json'),
  sectionOrder: z.number().default(21),
})
export type Config = ReturnType<typeof Config>

interface State {
  facts: RuntimeFacts
  at: number
  pushedAt: number
  fingerprint: string
  pending: boolean
  statusFingerprint: string
  alert: boolean
}

function statusPolicy(): string {
  return [
    '【硬件与远程状态规则】',
    '电脑硬件（CPU、内存、磁盘、电池、GPU、进程、端口）和远程设备（HTTP/命令/TCP/文件检查）的状态，通过带时间戳的“硬件与远程状态”段推送；最新一条或 status_check 结果才有效。',
    '阈值、离线、超时和过期都算异常；执行依赖硬件资源或远程设备的操作前先看最新状态，需要立即确认时调用 status_check(refresh=true)。',
    '不要把一次正常状态当成永久保证：温度、占用、电量、网络和机器人状态都会变化。',
  ].join('\n')
}

export function apply(ctx: Context, entry: Config) {
  const states = new Map<string, State>()

  // Route probes through DSH's subprocess seam: executable lookup, output bounds,
  // abort handling, and sandbox policy stay owned by the Host.
  const run: CommandRunner = async (argv, cwd, timeoutMs, signal) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const forwardAbort = () => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 2 * 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
        graceMs: 500,
        signal: controller.signal,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      if (outcome.exitCode !== 0 && !stdout) return stderr.trim() || null
      return (stdout || stderr).trim()
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  const baseDir = (ctx.workingDirectory as any).defaultDirectory ?? process.cwd()
  const logger = (ctx as any).logger
  const scheduler = new CheckScheduler({
    baseDir,
    configPath: entry.checksFile,
    defaultIntervalSeconds: entry.statusIntervalSeconds,
    run,
    enabled: () => entry.enabled.get(),
    logger: (message: string) => logger?.warn?.('[runtime-env-watch] ' + message),
  })
  ctx.effect(() => {
    let disposed = false
    void scheduler.ensure().catch((error: unknown) => logger?.warn?.('[runtime-env-watch] ' + String(error))).finally(() => { if (!disposed) scheduler.start() })
    return () => { disposed = true; scheduler.stop() }
  })

  const statusText = (now: Date): string => scheduler.format(now, entry.staleMinutes)
  const combined = (facts: RuntimeFacts, previous: RuntimeFacts | null, now: Date, turn?: number, step?: number): string => {
    const runtime = formatRuntimeAudit(facts, { previous, now, turn, step, staleMinutes: entry.staleMinutes })
    const status = statusText(now)
    return status ? runtime + '\n\n' + status : runtime
  }

  const probe = async (agent: any, force: boolean, signal?: AbortSignal): Promise<{ state: State; previous: State | undefined }> => {
    const key = String(agent.session.id)
    const previous = states.get(key)
    if (!force && previous && Date.now() - previous.at < entry.probeSeconds * 1000) return { state: previous, previous }
    const cwd = ctx.workingDirectory.get(agent.session)
    const facts = await collectRuntimeFacts(cwd, { watchFiles: [...entry.watchFiles], run, signal })
    const state: State = {
      facts,
      at: Date.now(),
      pushedAt: previous?.pushedAt ?? 0,
      fingerprint: runtimeFingerprint(facts),
      pending: previous?.pending ?? false,
      statusFingerprint: previous?.statusFingerprint ?? '',
      alert: previous?.alert ?? false,
    }
    states.set(key, state)
    return { state, previous }
  }

  // Static policy only: the system prompt never carries changing state values.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'runtime-env-watch',
    order: entry.sectionOrder,
    interpolate: false,
    text: () => entry.enabled.get() ? runtimePolicy() + '\n\n' + statusPolicy() : '',
  }))

  ctx.tools.register(defineTool({
    name: 'runtime_env',
    description: 'Inspect the AI runtime environment with timestamps: working directory, Git branch/HEAD/tracked changes, key file mtimes, Node/pnpm/git versions, Shell and platform. Use refresh=true before actions that depend on the environment instead of trusting an earlier check.',
    parameters: {
      refresh: { type: 'boolean', description: 'Force a fresh probe instead of using the cached snapshot.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Human-readable runtime environment audit.' },
          observedAt: { type: 'string', required: true, description: 'ISO timestamp of the probe.' },
          changed: { type: 'boolean', required: true, description: 'Whether material facts changed since the previous probe.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args: any, exec: any) {
      if (!entry.enabled.get()) throw new Error('runtime_env is disabled: enable runtime-env-watch in Settings → Plugins, or set enabled: true in the plugin config.')
      if (!exec.agent) throw new Error('runtime_env requires an agent Session')
      const { state, previous } = await probe(exec.agent, args?.refresh === true, exec.signal)
      const changed = previous === undefined ? true : previous.fingerprint !== state.fingerprint
      const text = formatRuntimeAudit(state.facts, { previous: previous?.facts ?? null, now: new Date(), staleMinutes: entry.staleMinutes })
      states.set(String(exec.agent.session.id), { ...state, pushedAt: Date.now(), pending: false })
      return { text, observedAt: state.facts.collectedAt, changed }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'status_check',
    description: 'Run the configured periodic checks now and return the combined runtime, hardware, and remote-device status with timestamps, thresholds, and freshness. Use refresh=true to bypass any cached check result; use id to run one configured check.',
    parameters: {
      id: { type: 'string', description: 'Optional check id to run alone.' },
      refresh: { type: 'boolean', description: 'Force a fresh run even when the check just ran.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Combined runtime and status report.' },
          observedAt: { type: 'string', required: true, description: 'ISO timestamp of this check run.' },
          changed: { type: 'boolean', required: true, description: 'Whether any runtime or check state changed.' },
          healthy: { type: 'boolean', required: true, description: 'Whether every configured check currently passes.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args: any, exec: any) {
      if (!entry.enabled.get()) throw new Error('status_check is disabled: enable runtime-env-watch in Settings → Plugins, or set enabled: true in the plugin config.')
      if (!exec.agent) throw new Error('status_check requires an agent Session')
      const key = String(exec.agent.session.id)
      const before = states.get(key)
      await scheduler.ensure()
      const { state } = await probe(exec.agent, true, exec.signal)
      if (typeof args?.id === 'string' && args.id) {
        const one = await scheduler.runOne(args.id, true)
        if (!one) throw new Error('unknown check id: ' + args.id)
      } else await scheduler.runAll(true)
      const checks = scheduler.snapshot()
      const now = new Date()
      const text = combined(state.facts, before?.facts ?? null, now)
      const statusFp = statusFingerprint(checks)
      const alert = hasStatusAlerts(checks)
      const changed = before === undefined || before.fingerprint !== state.fingerprint || before.statusFingerprint !== statusFp
      states.set(key, { ...state, pushedAt: now.getTime(), pending: false, statusFingerprint: statusFp, alert })
      return { text, observedAt: now.toISOString(), changed, healthy: !alert }
    },
  }))

  ;(ctx as any).on('agent/pre-step', async (payload: any, next: any) => {
    const decision = await next()
    if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    if (!entry.enabled.get() || !payload?.agent?.session) return decision
    await Promise.race([scheduler.ensure(), new Promise(resolve => setTimeout(resolve, 1500))])
    let state: State
    let previous: State | undefined
    try {
      ;({ state, previous } = await probe(payload.agent, false, payload.signal))
    } catch {
      return decision
    }
    const now = Date.now()
    const checks = scheduler.snapshot()
    const statusFp = statusFingerprint(checks)
    const alert = hasStatusAlerts(checks)
    const major = previous === undefined
      || previous.facts.cwd !== state.facts.cwd
      || previous.facts.git?.branch !== state.facts.git?.branch
      || previous.facts.git?.head !== state.facts.git?.head
      || (alert && !previous.alert)
    const changed = previous === undefined
      || previous.fingerprint !== state.fingerprint
      || previous.statusFingerprint !== statusFp
    const pending = (previous?.pending ?? false) || (changed && !major)
    const sincePush = now - (previous?.pushedAt ?? 0)
    const changeReady = (changed || (previous?.pending ?? false)) && sincePush >= CHANGE_COOLDOWN_MS
    const heartbeat = previous === undefined || sincePush >= entry.reminderMinutes * 60_000
    const shouldPush = major || changeReady || heartbeat
    states.set(String(payload.agent.session.id), { ...state, statusFingerprint: statusFp, alert, pending: pending && !shouldPush })
    if (!shouldPush) return decision
    const text = combined(state.facts, previous?.facts ?? null, new Date(now), payload?.turn, payload?.step)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'runtime-env-watch', form: 'snapshot', sections: [{ name: 'runtime-env-watch', text }] },
    } as any)
    states.set(String(payload.agent.session.id), { ...state, pushedAt: now, pending: false, statusFingerprint: statusFp, alert })
    return { ...decision, messages: [...decision.messages, message] }
  }, { prepend: true })
}
