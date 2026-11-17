import http from "node:http";

/**
 * Minimal Docker Engine API client over the unix socket. Keeping this small and
 * explicit means the panel has no native dependency and no CLI called with user input.
 */
export interface DockerContainerSpec {
  name: string;
  image: string;
  /** Overrides the image entrypoint when set. */
  command?: string[];
  env: Record<string, string>;
  /** hostPath:containerPath[:mode] */
  mounts: string[];
  ports: Array<{ host: number; container: number; protocol: "tcp" | "udp" }>;
  workdir?: string;
  cpu?: number;
  memoryMb?: number;
  pids?: number;
  restart?: "no" | "on-failure" | "always";
  labels?: Record<string, string>;
  tty?: boolean;
  openStdin?: boolean;
}

export interface DockerContainerState {
  id: string;
  name: string;
  status: string;
  running: boolean;
  exitCode: number;
  startedAt: string;
}

export interface DockerDriver {
  ping(): Promise<boolean>;
  pull(image: string): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  create(spec: DockerContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, signal?: string, timeoutSeconds?: number): Promise<void>;
  kill(id: string): Promise<void>;
  remove(id: string, options?: { force?: boolean; volumes?: boolean }): Promise<void>;
  inspect(id: string): Promise<DockerContainerState | undefined>;
  logs(id: string, tail?: number): Promise<string>;
  exec(id: string, command: string[], options?: { input?: string; tty?: boolean }): Promise<{ code: number; output: string }>;
  writeStdin(id: string, data: string): Promise<void>;
  /** Open a raw hijacked exec session for the interactive terminal. */
  attachExec(id: string, command: string[], onData: (chunk: string) => void): Promise<{ write(data: string): void; close(): void }>;
}

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

export class DockerSocketDriver implements DockerDriver {
  constructor(
    private readonly socketPath: string,
    private readonly options: { pullOnCreate: boolean; onLog?: (message: string) => void } = { pullOnCreate: true },
  ) {}

