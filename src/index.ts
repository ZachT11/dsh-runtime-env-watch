import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-subprocess'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-working-directory'
import { collectRuntimeFacts, formatRuntimeAudit, runtimeFingerprint, runtimePolicy, type CommandRunner, type RuntimeFacts } from './runtime.ts'

export { collectRuntimeFacts, describeRuntimeChanges, formatRuntimeAudit, runtimeFingerprint, runtimePolicy } from './runtime.ts'
export type { RuntimeFacts } from './runtime.ts'

export const name = 'runtime-env-watch'
export const inject = ['tools', 'systemPrompt', 'workingDirectory', 'subprocess']

const DEFAULT_FILES = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'AGENTS.md', 'tsconfig.json']
const CHANGE_COOLDOWN_MS = 60_000

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  probeSeconds: z.number().min(5).max(600).default(30),
  reminderMinutes: z.number().min(1).max(120).default(10),
  staleMinutes: z.number().min(1).max(120).default(10),
  watchFiles: z.array(z.string()).default(DEFAULT_FILES),
  sectionOrder: z.number().default(21),
})
export type Config = ReturnType<typeof Config>

interface State {
  facts: RuntimeFacts
  at: number
  pushedAt: number
  fingerprint: string
  pending: boolean
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
    }
    states.set(key, state)
    return { state, previous }
  }

  // Static policy only: the system prompt never carries changing environment values.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'runtime-env-watch',
    order: entry.sectionOrder,
    interpolate: false,
    text: () => entry.enabled.get() ? runtimePolicy() : '',
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

  ;(ctx as any).on('agent/pre-step', async (payload: any, next: any) => {
    const decision = await next()
    if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    if (!entry.enabled.get() || !payload?.agent?.session) return decision
    let state: State
    let previous: State | undefined
    try {
      ;({ state, previous } = await probe(payload.agent, false, payload.signal))
    } catch {
      return decision
    }
    const now = Date.now()
    const major = previous === undefined
      || previous.facts.cwd !== state.facts.cwd
      || previous.facts.git?.branch !== state.facts.git?.branch
      || previous.facts.git?.head !== state.facts.git?.head
    const changed = previous === undefined || previous.fingerprint !== state.fingerprint
    const pending = (previous?.pending ?? false) || (changed && !major)
    const sincePush = now - (previous?.pushedAt ?? 0)
    const changeReady = (changed || (previous?.pending ?? false)) && sincePush >= CHANGE_COOLDOWN_MS
    const heartbeat = previous === undefined || sincePush >= entry.reminderMinutes * 60_000
    const shouldPush = major || changeReady || heartbeat
    states.set(String(payload.agent.session.id), { ...state, pending: pending && !shouldPush })
    if (!shouldPush) return decision
    const text = formatRuntimeAudit(state.facts, {
      previous: previous?.facts ?? null,
      now: new Date(now),
      turn: payload?.turn,
      step: payload?.step,
      staleMinutes: entry.staleMinutes,
    })
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'runtime-env-watch', form: 'snapshot', sections: [{ name: 'runtime-env-watch', text }] },
    } as any)
    states.set(String(payload.agent.session.id), { ...state, pushedAt: now, pending: false })
    return { ...decision, messages: [...decision.messages, message] }
  }, { prepend: true })
}
