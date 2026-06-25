import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

const SandboxSchema = z
  .object({
    kind: z.enum(["local", "docker"]).optional(),
    workspace: z.string().nullable().optional(),
    image: z.string().optional(),
    network: z.enum(["bridge", "none"]).optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    model: z.string().optional(),
    baseURL: z.string().optional(),
    apiKey: z.string().nullable().optional(),
    system: z.string().nullable().optional(),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxIterations: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
    compressionThreshold: z.number().min(0.1).max(0.95).optional(),
    keepRecentTurns: z.number().int().min(1).max(50).optional(),
    toolOutputExternalizeMinChars: z.number().int().positive().optional(),
    toolOutputPreviewHeadChars: z.number().int().min(0).optional(),
    toolOutputPreviewTailChars: z.number().int().min(0).optional(),
    toolOutputDir: z.string().min(1).optional(),
    toolOutputRetentionMaxFiles: z.number().int().min(0).optional(),
    toolOutputRetentionMaxBytes: z.number().int().min(0).optional(),
    tokenBudgetMax: z.number().int().positive().optional(),
    tokenBudgetWarnRatio: z.number().min(0.1).max(0.99).optional(),
    tokenBudgetHardRatio: z.number().min(0.1).max(1).optional(),
    memoryInjectionMaxTokens: z.number().int().min(0).optional(),
    memoryDir: z.string().min(1).optional(),
    memoryInjectionGuaranteedCorrectionTokens: z.number().int().min(0).optional(),
    dynamicContextEnabled: z.boolean().optional(),
    dynamicContextIncludeDate: z.boolean().optional(),
    sandbox: SandboxSchema.optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigSchema>;

export interface ResolvedConfig {
  model: string;
  baseURL: string;
  apiKey: string | null;
  system: string | null;
  maxTokens: number;
  temperature: number;
  maxIterations: number;
  contextWindow: number;
  compressionThreshold: number;
  keepRecentTurns: number;
  toolOutputExternalizeMinChars: number;
  toolOutputPreviewHeadChars: number;
  toolOutputPreviewTailChars: number;
  toolOutputDir: string;
  toolOutputRetentionMaxFiles: number;
  toolOutputRetentionMaxBytes: number;
  tokenBudgetMax: number;
  tokenBudgetWarnRatio: number;
  tokenBudgetHardRatio: number;
  memoryInjectionMaxTokens: number;
  memoryDir: string;
  memoryInjectionGuaranteedCorrectionTokens: number;
  dynamicContextEnabled: boolean;
  dynamicContextIncludeDate: boolean;
  sandbox: {
    kind: "local" | "docker";
    workspace: string;
    image: string;
    network: "bridge" | "none";
  };
  source: {
    paths: string[];
  };
}

const DEFAULTS: Omit<ResolvedConfig, "source"> = {
  model: "deepseek-v4-pro",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: null,
  system: null,
  maxTokens: 4096,
  temperature: 0.3,
  maxIterations: 15,
  contextWindow: 64_000,
  compressionThreshold: 0.7,
  keepRecentTurns: 4,
  toolOutputExternalizeMinChars: 12_000,
  toolOutputPreviewHeadChars: 2_000,
  toolOutputPreviewTailChars: 1_000,
  toolOutputDir: ".coconut/tool-results",
  toolOutputRetentionMaxFiles: 200,
  toolOutputRetentionMaxBytes: 52_428_800,
  tokenBudgetMax: 200_000,
  tokenBudgetWarnRatio: 0.8,
  tokenBudgetHardRatio: 1.0,
  memoryInjectionMaxTokens: 2_000,
  memoryDir: ".coconut/memory",
  memoryInjectionGuaranteedCorrectionTokens: 500,
  dynamicContextEnabled: true,
  dynamicContextIncludeDate: true,
  sandbox: {
    kind: "local",
    workspace: process.cwd(),
    image: "node:22-slim",
    network: "bridge",
  },
};

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

export function defaultConfigPaths(workspace: string): string[] {
  const out: string[] = [];
  // 1. User-global config
  out.push(path.join(xdgConfigHome(), "coconut", "config.json"));
  // 2. Project-local config (in workspace)
  out.push(path.join(workspace, ".coconut.json"));
  // 3. Explicit override
  if (process.env.COCONUT_CONFIG) {
    out.push(path.resolve(process.env.COCONUT_CONFIG));
  }
  return out;
}

async function readJsonIfExists(p: string): Promise<unknown | null> {
  try {
    const text = await fs.readFile(p, "utf-8");
    return JSON.parse(text);
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    if (e instanceof SyntaxError) {
      throw new Error(`Config file ${p} is not valid JSON: ${e.message}`);
    }
    throw new Error(`Failed to read config ${p}: ${e?.message ?? e}`);
  }
}

function parseStrict(raw: unknown, source: string): ConfigFile {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  · ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Config file ${source} is invalid:\n${issues}`);
  }
  return result.data;
}

function envOverrides(): ConfigFile {
  const out: ConfigFile = {};
  if (process.env.COCONUT_MODEL) out.model = process.env.COCONUT_MODEL;
  if (process.env.COCONUT_BASE_URL || process.env.DEEPSEEK_BASE_URL) {
    out.baseURL =
      process.env.COCONUT_BASE_URL || process.env.DEEPSEEK_BASE_URL!;
  }
  if (process.env.COCONUT_API_KEY || process.env.DEEPSEEK_API_KEY) {
    out.apiKey =
      process.env.COCONUT_API_KEY || process.env.DEEPSEEK_API_KEY!;
  }
  if (process.env.COCONUT_SYSTEM) out.system = process.env.COCONUT_SYSTEM;
  if (process.env.COCONUT_MAX_TOKENS) {
    const n = Number(process.env.COCONUT_MAX_TOKENS);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error("COCONUT_MAX_TOKENS must be a positive number");
    out.maxTokens = n;
  }
  if (process.env.COCONUT_TEMPERATURE) {
    const n = Number(process.env.COCONUT_TEMPERATURE);
    if (!Number.isFinite(n) || n < 0 || n > 2)
      throw new Error("COCONUT_TEMPERATURE must be between 0 and 2");
    out.temperature = n;
  }
  if (process.env.COCONUT_CONTEXT_WINDOW) {
    const n = Number(process.env.COCONUT_CONTEXT_WINDOW);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error("COCONUT_CONTEXT_WINDOW must be a positive number");
    out.contextWindow = n;
  }
  if (process.env.COCONUT_COMPRESSION_THRESHOLD) {
    const n = Number(process.env.COCONUT_COMPRESSION_THRESHOLD);
    if (!Number.isFinite(n) || n < 0.1 || n > 0.95)
      throw new Error(
        "COCONUT_COMPRESSION_THRESHOLD must be between 0.1 and 0.95",
      );
    out.compressionThreshold = n;
  }
  if (process.env.COCONUT_KEEP_RECENT_TURNS) {
    const n = Number(process.env.COCONUT_KEEP_RECENT_TURNS);
    if (!Number.isInteger(n) || n < 1 || n > 50)
      throw new Error("COCONUT_KEEP_RECENT_TURNS must be an integer 1..50");
    out.keepRecentTurns = n;
  }
  if (process.env.COCONUT_TOOL_OUTPUT_EXTERNALIZE_MIN_CHARS) {
    const n = Number(process.env.COCONUT_TOOL_OUTPUT_EXTERNALIZE_MIN_CHARS);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(
        "COCONUT_TOOL_OUTPUT_EXTERNALIZE_MIN_CHARS must be a positive integer",
      );
    out.toolOutputExternalizeMinChars = n;
  }
  if (process.env.COCONUT_TOOL_OUTPUT_PREVIEW_HEAD_CHARS) {
    const n = Number(process.env.COCONUT_TOOL_OUTPUT_PREVIEW_HEAD_CHARS);
    if (!Number.isInteger(n) || n < 0)
      throw new Error(
        "COCONUT_TOOL_OUTPUT_PREVIEW_HEAD_CHARS must be a non-negative integer",
      );
    out.toolOutputPreviewHeadChars = n;
  }
  if (process.env.COCONUT_TOOL_OUTPUT_PREVIEW_TAIL_CHARS) {
    const n = Number(process.env.COCONUT_TOOL_OUTPUT_PREVIEW_TAIL_CHARS);
    if (!Number.isInteger(n) || n < 0)
      throw new Error(
        "COCONUT_TOOL_OUTPUT_PREVIEW_TAIL_CHARS must be a non-negative integer",
      );
    out.toolOutputPreviewTailChars = n;
  }
  if (process.env.COCONUT_TOOL_OUTPUT_DIR) {
    out.toolOutputDir = process.env.COCONUT_TOOL_OUTPUT_DIR;
  }
  if (process.env.COCONUT_TOOL_OUTPUT_RETENTION_MAX_FILES) {
    const n = Number(process.env.COCONUT_TOOL_OUTPUT_RETENTION_MAX_FILES);
    if (!Number.isInteger(n) || n < 0)
      throw new Error(
        "COCONUT_TOOL_OUTPUT_RETENTION_MAX_FILES must be a non-negative integer",
      );
    out.toolOutputRetentionMaxFiles = n;
  }
  if (process.env.COCONUT_TOOL_OUTPUT_RETENTION_MAX_BYTES) {
    const n = Number(process.env.COCONUT_TOOL_OUTPUT_RETENTION_MAX_BYTES);
    if (!Number.isInteger(n) || n < 0)
      throw new Error(
        "COCONUT_TOOL_OUTPUT_RETENTION_MAX_BYTES must be a non-negative integer",
      );
    out.toolOutputRetentionMaxBytes = n;
  }
  if (process.env.COCONUT_TOKEN_BUDGET_MAX) {
    const n = Number(process.env.COCONUT_TOKEN_BUDGET_MAX);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error("COCONUT_TOKEN_BUDGET_MAX must be a positive integer");
    out.tokenBudgetMax = n;
  }
  if (process.env.COCONUT_TOKEN_BUDGET_WARN_RATIO) {
    const n = Number(process.env.COCONUT_TOKEN_BUDGET_WARN_RATIO);
    if (!Number.isFinite(n) || n < 0.1 || n > 0.99)
      throw new Error(
        "COCONUT_TOKEN_BUDGET_WARN_RATIO must be between 0.1 and 0.99",
      );
    out.tokenBudgetWarnRatio = n;
  }
  if (process.env.COCONUT_TOKEN_BUDGET_HARD_RATIO) {
    const n = Number(process.env.COCONUT_TOKEN_BUDGET_HARD_RATIO);
    if (!Number.isFinite(n) || n < 0.1 || n > 1)
      throw new Error(
        "COCONUT_TOKEN_BUDGET_HARD_RATIO must be between 0.1 and 1",
      );
    out.tokenBudgetHardRatio = n;
  }
  if (process.env.COCONUT_MEMORY_INJECTION_MAX_TOKENS) {
    const n = Number(process.env.COCONUT_MEMORY_INJECTION_MAX_TOKENS);
    if (!Number.isInteger(n) || n < 0)
      throw new Error(
        "COCONUT_MEMORY_INJECTION_MAX_TOKENS must be a non-negative integer",
      );
    out.memoryInjectionMaxTokens = n;
  }
  if (process.env.COCONUT_MEMORY_DIR) {
    out.memoryDir = process.env.COCONUT_MEMORY_DIR;
  }
  if (process.env.COCONUT_MEMORY_INJECTION_GUARANTEED_CORRECTION_TOKENS) {
    const n = Number(
      process.env.COCONUT_MEMORY_INJECTION_GUARANTEED_CORRECTION_TOKENS,
    );
    if (!Number.isInteger(n) || n < 0)
      throw new Error(
        "COCONUT_MEMORY_INJECTION_GUARANTEED_CORRECTION_TOKENS must be a non-negative integer",
      );
    out.memoryInjectionGuaranteedCorrectionTokens = n;
  }
  if (process.env.COCONUT_DYNAMIC_CONTEXT_ENABLED) {
    out.dynamicContextEnabled = process.env.COCONUT_DYNAMIC_CONTEXT_ENABLED !== "false";
  }
  if (process.env.COCONUT_DYNAMIC_CONTEXT_INCLUDE_DATE) {
    out.dynamicContextIncludeDate =
      process.env.COCONUT_DYNAMIC_CONTEXT_INCLUDE_DATE !== "false";
  }

  const sb: NonNullable<ConfigFile["sandbox"]> = {};
  let sbTouched = false;
  if (process.env.COCONUT_SANDBOX) {
    const v = process.env.COCONUT_SANDBOX.toLowerCase();
    if (v !== "local" && v !== "docker") {
      throw new Error(
        `COCONUT_SANDBOX must be "local" or "docker" (got: "${process.env.COCONUT_SANDBOX}")`,
      );
    }
    sb.kind = v;
    sbTouched = true;
  }
  if (process.env.COCONUT_WORKSPACE) {
    sb.workspace = process.env.COCONUT_WORKSPACE;
    sbTouched = true;
  }
  if (process.env.COCONUT_SANDBOX_IMAGE) {
    sb.image = process.env.COCONUT_SANDBOX_IMAGE;
    sbTouched = true;
  }
  if (process.env.COCONUT_SANDBOX_NETWORK) {
    const v = process.env.COCONUT_SANDBOX_NETWORK.toLowerCase();
    if (v !== "bridge" && v !== "none") {
      throw new Error(
        `COCONUT_SANDBOX_NETWORK must be "bridge" or "none" (got: "${process.env.COCONUT_SANDBOX_NETWORK}")`,
      );
    }
    sb.network = v;
    sbTouched = true;
  }
  if (sbTouched) out.sandbox = sb;
  return out;
}

function mergeLayer(base: ConfigFile, layer: ConfigFile): ConfigFile {
  return {
    ...base,
    ...layer,
    sandbox: {
      ...(base.sandbox ?? {}),
      ...(layer.sandbox ?? {}),
    },
  };
}

export async function loadConfig(opts?: {
  cwd?: string;
}): Promise<ResolvedConfig> {
  const cwd = opts?.cwd ?? process.cwd();
  const paths = defaultConfigPaths(cwd);
  const loaded: string[] = [];

  let merged: ConfigFile = {};
  for (const p of paths) {
    const raw = await readJsonIfExists(p);
    if (raw === null) continue;
    const parsed = parseStrict(raw, p);
    merged = mergeLayer(merged, parsed);
    loaded.push(p);
  }
  // Env vars win
  merged = mergeLayer(merged, envOverrides());

  // Resolve against defaults
  const sb = merged.sandbox ?? {};
  const resolved: ResolvedConfig = {
    model: merged.model ?? DEFAULTS.model,
    baseURL: (merged.baseURL ?? DEFAULTS.baseURL).replace(/\/+$/, ""),
    apiKey: merged.apiKey ?? DEFAULTS.apiKey,
    system: merged.system ?? DEFAULTS.system,
    maxTokens: merged.maxTokens ?? DEFAULTS.maxTokens,
    temperature: merged.temperature ?? DEFAULTS.temperature,
    maxIterations: merged.maxIterations ?? DEFAULTS.maxIterations,
    contextWindow: merged.contextWindow ?? DEFAULTS.contextWindow,
    compressionThreshold:
      merged.compressionThreshold ?? DEFAULTS.compressionThreshold,
    keepRecentTurns: merged.keepRecentTurns ?? DEFAULTS.keepRecentTurns,
    toolOutputExternalizeMinChars:
      merged.toolOutputExternalizeMinChars ?? DEFAULTS.toolOutputExternalizeMinChars,
    toolOutputPreviewHeadChars:
      merged.toolOutputPreviewHeadChars ?? DEFAULTS.toolOutputPreviewHeadChars,
    toolOutputPreviewTailChars:
      merged.toolOutputPreviewTailChars ?? DEFAULTS.toolOutputPreviewTailChars,
    toolOutputDir: merged.toolOutputDir ?? DEFAULTS.toolOutputDir,
    toolOutputRetentionMaxFiles:
      merged.toolOutputRetentionMaxFiles ?? DEFAULTS.toolOutputRetentionMaxFiles,
    toolOutputRetentionMaxBytes:
      merged.toolOutputRetentionMaxBytes ?? DEFAULTS.toolOutputRetentionMaxBytes,
    tokenBudgetMax: merged.tokenBudgetMax ?? DEFAULTS.tokenBudgetMax,
    tokenBudgetWarnRatio:
      merged.tokenBudgetWarnRatio ?? DEFAULTS.tokenBudgetWarnRatio,
    tokenBudgetHardRatio:
      merged.tokenBudgetHardRatio ?? DEFAULTS.tokenBudgetHardRatio,
    memoryInjectionMaxTokens:
      merged.memoryInjectionMaxTokens ?? DEFAULTS.memoryInjectionMaxTokens,
    memoryDir: merged.memoryDir ?? DEFAULTS.memoryDir,
    memoryInjectionGuaranteedCorrectionTokens:
      merged.memoryInjectionGuaranteedCorrectionTokens ??
      DEFAULTS.memoryInjectionGuaranteedCorrectionTokens,
    dynamicContextEnabled:
      merged.dynamicContextEnabled ?? DEFAULTS.dynamicContextEnabled,
    dynamicContextIncludeDate:
      merged.dynamicContextIncludeDate ?? DEFAULTS.dynamicContextIncludeDate,
    sandbox: {
      kind: sb.kind ?? DEFAULTS.sandbox.kind,
      workspace: path.resolve(sb.workspace ?? cwd),
      image: sb.image ?? DEFAULTS.sandbox.image,
      network: sb.network ?? DEFAULTS.sandbox.network,
    },
    source: { paths: loaded },
  };

  if (resolved.tokenBudgetWarnRatio >= resolved.tokenBudgetHardRatio) {
    throw new Error("tokenBudgetWarnRatio must be less than tokenBudgetHardRatio");
  }

  return resolved;
}

/** Redact API key for display. */
export function describeConfig(cfg: ResolvedConfig): string {
  const redactedKey = cfg.apiKey
    ? cfg.apiKey.slice(0, 4) + "…" + cfg.apiKey.slice(-4)
    : "(not set)";
  const lines = [
    `model:         ${cfg.model}`,
    `baseURL:       ${cfg.baseURL}`,
    `apiKey:        ${redactedKey}`,
    `maxTokens:     ${cfg.maxTokens}`,
    `temperature:   ${cfg.temperature}`,
    `maxIterations: ${cfg.maxIterations}`,
    `contextWindow:        ${cfg.contextWindow}`,
    `compressionThreshold: ${cfg.compressionThreshold}`,
    `keepRecentTurns:      ${cfg.keepRecentTurns}`,
    `toolOutputExternalizeMinChars: ${cfg.toolOutputExternalizeMinChars}`,
    `toolOutputPreviewHeadChars:   ${cfg.toolOutputPreviewHeadChars}`,
    `toolOutputPreviewTailChars:   ${cfg.toolOutputPreviewTailChars}`,
    `toolOutputDir:                ${cfg.toolOutputDir}`,
    `toolOutputRetentionMaxFiles:  ${cfg.toolOutputRetentionMaxFiles}`,
    `toolOutputRetentionMaxBytes:  ${cfg.toolOutputRetentionMaxBytes}`,
    `tokenBudgetMax:               ${cfg.tokenBudgetMax}`,
    `tokenBudgetWarnRatio:         ${cfg.tokenBudgetWarnRatio}`,
    `tokenBudgetHardRatio:         ${cfg.tokenBudgetHardRatio}`,
    `memoryInjectionMaxTokens:     ${cfg.memoryInjectionMaxTokens}`,
    `memoryDir:                    ${cfg.memoryDir}`,
    `memoryInjectionGuaranteedCorrectionTokens: ${cfg.memoryInjectionGuaranteedCorrectionTokens}`,
    `dynamicContextEnabled:        ${cfg.dynamicContextEnabled}`,
    `dynamicContextIncludeDate:    ${cfg.dynamicContextIncludeDate}`,
    `sandbox.kind:  ${cfg.sandbox.kind}`,
    `sandbox.workspace: ${cfg.sandbox.workspace}`,
  ];
  if (cfg.sandbox.kind === "docker") {
    lines.push(`sandbox.image:   ${cfg.sandbox.image}`);
    lines.push(`sandbox.network: ${cfg.sandbox.network}`);
  }
  if (cfg.system) {
    const preview =
      cfg.system.length > 80 ? cfg.system.slice(0, 77) + "..." : cfg.system;
    lines.push(`system override: "${preview}"`);
  }
  if (cfg.source.paths.length > 0) {
    lines.push(``);
    lines.push(`loaded from:`);
    for (const p of cfg.source.paths) lines.push(`  · ${p}`);
  } else {
    lines.push(``);
    lines.push(`(no config file found — using defaults + env vars)`);
  }
  return lines.join("\n");
}

export const EXAMPLE_CONFIG: ConfigFile = {
  model: "deepseek-v4-pro",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: null,
  system: null,
  maxTokens: 4096,
  temperature: 0.3,
  maxIterations: 15,
  contextWindow: 64_000,
  compressionThreshold: 0.7,
  keepRecentTurns: 4,
  toolOutputExternalizeMinChars: 12_000,
  toolOutputPreviewHeadChars: 2_000,
  toolOutputPreviewTailChars: 1_000,
  toolOutputDir: ".coconut/tool-results",
  toolOutputRetentionMaxFiles: 200,
  toolOutputRetentionMaxBytes: 52_428_800,
  tokenBudgetMax: 200_000,
  tokenBudgetWarnRatio: 0.8,
  tokenBudgetHardRatio: 1.0,
  memoryInjectionMaxTokens: 2_000,
  memoryDir: ".coconut/memory",
  memoryInjectionGuaranteedCorrectionTokens: 500,
  dynamicContextEnabled: true,
  dynamicContextIncludeDate: true,
  sandbox: {
    kind: "local",
    workspace: null,
    image: "node:22-slim",
    network: "bridge",
  },
};
