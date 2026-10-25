import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckScheduler, formatStatusReport, parseChecksFile, runCheck, statusFingerprint } from '../lib/index.js'

const dir = await mkdtemp(join(tmpdir(), 'checks-test-'))
const run = async argv => {
  const joined = argv.join(' ')
  if (joined.includes('battery-json')) return JSON.stringify({ temp: 42 })
  if (joined.includes('bad-json')) return 'not-json'
  return null
}
const context = { cwd: dir, run, timeoutMs: 3000 }

let battery = 78
const server = createServer((req, res) => {
  if (req.url === '/ok') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ battery: { level: battery }, mode: 'AUTO', pose: { x: 1.2, y: -0.4 }, error: null }))
  } else if (req.url === '/low') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ battery: { level: 12 }, mode: 'AUTO' }))
  } else if (req.url === '/fail') {
    res.statusCode = 503
    res.end('unavailable')
  } else {
    res.statusCode = 404
    res.end('missing')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = 'http://127.0.0.1:' + port

const robot = {
  id: 'robot',
  kind: 'http',
  intervalSeconds: 10,
  url: base + '/ok',
  fields: { battery: 'battery.level', mode: 'mode', x: 'pose.x', y: 'pose.y', error: 'error' },
  expect: { battery: { min: 20 }, error: { equals: null } },
}
let state = await runCheck(robot, context)
const robotState = state
assert.equal(state.ok, true)
assert.equal(state.data.battery, 78)
assert.equal(state.data.mode, 'AUTO')
assert.equal(state.data.x, 1.2)
assert.equal(state.data.error, null)

state = await runCheck({ ...robot, url: base + '/low' }, context)
assert.equal(state.ok, false)
assert.ok(state.error.includes('battery=12 < 20'))

state = await runCheck({ ...robot, url: base + '/fail' }, context)
assert.equal(state.ok, false)
assert.ok(state.error.includes('HTTP 503'))

state = await runCheck({
  id: 'temperature',
  kind: 'command',
  command: ['battery-json'],
  json: true,
  fields: { temperature: 'temp' },
  expect: { temperature: { max: 50 } },
}, context)
assert.equal(state.ok, true)
assert.equal(state.data.temperature, 42)

state = await runCheck({ id: 'bad-json', kind: 'command', command: ['bad-json'], json: true }, context)
assert.equal(state.ok, false)
assert.ok(state.error.length > 0)

state = await runCheck({ id: 'port', kind: 'tcp', host: '127.0.0.1', port }, context)
assert.equal(state.ok, true)
assert.equal(state.data.open, true)

const closedServer = createServer((_req, res) => res.end('x'))
await new Promise(resolve => closedServer.listen(0, '127.0.0.1', resolve))
const closedPort = closedServer.address().port
await new Promise(resolve => closedServer.close(resolve))
state = await runCheck({ id: 'closed', kind: 'tcp', host: '127.0.0.1', port: closedPort, timeoutMs: 800 }, context)
assert.equal(state.ok, false)

const stateFile = join(dir, 'state.json')
await writeFile(stateFile, '{"ready":true}')
state = await runCheck({ id: 'state-file', kind: 'file', path: stateFile, minSize: 1 }, context)
assert.equal(state.ok, true)
assert.equal(state.data.exists, true)
state = await runCheck({ id: 'missing-file', kind: 'file', path: join(dir, 'nope.json'), exists: false }, context)
assert.equal(state.ok, true)
assert.equal(state.data.exists, false)

state = await runCheck({ id: 'hardware', kind: 'hardware', metrics: ['cpu', 'memory', 'uptime'] }, context)
assert.equal(state.ok, true)
assert.ok(state.data.cpu.cores > 0)
assert.ok(state.data.memory.totalBytes > 0)
assert.ok(state.data.uptimeSeconds >= 0)

const hardwareRun = async argv => {
  const joined = argv.join(' ')
  if (joined.includes('Win32_Battery')) return JSON.stringify({ EstimatedChargeRemaining: 78, BatteryStatus: 2 })
  if (joined.includes('Get-Process')) return JSON.stringify([{ Name: 'node', CPU: 1 }])
  if (joined.includes('Get-NetTCPConnection')) return JSON.stringify([{ LocalPort: 8080 }])
  if (joined.includes('MSAcpi_ThermalZoneTemperature')) return JSON.stringify({ CurrentTemperature: 3000 })
  if (joined.startsWith('nvidia-smi')) return 'GPU0, 45, 12, 2048, 8192'
  return null
}
state = await runCheck({ id: 'hardware-all', kind: 'hardware', metrics: ['cpu', 'battery', 'gpu', 'processes', 'ports', 'temperature'] }, { cwd: dir, run: hardwareRun, timeoutMs: 3000 })
assert.equal(state.ok, true)
assert.equal(state.data.battery.percent, 78)
assert.equal(state.data.battery.charging, true)
assert.equal(state.data.gpu[0].temperatureC, 45)
assert.equal(state.data.gpu[0].utilizationPercent, 12)
assert.equal(state.data.processes.length, 1)
assert.equal(state.data.ports.length, 1)
assert.equal(state.data.temperatureC, 26.9)

const report = formatStatusReport([state, robotState], { staleMinutes: 10 })
assert.ok(report.includes('【硬件与远程状态】'))
assert.ok(report.includes('CPU'))
assert.ok(report.includes('robot'))
assert.equal(statusFingerprint([state]), statusFingerprint([state]))

const oldState = { ...state, at: Date.now() - 20 * 60_000 }
assert.ok(formatStatusReport([oldState], { staleMinutes: 10 }).includes('数据已过期'))

const parsed = parseChecksFile(JSON.stringify({ checks: [robot, { ...robot, id: 'robot' }, { id: 'bad', kind: 'nope' }] }), 30)
assert.equal(parsed.checks.length, 2)
assert.notEqual(parsed.checks[0].id, parsed.checks[1].id)
assert.ok(parsed.checks[0].intervalSeconds >= 5)
assert.ok(parseChecksFile('{', 30).error)
assert.ok(parseChecksFile('{"checks":[]}', 30).checks.length === 0)
const example = parseChecksFile(await readFile(new URL('../runtime-checks.example.json', import.meta.url), 'utf8'), 30)
assert.equal(example.error, undefined)
assert.ok(example.checks.length >= 5)

const configPath = join(dir, 'runtime-checks.json')
await writeFile(configPath, JSON.stringify({ checks: [{ id: 'hardware', kind: 'hardware', metrics: ['cpu'], intervalSeconds: 60 }] }))
const scheduler = new CheckScheduler({ baseDir: dir, configPath, defaultIntervalSeconds: 30, run, enabled: () => true })
await scheduler.ensure()
assert.equal(scheduler.list().length, 1)
assert.equal(scheduler.snapshot().length, 1)
assert.ok(scheduler.format(new Date(), 10).includes('CPU'))
assert.equal(scheduler.hasAlerts(), false)
const one = await scheduler.runOne('hardware', true)
assert.equal(one.id, 'hardware')

await writeFile(configPath, JSON.stringify({ checks: [{ id: 'memory', kind: 'hardware', metrics: ['memory'], intervalSeconds: 60 }] }))
await scheduler.reload(true)
assert.equal(scheduler.list()[0].id, 'memory')

server.close()
console.log('hardware/http/command/tcp/file, thresholds, parsing, scheduler, and formatting tests passed')
