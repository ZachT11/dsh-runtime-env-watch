import { createConnection } from 'node:net'
import { readFile, stat, statfs } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import os from 'node:os'
import type { CommandRunner } from './runtime.ts'

export type CheckKind = 'hardware' | 'http' | 'command' | 'tcp' | 'file'
export type HardwareMetric = 'cpu' | 'memory' | 'disk' | 'uptime' | 'battery' | 'gpu' | 'processes' | 'ports' | 'temperature'

export interface CheckExpectation {
  min?: number
  max?: number
  equals?: unknown
  contains?: string
  exists?: boolean
}
export interface CheckDefinition {
  id: string
  kind: CheckKind
  enabled?: boolean
  intervalSeconds?: number
  timeoutMs?: number
  metrics?: HardwareMetric[]
  diskPaths?: string[]
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
  fields?: Record<string, string>
  expect?: Record<string, CheckExpectation>
  command?: string[]
  cwd?: string
  json?: boolean
  host?: string
  port?: number
  path?: string
  minSize?: number
  maxAgeSeconds?: number
  exists?: boolean
}
export interface CheckConfigFile { checks?: CheckDefinition[]; intervalSeconds?: number }
export interface CheckState {
  id: string
  kind: CheckKind
  at: number
  ok: boolean
  data: Record<string, any>
  error?: string
  durationMs: number
  fingerprint: string
  alerts: string[]
}
export interface CheckContext { cwd: string; run: CommandRunner; signal?: AbortSignal; timeoutMs: number }

const MIN_INTERVAL = 5
const MAX_INTERVAL = 3600

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index]
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  if (days > 0) return days + 'd ' + hours + 'h'
  if (hours > 0) return hours + 'h ' + minutes + 'm'
  if (minutes > 0) return minutes + 'm'
  return s + 's'
}

function truncate(text: string, limit = 1200): string {
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}

function stableStringify(value: unknown): string {
  const walk = (input: any): any => {
    if (Array.isArray(input)) return input.map(walk)
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, walk(input[key])]))
    }
    return input
  }
  return JSON.stringify(walk(value))
}

export function getPath(value: unknown, path: string): any {
  if (!path) return value
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((current: any, key: string) => current == null ? undefined : current[key], value)
}

function extractFields(value: unknown, fields: Record<string, string> | undefined): Record<string, any> | undefined {
  if (!fields) return undefined
  const result: Record<string, any> = {}
  for (const [name, path] of Object.entries(fields)) result[name] = getPath(value, path)
  return result
}

function evaluateExpectations(expect: Record<string, CheckExpectation> | undefined, data: Record<string, any>): string[] {
  const alerts: string[] = []
  if (!expect) return alerts
  for (const [path, rule] of Object.entries(expect)) {
    const value = getPath(data, path)
    if (rule.exists !== undefined) {
      const present = value !== undefined && value !== null
      if (present !== rule.exists) alerts.push(path + (rule.exists ? ' 不存在' : ' 意外存在'))
      if (!present) continue
    }
    if (value === undefined) { alerts.push(path + ' 缺失'); continue }
    if (value !== null) {
      if (rule.min !== undefined && Number(value) < rule.min) alerts.push(path + '=' + String(value) + ' < ' + rule.min)
      if (rule.max !== undefined && Number(value) > rule.max) alerts.push(path + '=' + String(value) + ' > ' + rule.max)
    }
    if (rule.equals !== undefined && stableStringify(value) !== stableStringify(rule.equals)) alerts.push(path + '≠' + JSON.stringify(rule.equals))
    if (rule.contains !== undefined && !String(value).includes(rule.contains)) alerts.push(path + ' 不包含 ' + JSON.stringify(rule.contains))
  }
  return alerts
}

let previousCpu: { idle: number; total: number } | null = null
let cpuCache: { at: number; value: { usagePercent: number; cores: number } } | null = null
function cpuSample() {
  if (cpuCache !== null && Date.now() - cpuCache.at < 1000) return cpuCache.value
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }
  const usage = previousCpu !== null && total > previousCpu.total
    ? (1 - (idle - previousCpu.idle) / (total - previousCpu.total)) * 100
    : total > 0 ? (1 - idle / total) * 100 : 0
  previousCpu = { idle, total }
  const value = { usagePercent: round(Math.max(0, Math.min(100, usage))), cores: cpus.length }
  cpuCache = { at: Date.now(), value }
  return value
}

