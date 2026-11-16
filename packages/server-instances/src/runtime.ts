import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TerminalLine {
  /** Monotonic counter used as a cursor by the web console. */
  seq: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: string;
}

type Listener = (line: TerminalLine) => void;

/**
 * One supervised process behind an instance: start, stop, restart-on-demand and a
 * bounded line buffer that the terminal endpoint tails. Instance types decide *what*
 * runs; this class only owns the process and its console.
 */
export class InstanceRuntime {
  readonly buffer: TerminalLine[] = [];
  private child?: ChildProcess;
  private seq = 0;
  private listeners = new Set<Listener>();
  private stopping = false;

  constructor(
    readonly instanceId: string,
    readonly cwd: string,
    readonly bufferLimit = 500,
  ) {}

  get running() { return Boolean(this.child && this.child.exitCode === null); }

  /** Append a line from outside the process, such as an install step of the instance type. */
  pushLine(stream: TerminalLine["stream"], text: string) { this.push(stream, text); }

  private push(stream: TerminalLine["stream"], text: string) {
    for (const raw of text.split(/\r?\n/)) {
      const trimmed = raw.replace(/\u0000/g, "");
      if (!trimmed.trim()) continue;
      const line: TerminalLine = { seq: ++this.seq, stream, text: trimmed.slice(0, 4000), at: new Date().toISOString() };
      this.buffer.push(line);
      if (this.buffer.length > this.bufferLimit) this.buffer.splice(0, this.buffer.length - this.bufferLimit);
      for (const listener of this.listeners) listener(line);
    }
  }

  private attach(child: ChildProcess) {
    child.stdout?.on("data", (chunk: Buffer) => this.push("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => this.push("stderr", chunk.toString("utf8")));
    child.on("error", (error) => this.push("system", `process error: ${error.message}`));
    child.on("exit", (code, signal) => {
      this.push("system", `process exited (code=${code ?? "null"}, signal=${signal ?? "none"})`);
      if (!this.stopping && code !== 0) this.push("system", "instance stopped unexpectedly");
      this.child = undefined;
    });
  }

  /** Run a command attached to the console until it finishes. */
  async run(command: string[], options: { input?: string; timeoutMs?: number; cwd?: string } = {}) {
    this.push("system", `$ ${command.join(" ")}`);
    const child = spawn(command[0], command.slice(1), { cwd: options.cwd ?? this.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    this.attach(child);
    if (options.input !== undefined) { child.stdin?.write(options.input); child.stdin?.end(); }
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : undefined;
    return new Promise<number>((resolve) => { child.on("exit", (code) => { if (timer) clearTimeout(timer); resolve(code ?? 1); }); });
  }

  /** Detached command whose output is captured when it finishes. */
  capture(command: string[], cwd = this.cwd) {
    const result = spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8", timeout: 60_000 });
    if (result.stderr?.trim()) this.push("stderr", result.stderr);
    if (result.stdout?.trim()) this.push("stdout", result.stdout);
    return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  /** Start a long-running server process. */
  start(command: string[], cwd = this.cwd) {
    if (this.running) throw new Error("instance already running");
    this.stopping = false;
    this.push("system", `starting: ${command.join(" ")}`);
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "xterm-256color" } });
    this.child = child;
    this.attach(child);
    return child;
  }

  /** Send text to the process standard input (console command). */
  write(text: string) {
    if (!this.child?.stdin) throw new Error("instance is not running");
    this.push("system", `> ${text}`);
    this.child.stdin.write(`${text}\n`);
  }

  /** Gracefully stop the process, escalating to SIGKILL after the grace period. */
  stop(graceMs = 10_000) {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.push("system", "stopping instance");
    child.kill("SIGTERM");
    setTimeout(() => { if (this.child === child) { this.push("system", "killing instance after grace period"); child.kill("SIGKILL"); } }, graceMs).unref?.();
  }

  tail(after = 0): TerminalLine[] {
    return this.buffer.filter((line) => line.seq > after);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose() { this.stop(1000); }
}

/** Directory layout for every instance: data/<instanceId>/{server,snapshots,config}. */
export function instanceDirectories(root: string, instanceId: string) {
  const base = path.join(root, instanceId);
  return { base, server: path.join(base, "server"), snapshots: path.join(base, "snapshots"), config: path.join(base, "config") };
}

export function ensureDirectory(directory: string) {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
}

export function removeDirectory(directory: string) {
  rmSync(directory, { recursive: true, force: true });
}

/** Resolve a path inside `root`, refusing anything that escapes it. */
export function safePath(root: string, relative: string) {
  const resolved = path.resolve(root, relative.replace(/^\/+/, ""));
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : undefined;
}

/** File size, or 0 when the path does not exist. */
export function fileSize(file: string) {
  try { return statSync(file).size; } catch { return 0; }
}

/** Shallow listing of a directory, largest files first. */
export function listFiles(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory(), size: entry.isDirectory() ? 0 : fileSize(path.join(directory, entry.name)) }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || b.size - a.size);
}

export { readFileSync, writeFileSync, existsSync, mkdirSync, statSync };
