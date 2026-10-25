import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply, Config } from '../lib/index.js'

const dir = await mkdtemp(join(tmpdir(), 'runtime-env-wire-'))
await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', packageManager: 'pnpm@11.19.0' }))

const gitOutput = argv => {
  const joined = argv.join(' ')
  if (joined === 'git --version') return 'git version 2.56.0'
  if (joined.includes('--is-inside-work-tree')) return 'true'
  if (joined.includes('--abbrev-ref')) return 'main'
  if (joined.includes('--short')) return 'abc1234'
  if (joined.includes('status')) return ''
  return null
}
const fakeSpawn = spec => {
  const text = gitOutput(spec.argv) ?? ''
  return {
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
  }
}

const ctx = new Context()
await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
ctx.provide('workingDirectory', { get: () => dir })
ctx.provide('subprocess', { spawn: fakeSpawn })
const tools = []
ctx.provide('tools', { register: tool => { tools.push(tool) } })
apply(ctx, Config({ watchFiles: ['package.json'] }))

const agent = { session: { id: 'session-1' } }
const signal = new AbortController().signal
let decision = await ctx.waterfall('agent/pre-step', { agent, turn: 1, step: 1, signal }, () => Promise.resolve({ kind: 'enter', messages: [] }))
assert.equal(decision.messages.length, 1, 'the first audit must be pushed')
const text = decision.messages[0].content[0].text
for (const part of ['【AI 运行环境巡检】', '工作目录：' + dir, 'Git：main @ abc1234', '规则：']) assert.ok(text.includes(part), 'audit missing ' + part)
assert.equal(decision.messages[0].source.kind, 'runtime-env-watch')

decision = await ctx.waterfall('agent/pre-step', { agent, turn: 2, step: 1, signal }, () => Promise.resolve({ kind: 'enter', messages: [] }))
assert.equal(decision.messages.length, 0, 'an unchanged probe must not spam the model')

assert.deepEqual(tools.map(tool => tool.name).sort(), ['runtime_env', 'status_check'])
const runtimeTool = tools.find(tool => tool.name === 'runtime_env')
const result = await runtimeTool.execute({ refresh: true }, { agent, signal })
assert.ok(result.text.includes('工作目录：' + dir))
assert.equal(result.changed, false)
assert.ok(typeof result.observedAt === 'string')

const statusTool = tools.find(tool => tool.name === 'status_check')
const status = await statusTool.execute({ refresh: true }, { agent, signal })
for (const part of ['【AI 运行环境巡检】', '【硬件与远程状态】', '硬件：', 'CPU']) assert.ok(status.text.includes(part), 'status missing ' + part)
assert.equal(status.healthy, true)
assert.ok(typeof status.observedAt === 'string')

await ctx.fiber.dispose()
console.log('runtime environment pre-step and tool wiring passed')
