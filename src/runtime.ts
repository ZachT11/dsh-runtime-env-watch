import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'

export type CommandRunner = (argv: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<string | null>

export interface RuntimeFile { path: string; exists: boolean; mtimeMs: number | null; size: number | null }
export interface RuntimeGit {
  branch: string
  head: string
  dirty: number
  modified: number
  added: number
  deleted: number
  renamed: number
  status: 'ok' | 'timeout' | 'unavailable'
}
export interface RuntimeFacts {
  cwd: string
  platform: string
  release: string
  arch: string
  shell: string
  node: string
  gitVersion: string | null
  pnpm: string | null
  git: RuntimeGit | null
  files: RuntimeFile[]
  collectedAt: string
}
export interface RuntimeOptions { watchFiles: string[]; run: CommandRunner; timeoutMs?: number; signal?: AbortSignal }

async function packageManager(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw)
    return typeof pkg?.packageManager === 'string' ? pkg.packageManager : null
  } catch {
    return null
  }
}

function parseGitStatus(text: string) {
  const lines = text.split('\n').map(line => line.trimEnd()).filter(line => line.length > 0)
  let modified = 0, added = 0, deleted = 0, renamed = 0
  for (const line of lines) {
    const code = line.slice(0, 2)
    if (code.includes('R')) renamed += 1
    else if (code.includes('D')) deleted += 1
    else if (code.includes('A') || code === '??') added += 1
    else if (code.includes('M')) modified += 1
  }
  return { dirty: lines.length, modified, added, deleted, renamed }
}