async function powerShell(run: CommandRunner, cwd: string, script: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  for (const executable of ['pwsh', 'powershell']) {
    const output = await run([executable, '-NoProfile', '-NonInteractive', '-Command', script], cwd, timeoutMs, signal)
    if (output !== null) return output
  }
  return null
}

async function collectHardware(def: CheckDefinition, ctx: CheckContext): Promise<Record<string, any>> {
  const metrics = def.metrics?.length ? def.metrics : ['cpu', 'memory', 'disk', 'uptime']
  const data: Record<string, any> = {}
  const errors: string[] = []
  for (const metric of metrics) {
    try {
      if (metric === 'cpu') data.cpu = cpuSample()
      else if (metric === 'memory') {
        const total = os.totalmem()
        const free = os.freemem()
        data.memory = { totalBytes: total, usedBytes: total - free, freeBytes: free, usedPercent: round(((total - free) / total) * 100) }
      } else if (metric === 'disk') {
        const paths = def.diskPaths?.length ? def.diskPaths : [process.env.SystemDrive ? process.env.SystemDrive + '\\' : '/']
        const disks: any[] = []
        for (const path of paths) {
          try {
            const fs = await statfs(path)
            const total = Number(fs.blocks) * Number(fs.bsize)
            const available = Number(fs.bavail) * Number(fs.bsize)
            disks.push({ path, totalBytes: total, freeBytes: available, usedPercent: total > 0 ? round(((total - available) / total) * 100) : 0 })
          } catch (error) { errors.push('disk ' + path + ': ' + String(error)) }
        }
        data.disk = disks
      } else if (metric === 'uptime') data.uptimeSeconds = Math.floor(os.uptime())
      else if (metric === 'battery') {
        const text = await powerShell(ctx.run, ctx.cwd, 'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress', ctx.timeoutMs, ctx.signal)
        if (text === null) errors.push('battery: PowerShell probe failed')
        else {
          const parsed = JSON.parse(text)
          const status = Number(parsed.BatteryStatus)
          data.battery = { percent: Number(parsed.EstimatedChargeRemaining), charging: [2, 6, 7, 8, 9].includes(status), status }
        }
      } else if (metric === 'gpu') {
        const text = await ctx.run(['nvidia-smi', '--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], ctx.cwd, ctx.timeoutMs, ctx.signal)
        if (text === null) errors.push('gpu: nvidia-smi unavailable')
        else data.gpu = text.split('\n').filter(Boolean).map(line => {
          const [name, temperatureC, utilizationPercent, memoryUsedMiB, memoryTotalMiB] = line.split(',').map(part => part.trim())
          return { name, temperatureC: Number(temperatureC), utilizationPercent: Number(utilizationPercent), memoryUsedMiB: Number(memoryUsedMiB), memoryTotalMiB: Number(memoryTotalMiB) }
        })
      } else if (metric === 'processes') {
        const text = await powerShell(ctx.run, ctx.cwd, 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name,CPU,WorkingSet64 | ConvertTo-Json -Compress', ctx.timeoutMs, ctx.signal)
        if (text === null) errors.push('processes: PowerShell probe failed')
        else {
          const parsed = JSON.parse(text)
          data.processes = Array.isArray(parsed) ? parsed : [parsed]
        }
      } else if (metric === 'ports') {
        const text = await powerShell(ctx.run, ctx.cwd, 'Get-NetTCPConnection -State Listen | Select-Object -First 20 LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress', ctx.timeoutMs, ctx.signal)
        if (text === null) errors.push('ports: PowerShell probe failed')
        else {
          const parsed = JSON.parse(text)
          data.ports = Array.isArray(parsed) ? parsed : [parsed]
        }
      } else if (metric === 'temperature') {
        const text = await powerShell(ctx.run, ctx.cwd, 'Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1 CurrentTemperature | ConvertTo-Json -Compress', ctx.timeoutMs, ctx.signal)
        if (text === null) errors.push('temperature: probe failed')
        else data.temperatureC = round((Number(JSON.parse(text).CurrentTemperature) / 10) - 273.15)
      }
    } catch (error) {
      errors.push(metric + ': ' + String(error))
    }
  }
  if (errors.length > 0) data.errors = errors
  return data
}

async function collectHttp(def: CheckDefinition, ctx: CheckContext): Promise<Record<string, any>> {
  if (!def.url) throw new Error('http check requires url')
  const response = await fetch(def.url, {
    method: def.method ?? 'GET',
    headers: def.headers,
    body: def.body,
    signal: ctx.signal,
  })
  const text = await response.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch {}
  const data: Record<string, any> = { _status: response.status }
  if (def.fields) Object.assign(data, extractFields(parsed, def.fields))
  else if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(data, parsed)
  else data.body = truncate(String(parsed))
  if (!response.ok) throw new Error('HTTP ' + response.status + (text ? ': ' + truncate(text, 200) : ''))
  return data
}

async function collectCommand(def: CheckDefinition, ctx: CheckContext): Promise<Record<string, any>> {
  if (!def.command?.length) throw new Error('command check requires command array')
  const text = await ctx.run(def.command, def.cwd ? resolve(ctx.cwd, def.cwd) : ctx.cwd, ctx.timeoutMs, ctx.signal)
  if (text === null) throw new Error('command failed or produced no output')
  let parsed: any = text
  if (def.json) parsed = JSON.parse(text)
  const data: Record<string, any> = {}
  if (def.fields) Object.assign(data, extractFields(parsed, def.fields))
  else if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(data, parsed)
  else data.stdout = truncate(text)
  return data
}

async function collectTcp(def: CheckDefinition, ctx: CheckContext): Promise<Record<string, any>> {
  if (!def.host || typeof def.port !== 'number') throw new Error('tcp check requires host and port')
  const host = def.host
  const port = def.port
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => { socket.destroy(); rejectPromise(new Error('timeout')) }, ctx.timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolvePromise() })
    socket.once('error', error => { clearTimeout(timer); socket.destroy(); rejectPromise(error) })
    ctx.signal?.addEventListener('abort', () => { clearTimeout(timer); socket.destroy(); rejectPromise(new Error('aborted')) }, { once: true })
  })
  return { host: def.host, port: def.port, open: true }
}