  private request<T = unknown>(options: RequestOptions): Promise<{ status: number; body: T; raw: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const request = http.request({
        socketPath: this.socketPath, path: options.path, method: options.method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        timeout: options.timeoutMs ?? 30_000,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks);
          let body: unknown = raw.toString("utf8");
          try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { /* keep text */ }
          resolve({ status: response.statusCode ?? 0, body: body as T, raw });
        });
      });
      request.on("timeout", () => request.destroy(new Error(`docker request timed out: ${options.method} ${options.path}`)));
      request.on("error", (error) => reject(new Error(`docker socket error: ${error.message}`)));
      if (payload) request.write(payload);
      request.end();
    });
  }

  async ping() {
    try { return (await this.request({ method: "GET", path: "/_ping", timeoutMs: 5000 })).status === 200; }
    catch { return false; }
  }

  async imageExists(image: string) {
    const response = await this.request({ method: "GET", path: `/images/${encodeURIComponent(image)}/json` });
    return response.status === 200;
  }

  /** Pull an image, streaming progress to the log so the panel shows it. */
  async pull(image: string) {
    const [repository, tag = "latest"] = image.includes("@") ? [image, ""] : image.split(":");
    const path = `/images/create?fromImage=${encodeURIComponent(repository)}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`;
    await new Promise<void>((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, path, method: "POST" }, (response) => {
        if ((response.statusCode ?? 0) >= 400) {
          let text = "";
          response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
          response.on("end", () => reject(new Error(`docker pull failed: ${text.slice(0, 300)}`)));
          return;
        }
        response.on("data", (chunk: Buffer) => {
          const line = chunk.toString("utf8").trim().split("\n").pop() ?? "";
          try { const parsed = JSON.parse(line) as { status?: string; error?: string }; if (parsed.error) reject(new Error(parsed.error)); else if (parsed.status) this.options.onLog?.(parsed.status); } catch { /* partial line */ }
        });
        response.on("end", () => resolve());
      });
      request.on("error", (error) => reject(new Error(`docker pull error: ${error.message}`)));
      request.end();
    });
  }

  async create(spec: DockerContainerSpec) {
    if (this.options.pullOnCreate && !await this.imageExists(spec.image)) await this.pull(spec.image);
    const exposed: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const port of spec.ports) {
      const key = `${port.container}/${port.protocol}`;
      exposed[key] = {};
      portBindings[key] = [{ HostPort: String(port.host) }];
    }
    const body = {
      Image: spec.image,
      ...(spec.command?.length ? { Cmd: spec.command } : {}),
      ...(spec.workdir ? { WorkingDir: spec.workdir } : {}),
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      ExposedPorts: exposed,
      Labels: { "jp.panel": "instance", ...spec.labels },
      Tty: spec.tty !== false,
      OpenStdin: spec.openStdin !== false,
      StdinOnce: false,
      HostConfig: {
        Binds: spec.mounts,
        PortBindings: portBindings,
        RestartPolicy: { Name: spec.restart ?? "no" },
        ...(spec.cpu ? { NanoCpus: Math.round(spec.cpu * 1_000_000_000) } : {}),
        ...(spec.memoryMb ? { Memory: Math.round(spec.memoryMb * 1024 * 1024) } : {}),
        ...(spec.pids ? { PidsLimit: spec.pids } : {}),
      },
    };
    const response = await this.request<{ Id?: string; message?: string }>({ method: "POST", path: `/containers/create?name=${encodeURIComponent(spec.name)}`, body });
    if (response.status >= 400 || !response.body?.Id) throw new Error(`docker create failed: ${response.body?.message ?? response.status}`);
    return response.body.Id;
  }

  async start(id: string) {
    const response = await this.request({ method: "POST", path: `/containers/${id}/start` });
    if (response.status >= 400 && response.status !== 304) throw new Error(`docker start failed: ${response.status}`);
  }

  async stop(id: string, signal?: string, timeoutSeconds = 30) {
    const query = new URLSearchParams({ t: String(timeoutSeconds) });
    if (signal) query.set("signal", signal);
    const response = await this.request({ method: "POST", path: `/containers/${id}/stop?${query.toString()}`, timeoutMs: (timeoutSeconds + 10) * 1000 });
    if (response.status >= 400 && response.status !== 304) throw new Error(`docker stop failed: ${response.status}`);
  }

  async kill(id: string) {
    await this.request({ method: "POST", path: `/containers/${id}/kill` });
  }

  async remove(id: string, options: { force?: boolean; volumes?: boolean } = {}) {
    const query = new URLSearchParams({ force: String(options.force ?? true), v: String(options.volumes ?? true) });
    await this.request({ method: "DELETE", path: `/containers/${id}?${query.toString()}` });
  }

  async inspect(id: string) {
    const response = await this.request<{ State?: { Status?: string; Running?: boolean; ExitCode?: number; StartedAt?: string }; Name?: string }>({ method: "GET", path: `/containers/${id}/json` });
    if (response.status === 404) return undefined;
    if (response.status >= 400) throw new Error(`docker inspect failed: ${response.status}`);
    const state = response.body?.State ?? {};
    return {
      id, name: (response.body?.Name ?? "").replace(/^\//, ""),
      status: state.Status ?? "unknown", running: state.Running === true,
      exitCode: state.ExitCode ?? 0, startedAt: state.StartedAt ?? "",
    };
  }

  async logs(id: string, tail = 500) {
    const response = await this.request({ method: "GET", path: `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=0` });
    if (response.status >= 400) return "";
    // Docker multiplexes stdout/stderr with an 8 byte header per frame when not tty.
    return demultiplex(response.raw);
  }

  async exec(id: string, command: string[], options: { input?: string; tty?: boolean } = {}) {
    const created = await this.request<{ Id?: string }>({ method: "POST", path: `/containers/${id}/exec`, body: { AttachStdout: true, AttachStderr: true, AttachStdin: Boolean(options.input), Tty: options.tty === true, Cmd: command } });
    const execId = created.body?.Id;
    if (!execId) throw new Error("docker exec create failed");
    const output = await new Promise<string>((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, path: `/exec/${execId}/start`, method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(demultiplex(Buffer.concat(chunks))));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ Detach: false, Tty: options.tty === true }));
    });
    const inspected = await this.request<{ ExitCode?: number }>({ method: "GET", path: `/exec/${execId}/json` });
    return { code: inspected.body?.ExitCode ?? 0, output };
  }

  async writeStdin(id: string, data: string) {
    await new Promise<void>((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, path: `/containers/${id}/attach?stream=1&stdin=1`, method: "POST" }, () => resolve());
      request.on("error", (error) => reject(new Error(`docker attach error: ${error.message}`)));
      request.write(data);
      request.end();
    });
  }

  /** Hijack an exec session so the browser terminal talks to a real shell. */
  async attachExec(id: string, command: string[], onData: (chunk: string) => void) {
    const created = await this.request<{ Id?: string }>({ method: "POST", path: `/containers/${id}/exec`, body: { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: command } });
    const execId = created.body?.Id;
    if (!execId) throw new Error("docker exec create failed");
    return new Promise<{ write(data: string): void; close(): void }>((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath, path: `/exec/${execId}/start`, method: "POST",
        headers: { connection: "Upgrade", upgrade: "tcp", "content-type": "application/json" },
      });
      request.on("upgrade", (_response, socket) => {
        socket.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
        socket.on("close", () => onData("\r\n[session closed]\r\n"));
        resolve({
          write: (data: string) => { socket.write(data); },
          close: () => { socket.end(); request.destroy(); },
        });
      });
      request.on("response", (response) => {
        // Docker answers 200 with a raw stream when the daemon does not upgrade.
        response.on("data", (chunk: Buffer) => onData(demultiplex(chunk)));
        resolve({ write: () => undefined, close: () => request.destroy() });
      });
      request.on("error", (error) => reject(new Error(`docker exec error: ${error.message}`)));
      request.end(JSON.stringify({ Detach: false, Tty: true }));
    });
  }
}

/** Strip Docker's 8 byte stream headers (stdout=1, stderr=2) when present. */
function demultiplex(buffer: Buffer) {
  let offset = 0;
  let output = "";
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    if (stream !== 0 && stream !== 1 && stream !== 2) { output += buffer.slice(offset).toString("utf8"); break; }
    const size = buffer.readUInt32BE(offset + 4);
    output += buffer.slice(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
  }
  if (!output) output = buffer.toString("utf8");
  return output;
}