async function fileFacts(cwd: string, paths: string[]): Promise<RuntimeFile[]> {
  const seen = new Set<string>()
  const result: RuntimeFile[] = []
  for (const name of paths) {
    if (seen.has(name)) continue
    seen.add(name)
    try {
      const info = await stat(join(cwd, name))
      result.push({ path: name, exists: true, mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      result.push({ path: name, exists: false, mtimeMs: null, size: null })
    }
  }
  return result
}

export async function collectRuntimeFacts(cwd: string, options: RuntimeOptions): Promise<RuntimeFacts> {
  const timeoutMs = options.timeoutMs ?? 4_000
  const run = options.run
  const [gitVersion, pnpm, files] = await Promise.all([
    run(['git', '--version'], cwd, timeoutMs, options.signal),
    packageManager(cwd),
    fileFacts(cwd, options.watchFiles),
  ])
  let git: RuntimeGit | null = null
  const inside = await run(['git', 'rev-parse', '--is-inside-work-tree'], cwd, timeoutMs, options.signal)
  if (inside === 'true') {
    const [branchText, headText, statusText] = await Promise.all([
      run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd, timeoutMs, options.signal),
      run(['git', 'rev-parse', '--short', 'HEAD'], cwd, timeoutMs, options.signal),
      run(['git', 'status', '--porcelain=v1', '--untracked-files=no'], cwd, timeoutMs, options.signal),
    ])
    const counts = statusText === null ? { dirty: 0, modified: 0, added: 0, deleted: 0, renamed: 0 } : parseGitStatus(statusText)
    git = { branch: branchText || 'HEAD', head: headText || 'unknown', ...counts, status: statusText === null ? 'timeout' : 'ok' }
  }
  return {
    cwd,
    platform: os.type(),
    release: os.release(),
    arch: process.arch,
    shell: process.env.ComSpec || process.env.SHELL || 'unknown',
    node: process.version,
    gitVersion,
    pnpm,
    git,
    files,
    collectedAt: new Date().toISOString(),
  }
}

export function runtimeFingerprint(facts: RuntimeFacts): string {
  return JSON.stringify({
    cwd: facts.cwd,
    shell: facts.shell,
    node: facts.node,
    gitVersion: facts.gitVersion,
    pnpm: facts.pnpm,
    git: facts.git === null ? null : {
      branch: facts.git.branch,
      head: facts.git.head,
      dirty: facts.git.dirty,
      modified: facts.git.modified,
      added: facts.git.added,
      deleted: facts.git.deleted,
      renamed: facts.git.renamed,
      status: facts.git.status,
    },
    files: facts.files.map(file => [file.path, file.exists, file.mtimeMs, file.size]),
  })
}

function clock(ms: number | null): string {
  if (ms === null) return '未知'
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

function ageText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return seconds + ' 秒'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + ' 分钟'
  const hours = Math.floor(minutes / 60)
  return hours + ' 小时'
}

function gitLine(git: RuntimeGit | null): string {
  if (git === null) return '非 Git 仓库，或当前目录不可用'
  const state = git.status === 'timeout' ? '状态读取超时' : git.dirty === 0 ? '工作区干净' : git.dirty + ' 个已跟踪改动'
  return git.branch + ' @ ' + git.head + '；' + state + (git.dirty > 0 ? '（修改 ' + git.modified + ' / 新增 ' + git.added + ' / 删除 ' + git.deleted + '）' : '')
}

export function describeRuntimeChanges(previous: RuntimeFacts | null, current: RuntimeFacts): string[] {
  if (previous === null) return []
  const changes: string[] = []
  if (previous.cwd !== current.cwd) changes.push('工作目录 ' + previous.cwd + ' → ' + current.cwd)
  const before = previous.git, after = current.git
  if (before !== null && after !== null) {
    if (before.branch !== after.branch) changes.push('Git 分支 ' + before.branch + ' → ' + after.branch)
    if (before.head !== after.head) changes.push('Git HEAD ' + before.head + ' → ' + after.head)
    if (before.dirty !== after.dirty) changes.push('已跟踪改动 ' + before.dirty + ' → ' + after.dirty)
  } else if ((before === null) !== (after === null)) {
    changes.push(after === null ? 'Git 仓库变为不可用' : '进入 Git 仓库 ' + after.branch)
  }
  for (const file of current.files) {
    const old = previous.files.find(item => item.path === file.path)
    if (old === undefined) continue
    if (old.exists !== file.exists) changes.push(file.path + (file.exists ? ' 已出现' : ' 已消失'))
    else if (file.exists && old.mtimeMs !== file.mtimeMs) changes.push(file.path + ' 修改于 ' + clock(file.mtimeMs))
  }
  if (previous.node !== current.node) changes.push('Node ' + previous.node + ' → ' + current.node)
  if (previous.pnpm !== current.pnpm) changes.push('pnpm ' + (previous.pnpm || '未知') + ' → ' + (current.pnpm || '未知'))
  if (previous.gitVersion !== current.gitVersion) changes.push('git ' + (previous.gitVersion || '未知') + ' → ' + (current.gitVersion || '未知'))
  return changes.slice(0, 8)
}

export interface AuditOptions { previous?: RuntimeFacts | null; now?: Date; turn?: number; step?: number; staleMinutes?: number }

export function formatRuntimeAudit(facts: RuntimeFacts, options: AuditOptions = {}): string {
  const now = options.now ?? new Date()
  const age = Math.max(0, now.getTime() - Date.parse(facts.collectedAt))
  const position = [
    options.turn !== undefined ? '第 ' + options.turn + ' 轮' : '',
    options.step !== undefined ? '第 ' + options.step + ' 步' : '',
  ].filter(Boolean).join(' · ')
  const lines = [
    '【AI 运行环境巡检】' + (position ? position + ' · ' : '') + '采集于 ' + new Date(facts.collectedAt).toLocaleString('zh-CN', { hour12: false }) + '（' + ageText(age) + '前）',
    '工作目录：' + facts.cwd,
    '平台：' + facts.platform + ' ' + facts.release + '（' + facts.arch + '） / Node ' + facts.node + (facts.pnpm ? ' / ' + facts.pnpm : '') + (facts.gitVersion ? ' / ' + facts.gitVersion : ''),
    'Shell：' + facts.shell,
    'Git：' + gitLine(facts.git),
    '关键文件：' + (facts.files.length === 0 ? '未配置' : facts.files.map(file => file.exists ? file.path + ' ' + clock(file.mtimeMs) : file.path + ' 不存在').join('；')),
  ]
  const changes = describeRuntimeChanges(options.previous ?? null, facts)
  if (changes.length > 0) lines.push('变化：' + changes.join('；'))
  else if (options.previous) lines.push('变化：无（与上次巡检相同）')
  else lines.push('变化：首次巡检，无历史可比')
  if (options.staleMinutes !== undefined && age > options.staleMinutes * 60_000) {
    lines.push('注意：这次巡检已超过 ' + options.staleMinutes + ' 分钟 TTL；执行依赖环境的操作前请调用 runtime_env(refresh=true) 重新检查。')
  }
  lines.push('规则：运行环境是带时间戳的快照，不是常量。会话早期的 pwd、git status、node -v 只能作历史；执行依赖目录、Git、关键文件或工具链的操作前，以最新巡检或 runtime_env 结果为准；过期就先刷新。')
  return lines.join('\n')
}

export function runtimePolicy(): string {
  return [
    '【AI 运行环境规则】',
    '运行环境（工作目录、Git、关键文件、工具链、Shell）通过带时间戳的“AI 运行环境巡检”消息推送；最新一条或 runtime_env 工具结果才有效，更早的只是历史。',
    '不要把会话早期的 pwd、git status、node -v 当作永久事实；文件、分支、依赖和工具链都可能变化。',
    '执行依赖环境的操作前，先读最新巡检；需要确认当前状态时调用 runtime_env(refresh=true)。如果巡检已经过期，明确说明并重新检查，不要沿用旧值。',
  ].join('\n')
}