async function collectFile(def: CheckDefinition, ctx: CheckContext): Promise<Record<string, any>> {
  if (!def.path) throw new Error('file check requires path')
  const target = isAbsolute(def.path) ? def.path : join(ctx.cwd, def.path)
  try {
    const info = await stat(target)
    const data: Record<string, any> = { path: target, exists: true, size: info.size, mtimeMs: info.mtimeMs, ageSeconds: Math.max(0, Math.floor((Date.now() - info.mtimeMs) / 1000)) }
    if (def.minSize !== undefined && info.size < def.minSize) data._sizeAlert = 'size ' + info.size + ' < ' + def.minSize
    if (def.maxAgeSeconds !== undefined && data.ageSeconds > def.maxAgeSeconds) data._ageAlert = 'age ' + data.ageSeconds + 's > ' + def.maxAgeSeconds + 's'
    return data
  } catch {
    return { path: target, exists: false }
  }
}

async function executeCheck(def: CheckDefinition, ctx: CheckContext): Promise<Record<string, any>> {
  if (def.kind === 'hardware') return collectHardware(def, ctx)
  if (def.kind === 'http') return collectHttp(def, ctx)
  if (def.kind === 'command') return collectCommand(def, ctx)
  if (def.kind === 'tcp') return collectTcp(def, ctx)
  if (def.kind === 'file') return collectFile(def, ctx)
  throw new Error('unknown check kind: ' + String(def.kind))
}

