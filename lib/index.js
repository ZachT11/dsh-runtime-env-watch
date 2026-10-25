import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import "@deepseek-ai/dsh-subprocess";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-working-directory";
import { readFile, stat, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import os from "node:os";
import { createConnection } from "node:net";

//#region src/runtime.ts
async function packageManager(cwd) {
	try {
		const raw = await readFile(join(cwd, "package.json"), "utf8");
		const pkg = JSON.parse(raw);
		return typeof pkg?.packageManager === "string" ? pkg.packageManager : null;
	} catch {
		return null;
	}
}
function parseGitStatus(text) {
	const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
	let modified = 0, added = 0, deleted = 0, renamed = 0;
	for (const line of lines) {
		const code = line.slice(0, 2);
		if (code.includes("R")) renamed += 1;
		else if (code.includes("D")) deleted += 1;
		else if (code.includes("A") || code === "??") added += 1;
		else if (code.includes("M")) modified += 1;
	}
	return {
		dirty: lines.length,
		modified,
		added,
		deleted,
		renamed
	};
}
let shellCache = null;
async function detectShell(run, cwd, timeoutMs, signal) {
	if (shellCache && Date.now() - shellCache.at < 1440 * 6e4) return shellCache.value;
	let value = "";
	for (const candidate of ["pwsh", "powershell"]) {
		const version = await run([
			candidate,
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$PSVersionTable.PSVersion.ToString()"
		], cwd, timeoutMs, signal);
		if (version && /^\d+\.\d+/.test(version.trim())) {
			value = "PowerShell " + version.trim();
			break;
		}
	}
	if (!value) value = process.env.ComSpec || process.env.SHELL || "unknown";
	shellCache = {
		at: Date.now(),
		value
	};
	return value;
}
async function fileFacts(cwd, paths) {
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const name$1 of paths) {
		if (seen.has(name$1)) continue;
		seen.add(name$1);
		try {
			const info = await stat(join(cwd, name$1));
			result.push({
				path: name$1,
				exists: true,
				mtimeMs: info.mtimeMs,
				size: info.size
			});
		} catch {
			result.push({
				path: name$1,
				exists: false,
				mtimeMs: null,
				size: null
			});
		}
	}
	return result;
}
async function collectRuntimeFacts(cwd, options) {
	const timeoutMs = options.timeoutMs ?? 4e3;
	const run = options.run;
	const [gitVersion, pnpm, files, shell] = await Promise.all([
		run(["git", "--version"], cwd, timeoutMs, options.signal),
		packageManager(cwd),
		fileFacts(cwd, options.watchFiles),
		detectShell(run, cwd, timeoutMs, options.signal)
	]);
	let git = null;
	if (await run([
		"git",
		"rev-parse",
		"--is-inside-work-tree"
	], cwd, timeoutMs, options.signal) === "true") {
		const [branchText, headText, statusText] = await Promise.all([
			run([
				"git",
				"rev-parse",
				"--abbrev-ref",
				"HEAD"
			], cwd, timeoutMs, options.signal),
			run([
				"git",
				"rev-parse",
				"--short",
				"HEAD"
			], cwd, timeoutMs, options.signal),
			run([
				"git",
				"status",
				"--porcelain=v1",
				"--untracked-files=no"
			], cwd, timeoutMs, options.signal)
		]);
		const counts = statusText === null ? {
			dirty: 0,
			modified: 0,
			added: 0,
			deleted: 0,
			renamed: 0
		} : parseGitStatus(statusText);
		git = {
			branch: branchText || "HEAD",
			head: headText || "unknown",
			...counts,
			status: statusText === null ? "timeout" : "ok"
		};
	}
	return {
		cwd,
		platform: os.type(),
		release: os.release(),
		arch: process.arch,
		shell,
		node: process.version,
		gitVersion,
		pnpm,
		git,
		files,
		collectedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
function runtimeFingerprint(facts) {
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
			status: facts.git.status
		},
		files: facts.files.map((file) => [
			file.path,
			file.exists,
			file.mtimeMs,
			file.size
		])
	});
}
function clock(ms) {
	if (ms === null) return "未知";
	return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}
