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
//#region src/index.d.ts
declare const name = "runtime-env-watch";
declare const inject: string[];
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  probeSeconds: z<number, number, "defined">;
  reminderMinutes: z<number, number, "defined">;
  staleMinutes: z<number, number, "defined">;
  watchFiles: z<string[], string[], "defined">;
  sectionOrder: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  probeSeconds: z<number, number, "defined">;
  reminderMinutes: z<number, number, "defined">;
  staleMinutes: z<number, number, "defined">;
  watchFiles: z<string[], string[], "defined">;
  sectionOrder: z<number, number, "defined">;
}>>, "plain">;
type Config = ReturnType<typeof Config>;
declare function apply(ctx: Context, entry: Config): void;
//#endregion
export { Config, type RuntimeFacts, apply, collectRuntimeFacts, describeRuntimeChanges, formatRuntimeAudit, inject, name, runtimeFingerprint, runtimePolicy };