export async function runCheck(def: CheckDefinition, ctx: CheckContext): Promise<CheckState> {
  const started = Date.now()
  const timeoutMs = Math.max(500, def.timeoutMs ?? ctx.timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal
  try {
    const data = await executeCheck(def, { ...ctx, signal, timeoutMs })
    const alerts = evaluateExpectations(def.expect, data)
    const errors = Array.isArray(data.errors) ? data.errors.map(String) : []
    if (def.kind === 'file') {
      if (data._sizeAlert) alerts.push(data._sizeAlert)
      if (data._ageAlert) alerts.push(data._ageAlert)
      const expectExists = def.exists !== false
      if (data.exists !== expectExists) alerts.push('文件' + (expectExists ? '不存在' : '存在'))
    }
    const allAlerts = [...errors, ...alerts]
    return {
      id: def.id,
      kind: def.kind,
      at: Date.now(),
      ok: allAlerts.length === 0,
      data,
      error: allAlerts.length > 0 ? allAlerts.join('; ') : undefined,
      durationMs: Date.now() - started,
      fingerprint: stableStringify({ kind: def.kind, data: fingerprintData(def.kind, data), ok: allAlerts.length === 0 }),
      alerts: allAlerts,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      id: def.id,
      kind: def.kind,
      at: Date.now(),
      ok: false,
      data: { errors: [message] },
      error: message,
      durationMs: Date.now() - started,
      fingerprint: stableStringify({ kind: def.kind, error: message }),
      alerts: [message],
    }
  } finally {
    clearTimeout(timer)
  }
}

function fingerprintData(kind: CheckKind, data: Record<string, any>): Record<string, any> {
  if (kind === 'file') {
    const { ageSeconds: _ageSeconds, ...stable } = data
    return stable
  }
  if (kind !== 'hardware') return data
  const rounded = (value: unknown, step: number) => Number.isFinite(Number(value)) ? Math.round(Number(value) / step) * step : null
  const result: Record<string, any> = {}
  if (data.cpu) result.cpu = rounded(data.cpu.usagePercent, 10)
  if (data.memory) result.memory = rounded(data.memory.usedPercent, 5)
  if (Array.isArray(data.disk)) result.disk = data.disk.map((disk: any) => ({ path: disk.path, used: rounded(disk.usedPercent, 5) }))
  if (data.battery) result.battery = { percent: rounded(data.battery.percent, 5), charging: Boolean(data.battery.charging) }
  if (Array.isArray(data.gpu)) result.gpu = data.gpu.map((gpu: any) => ({ name: gpu.name, temp: rounded(gpu.temperatureC, 5), util: rounded(gpu.utilizationPercent, 10) }))
  if (data.temperatureC !== undefined) result.temperature = rounded(data.temperatureC, 5)
  if (Array.isArray(data.processes)) result.processes = data.processes.length
  if (Array.isArray(data.ports)) result.ports = data.ports.length
  if (Array.isArray(data.errors)) result.errors = data.errors
  return result
}

function formatHardware(data: Record<string, any>): string {
  const parts: string[] = []
  if (data.cpu) parts.push('CPU ' + data.cpu.usagePercent + '%（' + data.cpu.cores + ' 核）')
  if (data.memory) parts.push('内存 ' + data.memory.usedPercent + '%（' + formatBytes(data.memory.usedBytes) + '/' + formatBytes(data.memory.totalBytes) + '）')
  if (Array.isArray(data.disk)) for (const disk of data.disk) parts.push('磁盘 ' + disk.path + ' 已用 ' + disk.usedPercent + '%（剩余 ' + formatBytes(disk.freeBytes) + '）')
  if (data.uptimeSeconds !== undefined) parts.push('开机 ' + formatDuration(data.uptimeSeconds))
  if (data.battery) parts.push('电量 ' + data.battery.percent + '%' + (data.battery.charging ? '（充电中）' : ''))
  if (Array.isArray(data.gpu)) for (const gpu of data.gpu) parts.push('GPU ' + (gpu.name || '') + ' ' + gpu.temperatureC + '°C ' + gpu.utilizationPercent + '%（显存 ' + gpu.memoryUsedMiB + '/' + gpu.memoryTotalMiB + ' MiB）')
  if (Array.isArray(data.processes)) parts.push('进程 ' + data.processes.length + ' 条')
  if (Array.isArray(data.ports)) parts.push('监听端口 ' + data.ports.length + ' 条')
  if (data.temperatureC !== undefined) parts.push('温度 ' + data.temperatureC + '°C')
  if (Array.isArray(data.errors) && data.errors.length > 0) parts.push('失败项：' + data.errors.join('；'))
  return parts.join('；')
}

function formatData(data: Record<string, any>): string {
  const entries = Object.entries(data).filter(([key]) => !key.startsWith('_') && key !== 'errors')
  const parts = entries.slice(0, 8).map(([key, value]) => key + '=' + (typeof value === 'object' ? truncate(JSON.stringify(value), 120) : String(value)))
  return parts.join('；')
}

export function formatCheckState(state: CheckState, now = Date.now(), staleMinutes?: number): string {
  const age = Math.max(0, Math.floor((now - state.at) / 1000))
  const stale = staleMinutes !== undefined && age > staleMinutes * 60
  const label = state.kind === 'hardware' ? (state.id === 'hardware' ? '硬件' : '硬件·' + state.id) : state.id
  const body = state.kind === 'hardware' ? formatHardware(state.data) : formatData(state.data)
  const status = !state.ok ? '异常' : stale ? '需刷新（数据已过期 ' + formatDuration(age) + '）' : '正常'
  return label + '：' + status + (body ? '；' + body : '') + (state.error && !state.ok ? '；' + state.error : '')
}

export function formatStatusReport(states: CheckState[], options: { now?: Date; staleMinutes?: number; intervalSeconds?: number; configError?: string } = {}): string {
  if (states.length === 0 && !options.configError) return ''
  const now = options.now ?? new Date()
  const lines = ['【硬件与远程状态】按配置周期巡检' + (states.length > 0 ? '；采集于 ' + new Date(Math.max(...states.map(state => state.at))).toLocaleString('zh-CN', { hour12: false }) : '')]
  for (const state of [...states].sort((a, b) => a.id.localeCompare(b.id))) lines.push('- ' + formatCheckState(state, now.getTime(), options.staleMinutes))
  if (options.configError) lines.push('配置错误：' + options.configError)
  const alerts = states.filter(state => !state.ok)
  if (alerts.length > 0) lines.push('异常：' + alerts.map(state => state.id + '（' + (state.error || '未通过') + '）').join('；'))
  return lines.join('\n')
}

export function statusFingerprint(states: CheckState[]): string {
  return stableStringify([...states].sort((a, b) => a.id.localeCompare(b.id)).map(state => ({ id: state.id, ok: state.ok, fingerprint: state.fingerprint })))
}

export function hasStatusAlerts(states: CheckState[]): boolean {
  return states.some(state => !state.ok)
}

export function normaliseCheck(raw: any, index: number, defaultInterval: number): CheckDefinition | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : 'check-' + index
  const kinds: CheckKind[] = ['hardware', 'http', 'command', 'tcp', 'file']
  if (!kinds.includes(raw.kind)) return null
  const interval = Number(raw.intervalSeconds)
  return {
    ...raw,
    id,
    kind: raw.kind,
    intervalSeconds: Number.isFinite(interval) ? Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, interval)) : defaultInterval,
    enabled: raw.enabled !== false,
  }
}

