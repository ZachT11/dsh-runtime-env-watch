import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import "@deepseek-ai/dsh-subprocess";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-working-directory";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

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
	const [gitVersion, pnpm, files] = await Promise.all([
		run(["git", "--version"], cwd, timeoutMs, options.signal),
		packageManager(cwd),
		fileFacts(cwd, options.watchFiles)
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
		shell: process.env.ComSpec || process.env.SHELL || "unknown",
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
function gitLine(git) {
	if (git === null) return "非 Git 仓库，或当前目录不可用";
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
		"Git：" + gitLine(facts.git),
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
	reminderMinutes: z.number().min(1).max(120).default(10),
	staleMinutes: z.number().min(1).max(120).default(10),
	watchFiles: z.array(z.string()).default(DEFAULT_FILES),
	sectionOrder: z.number().default(21)
});
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
			pending: previous?.pending ?? false
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
		text: () => entry.enabled.get() ? runtimePolicy() : ""
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
	ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		if (decision?.kind === "reject" || payload?.signal?.aborted) return decision;
		if (!entry.enabled.get() || !payload?.agent?.session) return decision;
		let state;
		let previous;
		try {
			({state, previous} = await probe(payload.agent, false, payload.signal));
		} catch {
			return decision;
		}
		const now = Date.now();
		const major = previous === void 0 || previous.facts.cwd !== state.facts.cwd || previous.facts.git?.branch !== state.facts.git?.branch || previous.facts.git?.head !== state.facts.git?.head;
		const changed = previous === void 0 || previous.fingerprint !== state.fingerprint;
		const pending = (previous?.pending ?? false) || changed && !major;
		const sincePush = now - (previous?.pushedAt ?? 0);
		const changeReady = (changed || (previous?.pending ?? false)) && sincePush >= CHANGE_COOLDOWN_MS;
		const heartbeat = previous === void 0 || sincePush >= entry.reminderMinutes * 6e4;
		const shouldPush = major || changeReady || heartbeat;
		states.set(String(payload.agent.session.id), {
			...state,
			pending: pending && !shouldPush
		});
		if (!shouldPush) return decision;
		const text = formatRuntimeAudit(state.facts, {
			previous: previous?.facts ?? null,
			now: new Date(now),
			turn: payload?.turn,
			step: payload?.step,
			staleMinutes: entry.staleMinutes
		});
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
			pending: false
		});
		return {
			...decision,
			messages: [...decision.messages, message]
		};
	}, { prepend: true });
}

//#endregion
export { Config, apply, collectRuntimeFacts, describeRuntimeChanges, formatRuntimeAudit, inject, name, runtimeFingerprint, runtimePolicy };