function ageText(ms) {
	const seconds = Math.max(0, Math.floor(ms / 1e3));
	if (seconds < 60) return seconds + " 秒";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return minutes + " 分钟";
	return Math.floor(minutes / 60) + " 小时";
}
function gitLine(git, gitVersion) {
	if (gitVersion === null) return "git 不可用（未安装或不在 PATH）";
	if (git === null) return "当前目录不是 Git 仓库（git 可用）";
	const state = git.status === "timeout" ? "状态读取超时" : git.dirty === 0 ? "工作区干净" : git.dirty + " 个已跟踪改动";
	return git.branch + " @ " + git.head + "；" + state + (git.dirty > 0 ? "（修改 " + git.modified + " / 新增 " + git.added + " / 删除 " + git.deleted + "）" : "");
}
function describeRuntimeChanges(previous, current) {
	if (previous === null) return [];
	const changes = [];
	if (previous.cwd !== current.cwd) changes.push("工作目录 " + previous.cwd + " → " + current.cwd);
	const before = previous.git, after = current.git;
	if (before !== null && after !== null) {
		if (before.branch !== after.branch) changes.push("Git 分支 " + before.branch + " → " + after.branch);
		if (before.head !== after.head) changes.push("Git HEAD " + before.head + " → " + after.head);
		if (before.dirty !== after.dirty) changes.push("已跟踪改动 " + before.dirty + " → " + after.dirty);
	} else if (before === null !== (after === null)) changes.push(after === null ? "Git 仓库变为不可用" : "进入 Git 仓库 " + after.branch);
	for (const file of current.files) {
		const old = previous.files.find((item) => item.path === file.path);
		if (old === void 0) continue;
		if (old.exists !== file.exists) changes.push(file.path + (file.exists ? " 已出现" : " 已消失"));
		else if (file.exists && old.mtimeMs !== file.mtimeMs) changes.push(file.path + " 修改于 " + clock(file.mtimeMs));
	}
	if (previous.node !== current.node) changes.push("Node " + previous.node + " → " + current.node);
	if (previous.pnpm !== current.pnpm) changes.push("pnpm " + (previous.pnpm || "未知") + " → " + (current.pnpm || "未知"));
	if (previous.gitVersion !== current.gitVersion) changes.push("git " + (previous.gitVersion || "未知") + " → " + (current.gitVersion || "未知"));
	return changes.slice(0, 8);
}
function formatRuntimeAudit(facts, options = {}) {
	const now = options.now ?? /* @__PURE__ */ new Date();
	const age = Math.max(0, now.getTime() - Date.parse(facts.collectedAt));
	const position = [options.turn !== void 0 ? "第 " + options.turn + " 轮" : "", options.step !== void 0 ? "第 " + options.step + " 步" : ""].filter(Boolean).join(" · ");
	const lines = [
		"【AI 运行环境巡检】" + (position ? position + " · " : "") + "采集于 " + new Date(facts.collectedAt).toLocaleString("zh-CN", { hour12: false }) + "（" + ageText(age) + "前）",
		"工作目录：" + facts.cwd,
		"平台：" + facts.platform + " " + facts.release + "（" + facts.arch + "） / Node " + facts.node + (facts.pnpm ? " / " + facts.pnpm : "") + (facts.gitVersion ? " / " + facts.gitVersion : ""),
		"Shell：" + facts.shell,
		"Git：" + gitLine(facts.git, facts.gitVersion),
		"关键文件：" + (facts.files.length === 0 ? "未配置" : facts.files.map((file) => file.exists ? file.path + " " + clock(file.mtimeMs) : file.path + " 不存在").join("；"))
	];
	const changes = describeRuntimeChanges(options.previous ?? null, facts);
	if (changes.length > 0) lines.push("变化：" + changes.join("；"));
	else if (options.previous) lines.push("变化：无（与上次巡检相同）");
	else lines.push("变化：首次巡检，无历史可比");
	if (options.staleMinutes !== void 0 && age > options.staleMinutes * 6e4) lines.push("注意：这次巡检已超过 " + options.staleMinutes + " 分钟 TTL；执行依赖环境的操作前请调用 runtime_env(refresh=true) 重新检查。");
	lines.push("规则：运行环境是带时间戳的快照，不是常量。会话早期的 pwd、git status、node -v 只能作历史；执行依赖目录、Git、关键文件或工具链的操作前，以最新巡检或 runtime_env 结果为准；过期就先刷新。");
	return lines.join("\n");
}
function runtimePolicy() {
	return [
		"【AI 运行环境规则】",
		"运行环境（工作目录、Git、关键文件、工具链、Shell）通过带时间戳的“AI 运行环境巡检”消息推送；最新一条或 runtime_env 工具结果才有效，更早的只是历史。",
		"不要把会话早期的 pwd、git status、node -v 当作永久事实；文件、分支、依赖和工具链都可能变化。",
		"执行依赖环境的操作前，先读最新巡检；需要确认当前状态时调用 runtime_env(refresh=true)。如果巡检已经过期，明确说明并重新检查，不要沿用旧值。"
	].join("\n");
}