export function parseChecksFile(text: string, defaultInterval: number): { checks: CheckDefinition[]; error?: string } {
  let raw: any
  try { raw = JSON.parse(text) } catch (error) { return { checks: [], error: 'JSON 解析失败：' + String(error) } }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.checks) ? raw.checks : null
  if (!list) return { checks: [], error: '配置缺少 checks 数组' }
  const checks: CheckDefinition[] = []
  const seen = new Set<string>()
  for (let index = 0; index < list.length; index += 1) {
    const check = normaliseCheck(list[index], index, defaultInterval)
    if (!check) continue
    if (seen.has(check.id)) { check.id = check.id + '-' + index }
    seen.add(check.id)
    checks.push(check)
  }
  return { checks }
}

export function defaultChecks(intervalSeconds: number): CheckDefinition[] {
  return [{ id: 'hardware', kind: 'hardware', metrics: ['cpu', 'memory', 'disk', 'uptime'], intervalSeconds, enabled: true }]
}

export interface CheckSchedulerOptions {
  baseDir: string
  configPath: string
  defaultIntervalSeconds: number
  run: CommandRunner
  enabled?: () => boolean
  logger?: (message: string) => void
}

export class CheckScheduler {
  readonly states = new Map<string, CheckState>()
  definitions: CheckDefinition[] = []
  private nextAt = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private lastMtime: number | null = null
  private lastReloadCheck = 0
  private configError: string | undefined
  private readonly options: CheckSchedulerOptions
  private readonly absolutePath: string
  private initPromise: Promise<void> | null = null

  constructor(options: CheckSchedulerOptions) {
    this.options = options
    this.absolutePath = isAbsolute(options.configPath) ? options.configPath : resolve(options.baseDir, options.configPath)
  }

