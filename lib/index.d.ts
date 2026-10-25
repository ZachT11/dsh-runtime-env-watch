import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/dsh-subprocess";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-working-directory";
import { Context } from "@deepseek-ai/cordis";

//#region src/runtime.d.ts
type CommandRunner = (argv: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<string | null>;
interface RuntimeFile {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
}
interface RuntimeGit {
  branch: string;
  head: string;
  dirty: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  status: 'ok' | 'timeout' | 'unavailable';
}
interface RuntimeFacts {
  cwd: string;
  platform: string;
  release: string;
  arch: string;
  shell: string;
  node: string;
  gitVersion: string | null;
  pnpm: string | null;
  git: RuntimeGit | null;
  files: RuntimeFile[];
  collectedAt: string;
}
interface RuntimeOptions {
  watchFiles: string[];
  run: CommandRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}
declare function collectRuntimeFacts(cwd: string, options: RuntimeOptions): Promise<RuntimeFacts>;
declare function runtimeFingerprint(facts: RuntimeFacts): string;
declare function describeRuntimeChanges(previous: RuntimeFacts | null, current: RuntimeFacts): string[];
interface AuditOptions {
  previous?: RuntimeFacts | null;
  now?: Date;
  turn?: number;
  step?: number;
  staleMinutes?: number;
}
declare function formatRuntimeAudit(facts: RuntimeFacts, options?: AuditOptions): string;
declare function runtimePolicy(): string;
//#endregion
//#region src/checks.d.ts
type CheckKind = 'hardware' | 'http' | 'command' | 'tcp' | 'file';
type HardwareMetric = 'cpu' | 'memory' | 'disk' | 'uptime' | 'battery' | 'gpu' | 'processes' | 'ports' | 'temperature';
interface CheckExpectation {
  min?: number;
  max?: number;
  equals?: unknown;
  contains?: string;
  exists?: boolean;
}
interface CheckDefinition {
  id: string;
  kind: CheckKind;
  enabled?: boolean;
  intervalSeconds?: number;
  timeoutMs?: number;
  metrics?: HardwareMetric[];
  diskPaths?: string[];
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  fields?: Record<string, string>;
  expect?: Record<string, CheckExpectation>;
  command?: string[];
  cwd?: string;
  json?: boolean;
  host?: string;
  port?: number;
  path?: string;
  minSize?: number;
  maxAgeSeconds?: number;
  exists?: boolean;
}
interface CheckConfigFile {
  checks?: CheckDefinition[];
  intervalSeconds?: number;
}
interface CheckState {
  id: string;
  kind: CheckKind;
  at: number;
  ok: boolean;
  data: Record<string, any>;
  error?: string;
  durationMs: number;
  fingerprint: string;
  alerts: string[];
}
interface CheckContext {
  cwd: string;
  run: CommandRunner;
  signal?: AbortSignal;
  timeoutMs: number;
}
declare function getPath(value: unknown, path: string): any;
declare function runCheck(def: CheckDefinition, ctx: CheckContext): Promise<CheckState>;
declare function formatCheckState(state: CheckState, now?: number, staleMinutes?: number): string;
declare function formatStatusReport(states: CheckState[], options?: {
  now?: Date;
  staleMinutes?: number;
  intervalSeconds?: number;
  configError?: string;
}): string;
declare function statusFingerprint(states: CheckState[]): string;
declare function hasStatusAlerts(states: CheckState[]): boolean;
declare function normaliseCheck(raw: any, index: number, defaultInterval: number): CheckDefinition | null;
declare function parseChecksFile(text: string, defaultInterval: number): {
  checks: CheckDefinition[];
  error?: string;
};
declare function defaultChecks(intervalSeconds: number): CheckDefinition[];
interface CheckSchedulerOptions {
  baseDir: string;
  configPath: string;
  defaultIntervalSeconds: number;
  run: CommandRunner;
  enabled?: () => boolean;
  logger?: (message: string) => void;
}
declare class CheckScheduler {
  readonly states: Map<string, CheckState>;
  definitions: CheckDefinition[];
  private nextAt;
  private timer;
  private ticking;
  private lastMtime;
  private lastReloadCheck;
  private configError;
  private readonly options;
  private readonly absolutePath;
  private initPromise;
  constructor(options: CheckSchedulerOptions);
  get path(): string;
  init(): Promise<void>;
  /** Load the config and run the first round exactly once. */
  ensure(): Promise<void>;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  private reloadIfChanged;
  reload(force: boolean): Promise<void>;
  private intervalOf;
  runDue(force: boolean): Promise<CheckState[]>;
  runAll(force?: boolean): Promise<CheckState[]>;
  runOne(id: string, force?: boolean): Promise<CheckState | undefined>;
  list(): CheckDefinition[];
  snapshot(): CheckState[];
  fingerprint(): string;
  hasAlerts(): boolean;
  format(now?: Date, staleMinutes?: number): string;
}
//#endregion
//#region src/index.d.ts
declare const name = "runtime-env-watch";
declare const inject: string[];
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  probeSeconds: z<number, number, "defined">;
  statusIntervalSeconds: z<number, number, "defined">;
  reminderMinutes: z<number, number, "defined">;
  staleMinutes: z<number, number, "defined">;
  watchFiles: z<string[], string[], "defined">;
  checksFile: z<string, string, "defined">;
  sectionOrder: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  probeSeconds: z<number, number, "defined">;
  statusIntervalSeconds: z<number, number, "defined">;
  reminderMinutes: z<number, number, "defined">;
  staleMinutes: z<number, number, "defined">;
  watchFiles: z<string[], string[], "defined">;
  checksFile: z<string, string, "defined">;
  sectionOrder: z<number, number, "defined">;
}>>, "plain">;
type Config = ReturnType<typeof Config>;
declare function apply(ctx: Context, entry: Config): void;
//#endregion
export { CheckConfigFile, CheckContext, CheckDefinition, CheckExpectation, CheckKind, CheckScheduler, CheckSchedulerOptions, CheckState, Config, HardwareMetric, type RuntimeFacts, apply, collectRuntimeFacts, defaultChecks, describeRuntimeChanges, formatCheckState, formatRuntimeAudit, formatStatusReport, getPath, hasStatusAlerts, inject, name, normaliseCheck, parseChecksFile, runCheck, runtimeFingerprint, runtimePolicy, statusFingerprint };