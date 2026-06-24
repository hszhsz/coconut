import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface ExecResult {
  exitCode: number;
  output: string;
  truncated: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  stdin?: string;
  maxOutputBytes?: number;
}

export interface Sandbox {
  readonly kind: "local" | "docker";
  readonly workspace: string;
  readonly label: string;
  init(onLog?: (msg: string) => void): Promise<void>;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  readDir(relPath: string): Promise<string[]>;
  dispose(): Promise<void>;
}

function resolveInWorkspace(workspace: string, rel: string): string {
  const wsResolved = path.resolve(workspace);
  // Allow both absolute and relative; resolve relative to workspace
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(wsResolved, rel);
  if (abs !== wsResolved && !abs.startsWith(wsResolved + path.sep)) {
    throw new Error(
      `Path "${rel}" is outside the workspace (${wsResolved}). The agent can only operate inside the sandbox.`,
    );
  }
  return abs;
}

function relativeToWorkspace(workspace: string, rel: string): string {
  const abs = resolveInWorkspace(workspace, rel);
  const r = path.relative(path.resolve(workspace), abs);
  return r === "" ? "." : r;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Tracks active docker containers for synchronous cleanup on hard exit.
const activeDockerContainers = new Set<string>();
let exitHandlerInstalled = false;

function installDockerExitCleanup() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  // Synchronous cleanup on `process.exit` — best effort.
  process.on("exit", () => {
    for (const name of activeDockerContainers) {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    }
  });
}

export class LocalSandbox implements Sandbox {
  readonly kind = "local" as const;
  readonly label: string;

  constructor(public readonly workspace: string) {
    this.label = "local (host)";
  }