  get path(): string { return this.absolutePath }

  async init(): Promise<void> {
    await this.ensure()
  }

  /** Load the config and run the first round exactly once. */
  ensure(): Promise<void> {
    if (this.initPromise === null) {
      this.initPromise = (async () => {
        await this.reload(true)
        await this.runDue(true)
      })()
    }
    return this.initPromise
  }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.tick() }, 1000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    if (this.options.enabled && !this.options.enabled()) return
    this.ticking = true
    try {
      await this.reloadIfChanged()
      await this.runDue(false)
    } finally {
      this.ticking = false
    }
  }

  private async reloadIfChanged(): Promise<void> {
    const now = Date.now()
    if (now - this.lastReloadCheck < 5000) return
    this.lastReloadCheck = now
    try {
      const info = await stat(this.absolutePath)
      if (this.lastMtime === null || info.mtimeMs !== this.lastMtime) await this.reload(false)
    } catch {
      if (this.lastMtime !== null) await this.reload(false)
    }
  }

  async reload(force: boolean): Promise<void> {
    let mtime: number | null = null
    let text: string | null = null
    try {
      const info = await stat(this.absolutePath)
      mtime = info.mtimeMs
      text = await readFile(this.absolutePath, 'utf8')
    } catch {
      text = null
    }
    if (!force && mtime !== null && mtime === this.lastMtime) return
    this.lastMtime = mtime
    if (text === null) {
      this.definitions = defaultChecks(this.options.defaultIntervalSeconds)
      this.states.clear()
      this.nextAt.clear()
      this.configError = undefined
      this.options.logger?.('checks file not found; using default hardware checks')
      return
    }
    const parsed = parseChecksFile(text, this.options.defaultIntervalSeconds)
    if (parsed.error) {
      this.configError = parsed.error
      this.options.logger?.('checks file error: ' + parsed.error)
      if (this.definitions.length === 0) this.definitions = defaultChecks(this.options.defaultIntervalSeconds)
      return
    }
    this.configError = undefined
    this.definitions = parsed.checks.length > 0 ? parsed.checks : defaultChecks(this.options.defaultIntervalSeconds)
    const ids = new Set(this.definitions.map(def => def.id))
    for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id)
    this.nextAt.clear()
  }

  private intervalOf(def: CheckDefinition): number {
    return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, def.intervalSeconds ?? this.options.defaultIntervalSeconds))
  }

  async runDue(force: boolean): Promise<CheckState[]> {
    if (this.options.enabled && !this.options.enabled()) return []
    const now = Date.now()
    const due = this.definitions.filter(def => def.enabled !== false && (force || (this.nextAt.get(def.id) ?? 0) <= now))
    if (due.length === 0) return []
    await Promise.all(due.map(async def => {
      this.nextAt.set(def.id, now + this.intervalOf(def) * 1000)
      const state = await runCheck(def, { cwd: this.options.baseDir, run: this.options.run, timeoutMs: Math.min(15_000, this.intervalOf(def) * 1000) })
      this.states.set(def.id, state)
    }))
    return [...this.states.values()]
  }

  async runAll(force = true): Promise<CheckState[]> {
    return this.runDue(force)
  }

  async runOne(id: string, force = true): Promise<CheckState | undefined> {
    const def = this.definitions.find(item => item.id === id)
    if (!def) return undefined
    if (!force) {
      const existing = this.states.get(id)
      if (existing !== undefined) return existing
    }
    this.nextAt.set(def.id, Date.now() + this.intervalOf(def) * 1000)
    const state = await runCheck(def, { cwd: this.options.baseDir, run: this.options.run, timeoutMs: Math.min(15_000, this.intervalOf(def) * 1000) })
    this.states.set(def.id, state)
    return state
  }

  list(): CheckDefinition[] { return [...this.definitions] }
  snapshot(): CheckState[] { return [...this.states.values()] }
  fingerprint(): string { return statusFingerprint(this.snapshot()) }
  hasAlerts(): boolean { return hasStatusAlerts(this.snapshot()) }
  format(now = new Date(), staleMinutes?: number): string {
    return formatStatusReport(this.snapshot(), { now, staleMinutes, intervalSeconds: this.options.defaultIntervalSeconds, configError: this.configError })
  }
}
