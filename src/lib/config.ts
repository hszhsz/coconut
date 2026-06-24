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
    sandbox: {
      kind: sb.kind ?? DEFAULTS.sandbox.kind,
      workspace: path.resolve(sb.workspace ?? cwd),
      image: sb.image ?? DEFAULTS.sandbox.image,
      network: sb.network ?? DEFAULTS.sandbox.network,
    },
    source: { paths: loaded },
  };

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
  sandbox: {
    kind: "local",
    workspace: null,
    image: "node:22-slim",
    network: "bridge",
  },
};
