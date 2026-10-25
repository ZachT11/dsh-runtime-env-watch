import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectRuntimeFacts, describeRuntimeChanges, formatRuntimeAudit, runtimeFingerprint } from '../lib/index.js'

// The Host supplies the real runner through ctx.subprocess; this test pins the
// parsing/formatting contract with a deterministic fake.
const runner = async argv => {
  const joined = argv.join(' ')
  if (joined === 'git --version') return 'git version 2.56.0'
  if (joined.includes('--is-inside-work-tree')) return 'true'
  if (joined.includes('--abbrev-ref')) return 'main'
  if (joined.includes('--short')) return 'abc1234'
  if (joined.includes('status')) return ' M package.json'
  return null
}

const dir = await mkdtemp(join(tmpdir(), 'runtime-env-watch-'))
await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', packageManager: 'pnpm@11.19.0' }))
await writeFile(join(dir, 'AGENTS.md'), '# rules\n')

const first = await collectRuntimeFacts(dir, { watchFiles: ['package.json', 'AGENTS.md', 'missing.txt'], run: runner })
assert.equal(first.cwd, dir)
assert.ok(first.git, 'git facts must be present')
assert.equal(first.git.branch, 'main')
assert.equal(first.git.head, 'abc1234')
assert.equal(first.git.dirty, 1)
assert.equal(first.git.modified, 1)
assert.equal(first.files.find(file => file.path === 'package.json').exists, true)
assert.equal(first.files.find(file => file.path === 'missing.txt').exists, false)
assert.equal(first.pnpm, 'pnpm@11.19.0')
assert.ok(first.node.startsWith('v'))

const audit = formatRuntimeAudit(first, { now: new Date(first.collectedAt), turn: 2, step: 3, staleMinutes: 10 })
for (const part of ['【AI 运行环境巡检】', '第 2 轮', '第 3 步', '工作目录：', 'Git：main @ abc1234', '关键文件：', '规则：']) assert.ok(audit.includes(part), 'audit missing ' + part)

await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', packageManager: 'pnpm@11.19.0', changed: true }))
const second = await collectRuntimeFacts(dir, { watchFiles: ['package.json', 'AGENTS.md', 'missing.txt'], run: runner })
assert.notEqual(runtimeFingerprint(first), runtimeFingerprint(second))
const changes = describeRuntimeChanges(first, second)
assert.ok(changes.some(change => change.includes('package.json')), 'file mtime change must be reported')

const stale = formatRuntimeAudit(second, { previous: first, now: new Date(Date.parse(second.collectedAt) + 20 * 60_000), staleMinutes: 10 })
assert.ok(stale.includes('TTL'), 'stale audit must mention TTL')
assert.ok(stale.includes('变化：'), 'delta audit must include a change line')

const noGit = await collectRuntimeFacts(dir, { watchFiles: ['package.json'], run: async () => null })
assert.equal(noGit.git, null)
assert.ok(formatRuntimeAudit(noGit, { now: new Date(noGit.collectedAt) }).includes('非 Git 仓库'))
console.log('runtime environment audit tests passed')