//#endregion
//#region src/checks.ts
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 3600;
function round(value, digits = 1) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = [
		"B",
		"KB",
		"MB",
		"GB",
		"TB"
	];
	let value = bytes;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + " " + units[index];
}
function formatDuration(seconds) {
	const s = Math.max(0, Math.floor(seconds));
	const days = Math.floor(s / 86400);
	const hours = Math.floor(s % 86400 / 3600);
	const minutes = Math.floor(s % 3600 / 60);
	if (days > 0) return days + "d " + hours + "h";
	if (hours > 0) return hours + "h " + minutes + "m";
	if (minutes > 0) return minutes + "m";
	return s + "s";
}
function truncate(text, limit = 1200) {
	return text.length <= limit ? text : text.slice(0, limit) + "…";
}
function stableStringify(value) {
	const walk = (input) => {
		if (Array.isArray(input)) return input.map(walk);
		if (input !== null && typeof input === "object") return Object.fromEntries(Object.keys(input).sort().map((key) => [key, walk(input[key])]));
		return input;
	};
	return JSON.stringify(walk(value));
}
function getPath(value, path) {
	if (!path) return value;
	return path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce((current, key) => current == null ? void 0 : current[key], value);
}
function extractFields(value, fields) {
	if (!fields) return void 0;
	const result = {};
	for (const [name$1, path] of Object.entries(fields)) result[name$1] = getPath(value, path);
	return result;
}
function evaluateExpectations(expect, data) {
	const alerts = [];
	if (!expect) return alerts;
	for (const [path, rule] of Object.entries(expect)) {
		const value = getPath(data, path);
		if (rule.exists !== void 0) {
			const present = value !== void 0 && value !== null;
			if (present !== rule.exists) alerts.push(path + (rule.exists ? " 不存在" : " 意外存在"));
			if (!present) continue;
		}
		if (value === void 0) {
			alerts.push(path + " 缺失");
			continue;
		}
		if (value !== null) {
			if (rule.min !== void 0 && Number(value) < rule.min) alerts.push(path + "=" + String(value) + " < " + rule.min);
			if (rule.max !== void 0 && Number(value) > rule.max) alerts.push(path + "=" + String(value) + " > " + rule.max);
		}
		if (rule.equals !== void 0 && stableStringify(value) !== stableStringify(rule.equals)) alerts.push(path + "≠" + JSON.stringify(rule.equals));
		if (rule.contains !== void 0 && !String(value).includes(rule.contains)) alerts.push(path + " 不包含 " + JSON.stringify(rule.contains));
	}
	return alerts;
}
let previousCpu = null;
let cpuCache = null;
function cpuSample() {
	if (cpuCache !== null && Date.now() - cpuCache.at < 1e3) return cpuCache.value;
	const cpus = os.cpus();
	let idle = 0;
	let total = 0;
	for (const cpu of cpus) {
		idle += cpu.times.idle;
		total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
	}
	const usage = previousCpu !== null && total > previousCpu.total ? (1 - (idle - previousCpu.idle) / (total - previousCpu.total)) * 100 : total > 0 ? (1 - idle / total) * 100 : 0;
	previousCpu = {
		idle,
		total
	};
	const value = {
		usagePercent: round(Math.max(0, Math.min(100, usage))),
		cores: cpus.length
	};
	cpuCache = {
		at: Date.now(),
		value
	};
	return value;
}
async function powerShell(run, cwd, script, timeoutMs, signal) {
	for (const executable of ["pwsh", "powershell"]) {
		const output = await run([
			executable,
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], cwd, timeoutMs, signal);
		if (output !== null) return output;
	}
	return null;
}
async function collectHardware(def, ctx) {
	const metrics = def.metrics?.length ? def.metrics : [
		"cpu",
		"memory",
		"disk",
		"uptime"
	];
	const data = {};
	const errors = [];
	for (const metric of metrics) try {
		if (metric === "cpu") data.cpu = cpuSample();
		else if (metric === "memory") {
			const total = os.totalmem();
			const free = os.freemem();
			data.memory = {
				totalBytes: total,
				usedBytes: total - free,
				freeBytes: free,
				usedPercent: round((total - free) / total * 100)
			};
		} else if (metric === "disk") {
			const paths = def.diskPaths?.length ? def.diskPaths : [process.env.SystemDrive ? process.env.SystemDrive + "\\" : "/"];
			const disks = [];
			for (const path of paths) try {
				const fs = await statfs(path);
				const total = Number(fs.blocks) * Number(fs.bsize);
				const available = Number(fs.bavail) * Number(fs.bsize);
				disks.push({
					path,
					totalBytes: total,
					freeBytes: available,
					usedPercent: total > 0 ? round((total - available) / total * 100) : 0
				});
			} catch (error) {
				errors.push("disk " + path + ": " + String(error));
			}
			data.disk = disks;
		} else if (metric === "uptime") data.uptimeSeconds = Math.floor(os.uptime());
		else if (metric === "battery") {
			const text = await powerShell(ctx.run, ctx.cwd, "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress", ctx.timeoutMs, ctx.signal);
			if (text === null) errors.push("battery: PowerShell probe failed");
			else {
				const parsed = JSON.parse(text);
				const status = Number(parsed.BatteryStatus);
				data.battery = {
					percent: Number(parsed.EstimatedChargeRemaining),
					charging: [
						2,
						6,
						7,
						8,
						9
					].includes(status),
					status
				};
			}
		} else if (metric === "gpu") {
			const text = await ctx.run([
				"nvidia-smi",
				"--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total",
				"--format=csv,noheader,nounits"
			], ctx.cwd, ctx.timeoutMs, ctx.signal);
			if (text === null) errors.push("gpu: nvidia-smi unavailable");
			else data.gpu = text.split("\n").filter(Boolean).map((line) => {
				const [name$1, temperatureC, utilizationPercent, memoryUsedMiB, memoryTotalMiB] = line.split(",").map((part) => part.trim());
				return {
					name: name$1,
					temperatureC: Number(temperatureC),
					utilizationPercent: Number(utilizationPercent),
					memoryUsedMiB: Number(memoryUsedMiB),
					memoryTotalMiB: Number(memoryTotalMiB)
				};
			});
		} else if (metric === "processes") {
			const text = await powerShell(ctx.run, ctx.cwd, "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name,CPU,WorkingSet64 | ConvertTo-Json -Compress", ctx.timeoutMs, ctx.signal);
			if (text === null) errors.push("processes: PowerShell probe failed");
			else data.processes = JSON.parse(text);
		} else if (metric === "ports") {
			const text = await powerShell(ctx.run, ctx.cwd, "Get-NetTCPConnection -State Listen | Select-Object -First 20 LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress", ctx.timeoutMs, ctx.signal);
			if (text === null) errors.push("ports: PowerShell probe failed");
			else data.ports = JSON.parse(text);
		} else if (metric === "temperature") {
			const text = await powerShell(ctx.run, ctx.cwd, "Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1 CurrentTemperature | ConvertTo-Json -Compress", ctx.timeoutMs, ctx.signal);
			if (text === null) errors.push("temperature: probe failed");
			else data.temperatureC = round(Number(JSON.parse(text).CurrentTemperature) / 10 - 273.15);
		}
	} catch (error) {
		errors.push(metric + ": " + String(error));
	}
	if (errors.length > 0) data.errors = errors;
	return data;
}
async function collectHttp(def, ctx) {
	if (!def.url) throw new Error("http check requires url");
	const response = await fetch(def.url, {
		method: def.method ?? "GET",
		headers: def.headers,
		body: def.body,
		signal: ctx.signal
	});
	const text = await response.text();
	let parsed = text;
	try {
		parsed = JSON.parse(text);
	} catch {}
	const data = { _status: response.status };
	if (def.fields) Object.assign(data, extractFields(parsed, def.fields));
	else if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(data, parsed);
	else data.body = truncate(String(parsed));
	if (!response.ok) throw new Error("HTTP " + response.status + (text ? ": " + truncate(text, 200) : ""));
	return data;
}
async function collectCommand(def, ctx) {
	if (!def.command?.length) throw new Error("command check requires command array");
	const text = await ctx.run(def.command, def.cwd ? resolve(ctx.cwd, def.cwd) : ctx.cwd, ctx.timeoutMs, ctx.signal);
	if (text === null) throw new Error("command failed or produced no output");
	let parsed = text;
	if (def.json) parsed = JSON.parse(text);
	const data = {};
	if (def.fields) Object.assign(data, extractFields(parsed, def.fields));
	else if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(data, parsed);
	else data.stdout = truncate(text);
	return data;
}
async function collectTcp(def, ctx) {
	if (!def.host || typeof def.port !== "number") throw new Error("tcp check requires host and port");
	const host = def.host;
	const port = def.port;
	await new Promise((resolvePromise, rejectPromise) => {
		const socket = createConnection({
			host,
			port
		});
		const timer = setTimeout(() => {
			socket.destroy();
			rejectPromise(/* @__PURE__ */ new Error("timeout"));
		}, ctx.timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolvePromise();
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			socket.destroy();
			rejectPromise(error);
		});
		ctx.signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			socket.destroy();
			rejectPromise(/* @__PURE__ */ new Error("aborted"));
		}, { once: true });
	});
	return {
		host: def.host,
		port: def.port,
		open: true
	};
}
async function collectFile(def, ctx) {
	if (!def.path) throw new Error("file check requires path");
	const target = isAbsolute(def.path) ? def.path : join(ctx.cwd, def.path);
	try {
		const info = await stat(target);
		const data = {
			path: target,
			exists: true,
			size: info.size,
			mtimeMs: info.mtimeMs,
			ageSeconds: Math.max(0, Math.floor((Date.now() - info.mtimeMs) / 1e3))
		};
		if (def.minSize !== void 0 && info.size < def.minSize) data._sizeAlert = "size " + info.size + " < " + def.minSize;
		if (def.maxAgeSeconds !== void 0 && data.ageSeconds > def.maxAgeSeconds) data._ageAlert = "age " + data.ageSeconds + "s > " + def.maxAgeSeconds + "s";
		return data;
	} catch {
		return {
			path: target,
			exists: false
		};
	}
}
async function executeCheck(def, ctx) {
	if (def.kind === "hardware") return collectHardware(def, ctx);
	if (def.kind === "http") return collectHttp(def, ctx);
	if (def.kind === "command") return collectCommand(def, ctx);
	if (def.kind === "tcp") return collectTcp(def, ctx);
	if (def.kind === "file") return collectFile(def, ctx);
	throw new Error("unknown check kind: " + String(def.kind));
}
async function runCheck(def, ctx) {
	const started = Date.now();
	const timeoutMs = Math.max(500, def.timeoutMs ?? ctx.timeoutMs);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
	try {
		const data = await executeCheck(def, {
			...ctx,
			signal,
			timeoutMs
		});
		const alerts = evaluateExpectations(def.expect, data);
		const errors = Array.isArray(data.errors) ? data.errors.map(String) : [];
		if (def.kind === "file") {
			if (data._sizeAlert) alerts.push(data._sizeAlert);
			if (data._ageAlert) alerts.push(data._ageAlert);
			const expectExists = def.exists !== false;
			if (data.exists !== expectExists) alerts.push("文件" + (expectExists ? "不存在" : "存在"));
		}
		const allAlerts = [...errors, ...alerts];
		return {
			id: def.id,
			kind: def.kind,
			at: Date.now(),
			ok: allAlerts.length === 0,
			data,
			error: allAlerts.length > 0 ? allAlerts.join("; ") : void 0,
			durationMs: Date.now() - started,
			fingerprint: stableStringify({
				kind: def.kind,
				data: fingerprintData(def.kind, data),
				ok: allAlerts.length === 0
			}),
			alerts: allAlerts
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			id: def.id,
			kind: def.kind,
			at: Date.now(),
			ok: false,
			data: { errors: [message] },
			error: message,
			durationMs: Date.now() - started,
			fingerprint: stableStringify({
				kind: def.kind,
				error: message
			}),
			alerts: [message]
		};
	} finally {
		clearTimeout(timer);
	}
}
function fingerprintData(kind, data) {
	if (kind !== "hardware") return data;
	const rounded = (value, step) => Number.isFinite(Number(value)) ? Math.round(Number(value) / step) * step : null;
	const result = {};
	if (data.cpu) result.cpu = rounded(data.cpu.usagePercent, 10);
	if (data.memory) result.memory = rounded(data.memory.usedPercent, 5);
	if (Array.isArray(data.disk)) result.disk = data.disk.map((disk) => ({
		path: disk.path,
		used: rounded(disk.usedPercent, 5)
	}));
	if (data.battery) result.battery = {
		percent: rounded(data.battery.percent, 5),
		charging: Boolean(data.battery.charging)
	};
	if (Array.isArray(data.gpu)) result.gpu = data.gpu.map((gpu) => ({
		name: gpu.name,
		temp: rounded(gpu.temperatureC, 5),
		util: rounded(gpu.utilizationPercent, 10)
	}));
	if (Array.isArray(data.errors)) result.errors = data.errors;
	return result;
}
function formatHardware(data) {
	const parts = [];
	if (data.cpu) parts.push("CPU " + data.cpu.usagePercent + "%（" + data.cpu.cores + " 核）");
	if (data.memory) parts.push("内存 " + data.memory.usedPercent + "%（" + formatBytes(data.memory.usedBytes) + "/" + formatBytes(data.memory.totalBytes) + "）");
	if (Array.isArray(data.disk)) for (const disk of data.disk) parts.push("磁盘 " + disk.path + " 已用 " + disk.usedPercent + "%（剩余 " + formatBytes(disk.freeBytes) + "）");
	if (data.uptimeSeconds !== void 0) parts.push("开机 " + formatDuration(data.uptimeSeconds));
	if (data.battery) parts.push("电量 " + data.battery.percent + "%" + (data.battery.charging ? "（充电中）" : ""));
	if (Array.isArray(data.gpu)) for (const gpu of data.gpu) parts.push("GPU " + (gpu.name || "") + " " + gpu.temperatureC + "°C " + gpu.utilizationPercent + "%（显存 " + gpu.memoryUsedMiB + "/" + gpu.memoryTotalMiB + " MiB）");
	if (Array.isArray(data.processes)) parts.push("进程 " + data.processes.length + " 条");
	if (Array.isArray(data.ports)) parts.push("监听端口 " + data.ports.length + " 条");
	if (data.temperatureC !== void 0) parts.push("温度 " + data.temperatureC + "°C");
	if (Array.isArray(data.errors) && data.errors.length > 0) parts.push("失败项：" + data.errors.join("；"));
	return parts.join("；");
}
function formatData(data) {
	return Object.entries(data).filter(([key]) => !key.startsWith("_") && key !== "errors").slice(0, 8).map(([key, value]) => key + "=" + (typeof value === "object" ? truncate(JSON.stringify(value), 120) : String(value))).join("；");
}
function formatCheckState(state, now = Date.now(), staleMinutes) {
	const age = Math.max(0, Math.floor((now - state.at) / 1e3));
	const stale = staleMinutes !== void 0 && age > staleMinutes * 60;
	const label = state.kind === "hardware" ? state.id === "hardware" ? "硬件" : "硬件·" + state.id : state.id;
	const body = state.kind === "hardware" ? formatHardware(state.data) : formatData(state.data);
	const status = state.ok ? "正常" : "异常";
	return label + "：" + status + (body ? "；" + body : "") + (state.error && !state.ok ? "；" + state.error : "") + (stale ? "（数据已过期 " + formatDuration(age) + "）" : "");
}
function formatStatusReport(states, options = {}) {
	if (states.length === 0 && !options.configError) return "";
	const now = options.now ?? /* @__PURE__ */ new Date();
	const lines = ["【硬件与远程状态】按配置周期巡检" + (states.length > 0 ? "；采集于 " + new Date(Math.max(...states.map((state) => state.at))).toLocaleString("zh-CN", { hour12: false }) : "")];
	for (const state of [...states].sort((a, b) => a.id.localeCompare(b.id))) lines.push("- " + formatCheckState(state, now.getTime(), options.staleMinutes));
	if (options.configError) lines.push("配置错误：" + options.configError);
	const alerts = states.filter((state) => !state.ok);
	if (alerts.length > 0) lines.push("异常：" + alerts.map((state) => state.id + "（" + (state.error || "未通过") + "）").join("；"));
	return lines.join("\n");
}
function statusFingerprint(states) {
	return stableStringify([...states].sort((a, b) => a.id.localeCompare(b.id)).map((state) => ({
		id: state.id,
		ok: state.ok,
		fingerprint: state.fingerprint
	})));
}
function hasStatusAlerts(states) {
	return states.some((state) => !state.ok);
}
function normaliseCheck(raw, index, defaultInterval) {
	if (!raw || typeof raw !== "object") return null;
	const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "check-" + index;
	if (![
		"hardware",
		"http",
		"command",
		"tcp",
		"file"
	].includes(raw.kind)) return null;
	const interval = Number(raw.intervalSeconds);
	return {
		...raw,
		id,
		kind: raw.kind,
		intervalSeconds: Number.isFinite(interval) ? Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, interval)) : defaultInterval,
		enabled: raw.enabled !== false
	};
}
function parseChecksFile(text, defaultInterval) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			checks: [],
			error: "JSON 解析失败：" + String(error)
		};
	}
	const list = Array.isArray(raw) ? raw : Array.isArray(raw?.checks) ? raw.checks : null;
	if (!list) return {
		checks: [],
		error: "配置缺少 checks 数组"
	};
	const checks = [];
	const seen = /* @__PURE__ */ new Set();
	for (let index = 0; index < list.length; index += 1) {
		const check = normaliseCheck(list[index], index, defaultInterval);
		if (!check) continue;
		if (seen.has(check.id)) check.id = check.id + "-" + index;
		seen.add(check.id);
		checks.push(check);
	}
	return { checks };
}
function defaultChecks(intervalSeconds) {
	return [{
		id: "hardware",
		kind: "hardware",
		metrics: [
			"cpu",
			"memory",
			"disk",
			"uptime"
		],
		intervalSeconds,
		enabled: true
	}];
}
var CheckScheduler = class {
	states = /* @__PURE__ */ new Map();
	definitions = [];
	nextAt = /* @__PURE__ */ new Map();
	timer;
	ticking = false;
	lastMtime = null;
	lastReloadCheck = 0;
	configError;
	options;
	absolutePath;
	initPromise = null;
	constructor(options) {
		this.options = options;
		this.absolutePath = isAbsolute(options.configPath) ? options.configPath : resolve(options.baseDir, options.configPath);
	}
	get path() {
		return this.absolutePath;
	}
	async init() {
		await this.ensure();
	}
	/** Load the config and run the first round exactly once. */
	ensure() {
		if (this.initPromise === null) this.initPromise = (async () => {
			await this.reload(true);
			await this.runDue(true);
		})();
		return this.initPromise;
	}
	start() {
		if (this.timer !== void 0) return;
		this.timer = setInterval(() => {
			this.tick();
		}, 1e3);
		this.timer.unref?.();
	}
	stop() {
		if (this.timer !== void 0) clearInterval(this.timer);
		this.timer = void 0;
	}
	async tick() {
		if (this.ticking) return;
		if (this.options.enabled && !this.options.enabled()) return;
		this.ticking = true;
		try {
			await this.reloadIfChanged();
			await this.runDue(false);
		} finally {
			this.ticking = false;
		}
	}
	async reloadIfChanged() {
		const now = Date.now();
		if (now - this.lastReloadCheck < 5e3) return;
		this.lastReloadCheck = now;
		try {
			const info = await stat(this.absolutePath);
			if (this.lastMtime === null || info.mtimeMs !== this.lastMtime) await this.reload(false);
		} catch {
			if (this.lastMtime !== null) await this.reload(false);
		}
	}
	async reload(force) {
		let mtime = null;
		let text = null;
		try {
			mtime = (await stat(this.absolutePath)).mtimeMs;
			text = await readFile(this.absolutePath, "utf8");
		} catch {
			text = null;
		}
		if (!force && mtime !== null && mtime === this.lastMtime) return;
		this.lastMtime = mtime;
		if (text === null) {
			this.definitions = defaultChecks(this.options.defaultIntervalSeconds);
			this.states.clear();
			this.nextAt.clear();
			this.configError = void 0;
			this.options.logger?.("checks file not found; using default hardware checks");
			return;
		}
		const parsed = parseChecksFile(text, this.options.defaultIntervalSeconds);
		if (parsed.error) {
			this.configError = parsed.error;
			this.options.logger?.("checks file error: " + parsed.error);
			if (this.definitions.length === 0) this.definitions = defaultChecks(this.options.defaultIntervalSeconds);
			return;
		}
		this.configError = void 0;
		this.definitions = parsed.checks.length > 0 ? parsed.checks : defaultChecks(this.options.defaultIntervalSeconds);
		const ids = new Set(this.definitions.map((def) => def.id));
		for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id);
		this.nextAt.clear();
	}
	intervalOf(def) {
		return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, def.intervalSeconds ?? this.options.defaultIntervalSeconds));
	}
	async runDue(force) {
		if (this.options.enabled && !this.options.enabled()) return [];
		const now = Date.now();
		const due = this.definitions.filter((def) => def.enabled !== false && (force || (this.nextAt.get(def.id) ?? 0) <= now));
		if (due.length === 0) return [];
		await Promise.all(due.map(async (def) => {
			this.nextAt.set(def.id, now + this.intervalOf(def) * 1e3);
			const state = await runCheck(def, {
				cwd: this.options.baseDir,
				run: this.options.run,
				timeoutMs: Math.min(15e3, this.intervalOf(def) * 1e3)
			});
			this.states.set(def.id, state);
		}));
		return [...this.states.values()];
	}
	async runAll(force = true) {
		return this.runDue(force);
	}
	async runOne(id, force = true) {
		if (!force) {
			const existing = this.states.get(id);
			if (existing !== void 0) return existing;
		}
		const def = this.definitions.find((item) => item.id === id);
		if (!def) return void 0;
		this.nextAt.set(def.id, Date.now() + this.intervalOf(def) * 1e3);
		const state = await runCheck(def, {
			cwd: this.options.baseDir,
			run: this.options.run,
			timeoutMs: Math.min(15e3, this.intervalOf(def) * 1e3)
		});
		this.states.set(def.id, state);
		return state;
	}
	list() {
		return [...this.definitions];
	}
	snapshot() {
		return [...this.states.values()];
	}
	fingerprint() {
		return statusFingerprint(this.snapshot());
	}
	hasAlerts() {
		return hasStatusAlerts(this.snapshot());
	}
	format(now = /* @__PURE__ */ new Date(), staleMinutes) {
		return formatStatusReport(this.snapshot(), {
			now,
			staleMinutes,
			intervalSeconds: this.options.defaultIntervalSeconds,
			configError: this.configError
		});
	}
};