  async init() {
    await fs.mkdir(this.workspace, { recursive: true });
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const { timeoutMs = 30_000, stdin, maxOutputBytes = 8192 } = opts;
    return new Promise<ExecResult>((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: this.workspace,
        env: process.env,
      });
      let out = "";
      let truncated = false;
      const append = (chunk: string) => {
        if (out.length >= maxOutputBytes) {
          truncated = true;
          return;
        }
        const room = maxOutputBytes - out.length;
        if (chunk.length > room) {
          out += chunk.slice(0, room);
          truncated = true;
        } else {
          out += chunk;
        }
      };
      child.stdout.on("data", (d) => append(d.toString()));
      child.stderr.on("data", (d) => append(d.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, output: out, truncated });
      });
      if (stdin !== undefined) {
        child.stdin.write(stdin);
      }
      child.stdin.end();
    });
  }

  async readFile(relPath: string): Promise<string> {
    const abs = resolveInWorkspace(this.workspace, relPath);
    return fs.readFile(abs, "utf-8");
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = resolveInWorkspace(this.workspace, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  }

  async readDir(relPath: string): Promise<string[]> {
    const abs = resolveInWorkspace(this.workspace, relPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  }

  async dispose() {}
}

export interface DockerSandboxOptions {
  image?: string;
  network?: "bridge" | "none";
}

export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly label: string;
  private containerName: string;
  private started = false;
  private network: "bridge" | "none";
  private image: string;

  constructor(
    public readonly workspace: string,
    opts: DockerSandboxOptions = {},
  ) {
    this.containerName = `coconut-sb-${randomBytes(4).toString("hex")}`;
    this.network = opts.network ?? "bridge";
    this.image = opts.image ?? "node:22-slim";
    this.label = `docker (${this.image}${this.network === "none" ? ", offline" : ""})`;
  }

  private runDocker(args: string[], stdin?: string): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("docker", args);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => reject(e));
      child.on("close", (code) => {
        resolve({
          exitCode: code ?? -1,
          output: out + (err ? (out ? "\n" : "") + err : ""),
          truncated: false,
        });
      });
      if (stdin !== undefined) {
        child.stdin.write(stdin);
      }
      child.stdin.end();
    });
  }

  async init(onLog?: (m: string) => void) {
    // Verify docker is available
    try {
      const v = await this.runDocker([
        "version",
        "--format",
        "{{.Server.Version}}",
      ]);
      if (v.exitCode !== 0) {
        throw new Error(
          `Docker daemon not reachable. ${v.output.slice(0, 200).trim()}`,
        );
      }
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        throw new Error(
          `\`docker\` command not found. Install Docker Desktop (or Colima/Lima) and try again.`,
        );
      }
      throw new Error(`Failed to talk to docker: ${e?.message ?? e}`);
    }

    onLog?.(`Starting Docker sandbox (${this.image})...`);

    installDockerExitCleanup();

    const runArgs = [
      "run",
      "-d",
      "--rm",
      "--name",
      this.containerName,
      "-v",
      `${path.resolve(this.workspace)}:/workspace`,
      "-w",
      "/workspace",
      "--network",
      this.network,
      this.image,
      "sleep",
      "infinity",
    ];
    const r = await this.runDocker(runArgs);
    if (r.exitCode !== 0) {
      throw new Error(
        `Failed to start sandbox container:\n${r.output.trim()}`,
      );
    }
    this.started = true;
    activeDockerContainers.add(this.containerName);
    onLog?.(`Sandbox ready: ${this.containerName}`);
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const { timeoutMs = 30_000, stdin, maxOutputBytes = 8192 } = opts;
    if (!this.started) throw new Error("Sandbox not initialized");

    return new Promise<ExecResult>((resolve) => {
      const args = ["exec", "-i", this.containerName, "sh", "-c", command];
      const child = spawn("docker", args);
      let out = "";
      let truncated = false;
      const append = (chunk: string) => {
        if (out.length >= maxOutputBytes) {
          truncated = true;
          return;
        }
        const room = maxOutputBytes - out.length;
        if (chunk.length > room) {
          out += chunk.slice(0, room);
          truncated = true;
        } else {
          out += chunk;
        }
      };
      child.stdout.on("data", (d) => append(d.toString()));
      child.stderr.on("data", (d) => append(d.toString()));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the local docker-exec; the actual process inside the container
        // may also need a nudge.
        child.kill("SIGKILL");
        spawn("docker", ["kill", "--signal=SIGKILL", this.containerName]).on(
          "close",
          () => {},
        );
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          append(`\n[command timed out after ${timeoutMs}ms]`);
        }
        resolve({ exitCode: code ?? -1, output: out, truncated });
      });
      if (stdin !== undefined) {
        child.stdin.write(stdin);
      }
      child.stdin.end();
    });
  }

  async readFile(relPath: string): Promise<string> {
    const rel = relativeToWorkspace(this.workspace, relPath);
    const cmd = `cat ${shellQuote(rel)}`;
    const r = await this.exec(cmd, { maxOutputBytes: 1024 * 1024 });
    if (r.exitCode !== 0) {
      throw new Error(r.output.trim() || `read_file failed (exit ${r.exitCode})`);
    }
    return r.output;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const rel = relativeToWorkspace(this.workspace, relPath);
    const dir = path.posix.dirname(rel);
    if (dir && dir !== "." && dir !== "/") {
      const mkdirRes = await this.exec(`mkdir -p ${shellQuote(dir)}`);
      if (mkdirRes.exitCode !== 0) {
        throw new Error(`mkdir failed: ${mkdirRes.output.trim()}`);
      }
    }
    const r = await this.exec(`cat > ${shellQuote(rel)}`, { stdin: content });
    if (r.exitCode !== 0) {
      throw new Error(r.output.trim() || `write_file failed (exit ${r.exitCode})`);
    }
  }

  async readDir(relPath: string): Promise<string[]> {
    const rel = relativeToWorkspace(this.workspace, relPath || ".");
    const r = await this.exec(`ls -1Ap ${shellQuote(rel)}`, {
      maxOutputBytes: 64 * 1024,
    });
    if (r.exitCode !== 0) {
      throw new Error(r.output.trim() || `list_files failed`);
    }
    return r.output
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l && !l.startsWith(".") && l !== "node_modules/" && l !== "node_modules",
      )
      .sort();
  }

  async dispose() {
    if (!this.started) return;
    this.started = false;
    activeDockerContainers.delete(this.containerName);
    try {
      await this.runDocker(["rm", "-f", this.containerName]);
    } catch {
      /* best effort */
    }
  }
}

export interface SandboxConfig {
  kind: "local" | "docker";
  workspace: string;
  image?: string;
  network?: "bridge" | "none";
}

export function createSandbox(cfg: SandboxConfig): Sandbox {
  if (cfg.kind === "docker") {
    return new DockerSandbox(cfg.workspace, {
      image: cfg.image,
      network: cfg.network,
    });
  }
  return new LocalSandbox(cfg.workspace);
}