//#endregion
//#region src/index.ts
const name = "runtime-env-watch";
const inject = [
	"tools",
	"systemPrompt",
	"workingDirectory",
	"subprocess"
];
const DEFAULT_FILES = [
	"package.json",
	"pnpm-lock.yaml",
	"package-lock.json",
	"yarn.lock",
	"AGENTS.md",
	"tsconfig.json"
];
const CHANGE_COOLDOWN_MS = 6e4;
const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	probeSeconds: z.number().min(5).max(600).default(30),
	statusIntervalSeconds: z.number().min(5).max(3600).default(30),
	reminderMinutes: z.number().min(1).max(120).default(10),
	staleMinutes: z.number().min(1).max(120).default(10),
	watchFiles: z.array(z.string()).default(DEFAULT_FILES),
	checksFile: z.string().default("runtime-checks.json"),
	sectionOrder: z.number().default(21)
});
function statusPolicy() {
	return [
		"【硬件与远程状态规则】",
		"电脑硬件（CPU、内存、磁盘、电池、GPU、进程、端口）和远程设备（HTTP/命令/TCP/文件检查）的状态，通过带时间戳的“硬件与远程状态”段推送；最新一条或 status_check 结果才有效。",
		"阈值、离线、超时和过期都算异常；执行依赖硬件资源或远程设备的操作前先看最新状态，需要立即确认时调用 status_check(refresh=true)。",
		"不要把一次正常状态当成永久保证：温度、占用、电量、网络和机器人状态都会变化。"
	].join("\n");
}
function apply(ctx, entry) {
	const states = /* @__PURE__ */ new Map();
	const run = async (argv, cwd, timeoutMs, signal) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
		const forwardAbort = () => controller.abort();
		signal?.addEventListener("abort", forwardAbort, { once: true });
		try {
			const handle = ctx.subprocess.spawn({
				argv,
				cwd,
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: 2 * 1024 * 1024 },
					stderr: { maxBytes: 256 * 1024 }
				},
				graceMs: 500,
				signal: controller.signal
			});
			const outcome = await handle.done;
			const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
			const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
			if (outcome.exitCode !== 0 && !stdout) return stderr.trim() || null;
			return (stdout || stderr).trim();
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", forwardAbort);
		}
	};
	const baseDir = ctx.workingDirectory.defaultDirectory ?? process.cwd();
	const logger = ctx.logger;
	const scheduler = new CheckScheduler({
		baseDir,
		configPath: entry.checksFile,
		defaultIntervalSeconds: entry.statusIntervalSeconds,
		run,
		enabled: () => entry.enabled.get(),
		logger: (message) => logger?.warn?.("[runtime-env-watch] " + message)
	});
	ctx.effect(() => {
		let disposed = false;
		scheduler.ensure().catch((error) => logger?.warn?.("[runtime-env-watch] " + String(error))).finally(() => {
			if (!disposed) scheduler.start();
		});
		return () => {
			disposed = true;
			scheduler.stop();
		};
	});
	const statusText = (now) => scheduler.format(now, entry.staleMinutes);
	const combined = (facts, previous, now, turn, step) => {
		const runtime = formatRuntimeAudit(facts, {
			previous,
			now,
			turn,
			step,
			staleMinutes: entry.staleMinutes
		});
		const status = statusText(now);
		return status ? runtime + "\n\n" + status : runtime;
	};
	const probe = async (agent, force, signal) => {
		const key = String(agent.session.id);
		const previous = states.get(key);
		if (!force && previous && Date.now() - previous.at < entry.probeSeconds * 1e3) return {
			state: previous,
			previous
		};
		const facts = await collectRuntimeFacts(ctx.workingDirectory.get(agent.session), {
			watchFiles: [...entry.watchFiles],
			run,
			signal
		});
		const state = {
			facts,
			at: Date.now(),
			pushedAt: previous?.pushedAt ?? 0,
			fingerprint: runtimeFingerprint(facts),
			pending: previous?.pending ?? false,
			statusFingerprint: previous?.statusFingerprint ?? "",
			alert: previous?.alert ?? false
		};
		states.set(key, state);
		return {
			state,
			previous
		};
	};
	ctx.effect(() => ctx.systemPrompt.section({
		name: "runtime-env-watch",
		order: entry.sectionOrder,
		interpolate: false,
		text: () => entry.enabled.get() ? runtimePolicy() + "\n\n" + statusPolicy() : ""
	}));
	ctx.tools.register(defineTool({
		name: "runtime_env",
		description: "Inspect the AI runtime environment with timestamps: working directory, Git branch/HEAD/tracked changes, key file mtimes, Node/pnpm/git versions, Shell and platform. Use refresh=true before actions that depend on the environment instead of trusting an earlier check.",
		parameters: { refresh: {
			type: "boolean",
			description: "Force a fresh probe instead of using the cached snapshot."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true,
						description: "Human-readable runtime environment audit."
					},
					observedAt: {
						type: "string",
						required: true,
						description: "ISO timestamp of the probe."
					},
					changed: {
						type: "boolean",
						required: true,
						description: "Whether material facts changed since the previous probe."
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		async execute(args, exec) {
			if (!entry.enabled.get()) throw new Error("runtime_env is disabled: enable runtime-env-watch in Settings → Plugins, or set enabled: true in the plugin config.");
			if (!exec.agent) throw new Error("runtime_env requires an agent Session");
			const { state, previous } = await probe(exec.agent, args?.refresh === true, exec.signal);
			const changed = previous === void 0 ? true : previous.fingerprint !== state.fingerprint;
			const text = formatRuntimeAudit(state.facts, {
				previous: previous?.facts ?? null,
				now: /* @__PURE__ */ new Date(),
				staleMinutes: entry.staleMinutes
			});
			states.set(String(exec.agent.session.id), {
				...state,
				pushedAt: Date.now(),
				pending: false
			});
			return {
				text,
				observedAt: state.facts.collectedAt,
				changed
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "status_check",
		description: "Run the configured periodic checks now and return the combined runtime, hardware, and remote-device status with timestamps, thresholds, and freshness. Use refresh=true to bypass any cached check result; use id to run one configured check.",
		parameters: {
			id: {
				type: "string",
				description: "Optional check id to run alone."
			},
			refresh: {
				type: "boolean",
				description: "Force a fresh run even when the check just ran."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true,
						description: "Combined runtime and status report."
					},
					observedAt: {
						type: "string",
						required: true,
						description: "ISO timestamp of this check run."
					},
					changed: {
						type: "boolean",
						required: true,
						description: "Whether any runtime or check state changed."
					},
					healthy: {
						type: "boolean",
						required: true,
						description: "Whether every configured check currently passes."
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		async execute(args, exec) {
			if (!entry.enabled.get()) throw new Error("status_check is disabled: enable runtime-env-watch in Settings → Plugins, or set enabled: true in the plugin config.");
			if (!exec.agent) throw new Error("status_check requires an agent Session");
			const key = String(exec.agent.session.id);
			const before = states.get(key);
			await scheduler.ensure();
			const { state } = await probe(exec.agent, true, exec.signal);
			const force = args?.refresh !== false;
			if (typeof args?.id === "string" && args.id) {
				if (!await scheduler.runOne(args.id, force)) throw new Error("unknown check id: " + args.id);
			} else await scheduler.runAll(force);
			const checks = scheduler.snapshot();
			const now = /* @__PURE__ */ new Date();
			const text = combined(state.facts, before?.facts ?? null, now);
			const statusFp = statusFingerprint(checks);
			const alert = hasStatusAlerts(checks);
			const changed = before === void 0 || before.fingerprint !== state.fingerprint || before.statusFingerprint !== statusFp;
			states.set(key, {
				...state,
				pushedAt: now.getTime(),
				pending: false,
				statusFingerprint: statusFp,
				alert
			});
			return {
				text,
				observedAt: now.toISOString(),
				changed,
				healthy: !alert
			};
		}
	}));
	ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		if (decision?.kind === "reject" || payload?.signal?.aborted) return decision;
		if (!entry.enabled.get() || !payload?.agent?.session) return decision;
		await Promise.race([scheduler.ensure(), new Promise((resolve$1) => setTimeout(resolve$1, 1500))]);
		let state;
		let previous;
		try {
			({state, previous} = await probe(payload.agent, false, payload.signal));
		} catch {
			return decision;
		}
		const now = Date.now();
		const checks = scheduler.snapshot();
		const statusFp = statusFingerprint(checks);
		const alert = hasStatusAlerts(checks);
		const major = previous === void 0 || previous.facts.cwd !== state.facts.cwd || previous.facts.git?.branch !== state.facts.git?.branch || previous.facts.git?.head !== state.facts.git?.head || alert && !previous.alert;
		const changed = previous === void 0 || previous.fingerprint !== state.fingerprint || previous.statusFingerprint !== statusFp;
		const pending = (previous?.pending ?? false) || changed && !major;
		const sincePush = now - (previous?.pushedAt ?? 0);
		const changeReady = (changed || (previous?.pending ?? false)) && sincePush >= CHANGE_COOLDOWN_MS;
		const heartbeat = previous === void 0 || sincePush >= entry.reminderMinutes * 6e4;
		const shouldPush = major || changeReady || heartbeat;
		states.set(String(payload.agent.session.id), {
			...state,
			statusFingerprint: statusFp,
			alert,
			pending: pending && !shouldPush
		});
		if (!shouldPush) return decision;
		const text = combined(state.facts, previous?.facts ?? null, new Date(now), payload?.turn, payload?.step);
		const message = createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "runtime-env-watch",
				form: "snapshot",
				sections: [{
					name: "runtime-env-watch",
					text
				}]
			}
		});
		states.set(String(payload.agent.session.id), {
			...state,
			pushedAt: now,
			pending: false,
			statusFingerprint: statusFp,
			alert
		});
		return {
			...decision,
			messages: [...decision.messages, message]
		};
	}, { prepend: true });
}

//#endregion
export { CheckScheduler, Config, apply, collectRuntimeFacts, defaultChecks, describeRuntimeChanges, formatCheckState, formatRuntimeAudit, formatStatusReport, getPath, hasStatusAlerts, inject, name, normaliseCheck, parseChecksFile, runCheck, runtimeFingerprint, runtimePolicy, statusFingerprint };