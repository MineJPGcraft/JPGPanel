import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Logger, Schema } from "yumeri";
import type { User } from "@mirelia/user";
import type { ProjectService } from "@mirelia/project";
import type { StoreService } from "@mirelia/store";
import "@mirelia/dashboard";
import "@mirelia/project";
import "@mirelia/store";
import "@mirelia/user";
import {
  config as contractConfig, depend, provide,
  type ConfigParam, type ConfigValues, type Instance, type InstanceConfig, type InstanceGroup, type InstanceGroupView,
  type InstancePreset, type InstancePresetView, type InstanceRow, type InstanceService, type InstanceSpec,
  type InstanceSpecView, type InstanceTypeDefinition, type InstanceTypeView, type PresetFile, type PresetHealth,
  type PresetMount, type PresetPort,
} from "./contract.js";
import { DockerSocketDriver } from "./docker.js";

export { depend, provide };
export const config: Schema<InstanceConfig> = contractConfig;
export type * from "./contract.js";
export { DockerSocketDriver } from "./docker.js";

const logger = new Logger("server-instances");

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, fallback = "") { return typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value); }
function num(value: unknown, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function json<T>(value: string, fallback: T): T { try { const parsed = JSON.parse(value); return (parsed ?? fallback) as T; } catch { return fallback; } }
function slugify(value: string) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || `p-${randomBytes(3).toString("hex")}`; }
function instanceId() { return `ins_${randomBytes(5).toString("hex")}`; }

/**
 * Expand `{{key}}` placeholders. Values come from the preset defaults, the buyer's
 * choices, allocated ports and a few built-ins, so one preset can describe many servers.
 */
export function expand(input: string, scope: { values?: ConfigValues; ports?: Array<{ name: string; host: number }>; extra?: ConfigValues }) {
  return input.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (_match, key: string) => {
    if (key.startsWith("port:")) {
      const name = key.slice(5);
      const port = scope.ports?.find((entry) => entry.name === name);
      return port ? String(port.host) : "";
    }
    const value = scope.values?.[key] ?? scope.extra?.[key];
    return value === undefined ? "" : String(value);
  });
}

/** Defaults declared by a preset's parameters and environment. */
export function defaultsOf(params: ConfigParam[], env: ConfigValues): ConfigValues {
  const values: ConfigValues = {};
  for (const [key, value] of Object.entries(env)) if (!key.includes("{{")) values[key] = value;
  for (const param of params) {
    const field = param.field;
    if ("default" in field && field.default !== undefined) values[param.key] = field.default;
  }
  return values;
}

export async function apply(ctx: Context, pluginConfig: InstanceConfig = {
  dockerSocket: "/var/run/docker.sock", dataDir: "./data/instances", portRangeStart: 30000, portRangeEnd: 30999,
  healthTimeoutSeconds: 180, pullOnCreate: true,
}) {
  const settings = { ...pluginConfig };
  const db = ctx.component.database;
  const users = ctx.component.user;
  const projectService = ctx.component.project as ProjectService;
  const store = ctx.component.store as StoreService;
  const dataRoot = path.resolve(process.cwd(), settings.dataDir);
  const docker = new DockerSocketDriver(settings.dockerSocket, { pullOnCreate: settings.pullOnCreate });

  const types = new Map<string, InstanceTypeDefinition>();

  /**
   * Built-in types. A type is only a label plus the set of UI components a plugin can
   * contribute, so the platform can offer the common ones without a plugin.
   */
  const builtinTypes: InstanceTypeDefinition[] = [
    { id: "mc", name: "Minecraft", description: "Minecraft servers with player list and server settings tools", pluginId: "server-instances", icon: "⛏️" },
    { id: "shell", name: "Shell", description: "Any container with a shell, for example web apps or databases", pluginId: "server-instances", icon: "🖥️" },
  ];

  /* ---------------------------------------------------------------- *
   * Tables.
   * ---------------------------------------------------------------- */
  await db.extend("instance_groups", {
    id: { type: "integer", autoIncrement: true }, type_id: { type: "string", nullable: false },
    slug: { type: "string", nullable: false }, name: { type: "string", nullable: false },
    description: { type: "text", initial: "", nullable: false }, sort_order: { type: "integer", initial: 100, nullable: false },
    enabled: { type: "boolean", initial: true, nullable: false },
    created_at: { type: "timestamp", nullable: false }, updated_at: { type: "timestamp", nullable: false },
  }, { unique: ["slug"] });
  await db.extend("instance_presets", {
    id: { type: "integer", autoIncrement: true }, group_id: { type: "integer", nullable: false },
    slug: { type: "string", nullable: false }, name: { type: "string", nullable: false },
    tagline: { type: "string", initial: "", nullable: false }, icon: { type: "string", initial: "", nullable: false },
    description: { type: "text", initial: "", nullable: false }, image: { type: "string", nullable: false },
    pull_policy: { type: "string", initial: "missing", nullable: false }, command: { type: "text", initial: "", nullable: false },
    workdir: { type: "string", initial: "", nullable: false }, env_json: { type: "text", initial: "{}", nullable: false },
    ports_json: { type: "text", initial: "[]", nullable: false }, mounts_json: { type: "text", initial: "[]", nullable: false },
    files_json: { type: "text", initial: "[]", nullable: false }, params_json: { type: "text", initial: "[]", nullable: false },
    health_json: { type: "text", initial: '{"kind":"none","target":"","timeoutSeconds":180}', nullable: false },
    stop_signal: { type: "string", initial: "SIGTERM", nullable: false }, stop_timeout_seconds: { type: "integer", initial: 30, nullable: false },
    restart: { type: "string", initial: "no", nullable: false }, limits_json: { type: "text", initial: "{}", nullable: false },
    specs_json: { type: "text", initial: "[]", nullable: false }, sort_order: { type: "integer", initial: 100, nullable: false },
    enabled: { type: "boolean", initial: true, nullable: false },
    created_at: { type: "timestamp", nullable: false }, updated_at: { type: "timestamp", nullable: false },
  }, { unique: ["slug"] });
  await db.extend("instance_specs", {
    id: { type: "integer", autoIncrement: true }, name: { type: "string", nullable: false },
    cpu: { type: "float", initial: 1, nullable: false }, memory_mb: { type: "integer", initial: 1024, nullable: false },
    disk_gb: { type: "integer", initial: 10, nullable: false }, price_cents: { type: "integer", initial: 0, nullable: false },
    enabled: { type: "boolean", initial: true, nullable: false }, sort_order: { type: "integer", initial: 100, nullable: false },
    description: { type: "text", initial: "", nullable: false },
    created_at: { type: "timestamp", nullable: false }, updated_at: { type: "timestamp", nullable: false },
  });
  await db.extend("instances", {
    id: { type: "integer", autoIncrement: true }, instance_id: { type: "string", nullable: false },
    tenant_id: { type: "integer", nullable: false }, project_id: { type: "integer", nullable: false },
    owner_user_id: { type: "integer", nullable: false }, type_id: { type: "string", nullable: false },
    group_id: { type: "integer", initial: 0, nullable: false }, preset_id: { type: "integer", initial: 0, nullable: false },
    spec_id: { type: "integer", initial: 0, nullable: false }, name: { type: "string", nullable: false },
    container_id: { type: "string", initial: "", nullable: false }, status: { type: "string", initial: "creating", nullable: false },
    cpu: { type: "float", initial: 1, nullable: false }, memory_mb: { type: "integer", initial: 1024, nullable: false },
    disk_gb: { type: "integer", initial: 10, nullable: false }, ports_json: { type: "text", initial: "[]", nullable: false },
    params_json: { type: "text", initial: "{}", nullable: false }, last_error: { type: "text", initial: "", nullable: false },
    order_id: { type: "string", initial: "", nullable: false }, started_at: { type: "timestamp", initial: "", nullable: false },
    stopped_at: { type: "timestamp", initial: "", nullable: false },
    created_at: { type: "timestamp", nullable: false }, updated_at: { type: "timestamp", nullable: false },
  }, { unique: ["instance_id"] });
  await db.extend("instance_events", {
    id: { type: "integer", autoIncrement: true }, instance_id: { type: "string", nullable: false },
    event_type: { type: "string", nullable: false }, message: { type: "text", initial: "", nullable: false },
    actor_user_id: { type: "integer", initial: 0, nullable: false }, created_at: { type: "timestamp", nullable: false },
  });

  /* ---------------------------------------------------------------- *
   * Read models.
   * ---------------------------------------------------------------- */
  async function groupView(group: InstanceGroup): Promise<InstanceGroupView> {
    const presets = await db.select("instance_presets", { group_id: group.id }) as InstancePreset[];
    const instances = await db.select("instances", { group_id: group.id }) as InstanceRow[];
    return { ...group, presets: presets.length, instances: instances.length };
  }

  async function presetView(preset: InstancePreset, withGroup = true): Promise<InstancePresetView> {
    const group = withGroup ? await db.selectOne("instance_groups", { id: preset.group_id }) as InstanceGroup | undefined : undefined;
    const { env_json, ports_json, mounts_json, files_json, params_json, health_json, limits_json, specs_json, ...rest } = preset;
    return {
      ...rest,
      env: json<ConfigValues>(env_json, {}),
      ports: json<PresetPort[]>(ports_json, []),
      mounts: json<PresetMount[]>(mounts_json, []),
      files: json<PresetFile[]>(files_json, []),
      params: json<ConfigParam[]>(params_json, []),
      health: json<PresetHealth>(health_json, { kind: "none", target: "", timeoutSeconds: 180 }),
      limits: json(limits_json, {}),
      specs: json<number[]>(specs_json, []),
      group,
    };
  }

  function instanceModel(row: InstanceRow, preset?: InstancePresetView, spec?: InstanceSpec, projectName?: string): Instance {
    return {
      ...row,
      ports: json(row.ports_json, []),
      params: json(row.params_json, {}),
      preset, spec, projectName,
    };
  }

  async function presetById(id: number) { const row = await db.selectOne("instance_presets", { id }) as InstancePreset | undefined; return row ? presetView(row) : undefined; }

  /* ---------------------------------------------------------------- *
   * Port allocation.
   * ---------------------------------------------------------------- */
  async function allocatePorts(preset: InstancePresetView, environment: ConfigValues) {
    const used = new Set<number>();
    for (const row of await db.select("instances", {}) as InstanceRow[]) {
      for (const port of json<Array<{ host: number }>>(row.ports_json, [])) used.add(Number(port.host));
    }
    const ports: Array<{ name: string; host: number; container: number; protocol: "tcp" | "udp" }> = [];
    for (const declaration of preset.ports) {
      const override = Number(environment[`port.${declaration.name}`] ?? NaN);
      if (declaration.host !== "auto" || Number.isFinite(override)) {
        const host = Number.isFinite(override) ? override : Number(declaration.host);
        if (used.has(host)) throw new Error(`port ${host} is already assigned`);
        used.add(host);
        ports.push({ name: declaration.name, host, container: declaration.container, protocol: declaration.protocol });
        continue;
      }
      let host = settings.portRangeStart;
      while (host <= settings.portRangeEnd && used.has(host)) host += 1;
      if (host > settings.portRangeEnd) throw new Error("no free port left in the configured range");
      used.add(host);
      ports.push({ name: declaration.name, host, container: declaration.container, protocol: declaration.protocol });
    }
    return ports;
  }

  /* ---------------------------------------------------------------- *
   * Pre-copied files.
   * ---------------------------------------------------------------- */
  async function prepareFiles(preset: InstancePresetView, directory: string, scope: { values: ConfigValues; ports: Array<{ name: string; host: number }> }) {
    for (const file of preset.files) {
      const target = path.join(directory, expand(file.target, scope).replace(/^\/+/, ""));
      if (!target.startsWith(directory)) continue;
      if (existsSync(target) && !file.overwrite) continue;
      let content: Buffer | undefined;
      try {
        if (file.source === "inline") content = Buffer.from(expand(file.value, scope), "utf8");
        else if (file.source === "url") {
          const response = await fetch(expand(file.value, scope));
          if (!response.ok) throw new Error(`download failed (${response.status})`);
          content = Buffer.from(await response.arrayBuffer());
        } else {
          const source = path.join(directory, expand(file.value, scope).replace(/^\/+/, ""));
          if (existsSync(source)) content = readFileSync(source);
        }
      } catch (error) { throw new Error(`pre-copy ${file.target}: ${error instanceof Error ? error.message : String(error)}`); }
      if (!content) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }

  /* ---------------------------------------------------------------- *
   * Container lifecycle.
   * ---------------------------------------------------------------- */
  function containerSpec(row: InstanceRow, preset: InstancePresetView, environment: ConfigValues, ports: Array<{ name: string; host: number; container: number; protocol: "tcp" | "udp" }>) {
    const directory = path.join(dataRoot, row.instance_id);
    const scope = { values: environment, ports, extra: { instanceId: row.instance_id, projectId: row.project_id, name: row.name } };
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(preset.env)) env[key] = expand(String(value), scope);
    for (const param of preset.params) {
      if (param.scope !== "purchase") continue;
      const value = environment[param.key];
      if (value !== undefined) env[param.key] = String(value);
    }
    const limits = { ...preset.limits, cpu: preset.limits.cpu ?? row.cpu, memoryMb: preset.limits.memoryMb ?? row.memory_mb };
    return {
      name: `jpg-${row.instance_id}`,
      image: preset.image,
      command: preset.command.trim() ? preset.command.trim().split(/\s+/).map((part) => expand(part, scope)) : undefined,
      env,
      mounts: (preset.mounts.length ? preset.mounts : [{ source: "server", target: "/data", mode: "rw" as const }]).map((mount) => {
        const host = path.join(directory, expand(mount.source, scope).replace(/^\/+/, ""));
        mkdirSync(host, { recursive: true });
        return `${host}:${expand(mount.target, scope)}:${mount.mode}`;
      }),
      ports,
      workdir: preset.workdir ? expand(preset.workdir, scope) : undefined,
      cpu: limits.cpu, memoryMb: limits.memoryMb, pids: limits.pids,
      restart: preset.restart,
      labels: { "jp.instance": row.instance_id, "jp.preset": String(preset.id ?? "") },
    };
  }

  async function waitHealthy(preset: InstancePresetView, ports: Array<{ name: string; host: number }>, containerId: string, onLine?: (line: string) => void) {
    const health = preset.health;
    const timeout = Math.max(10, health.timeoutSeconds || settings.healthTimeoutSeconds) * 1000;
    const started = Date.now();
    if (health.kind === "none") return;
    onLine?.(`waiting for health check (${health.kind})`);
    while (Date.now() - started < timeout) {
      if (health.kind === "tcp" || health.kind === "http") {
        const port = ports.find((entry) => entry.name === health.target) ?? ports[0];
        if (port) {
          try {
            const response = await fetch(`http://127.0.0.1:${port.host}/`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
            if (health.kind === "http" && response) return;
            if (health.kind === "tcp") {
              const net = await import("node:net");
              const open = await new Promise<boolean>((resolve) => {
                const socket = net.connect(port.host, "127.0.0.1");
                socket.once("connect", () => { socket.destroy(); resolve(true); });
                socket.once("error", () => resolve(false));
                socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
              });
              if (open) return;
            }
          } catch { /* keep polling */ }
        }
      } else if (health.kind === "log") {
        const logs = await docker.logs(containerId, 200).catch(() => "");
        if (logs.includes(health.target)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`health check did not pass within ${Math.round(timeout / 1000)}s`);
  }

  async function boot(row: InstanceRow, preset: InstancePresetView, environment: ConfigValues) {
    const ports = row.ports_json ? json<Array<{ name: string; host: number; container: number; protocol: "tcp" | "udp" }>>(row.ports_json, []) : await allocatePorts(preset, environment);
    if (!row.ports_json) await db.update("instances", { id: row.id }, { ports_json: JSON.stringify(ports) });
    const directory = path.join(dataRoot, row.instance_id);
    mkdirSync(directory, { recursive: true });
    for (const mount of preset.mounts) mkdirSync(path.join(directory, mount.source), { recursive: true });
    await prepareFiles(preset, directory, { values: environment, ports });
    await service.recordEvent(row.instance_id, "provision", `prepared files for ${preset.name}`);
    const spec = containerSpec({ ...row, ports_json: JSON.stringify(ports) }, preset, environment, ports);
    let containerId = row.container_id;
    if (containerId) await docker.remove(containerId, { force: true }).catch(() => undefined);
    containerId = await docker.create(spec);
    await db.update("instances", { id: row.id }, { container_id: containerId, updated_at: new Date().toISOString() });
    await docker.start(containerId);
    await db.update("instances", { id: row.id }, { status: "running", started_at: new Date().toISOString(), last_error: "", updated_at: new Date().toISOString() });
    await service.recordEvent(row.instance_id, "start", `container started (${preset.image})`);
    try {
      await waitHealthy(preset, ports, containerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.update("instances", { id: row.id }, { status: "failed", last_error: message, updated_at: new Date().toISOString() });
      await service.recordEvent(row.instance_id, "error", message);
      throw error;
    }
    return containerId;
  }

  const service: InstanceService = {
    registerType(definition) {
      const id = text(definition.id).trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]{1,39}$/.test(id)) throw new Error(`invalid instance type id: ${definition.id}`);
      types.set(id, { ...definition, id });
      logger.info(`Registered instance type ${id} from ${definition.pluginId}`);
      const remove = () => { if (types.get(id) === definition) types.delete(id); };
      ctx.affect(remove);
      return remove;
    },

    async listTypes() {
      const output: InstanceTypeView[] = [];
      for (const type of types.values()) {
        const groups = await db.select("instance_groups", { type_id: type.id }) as InstanceGroup[];
        const groupIds = new Set(groups.map((group) => group.id));
        const presets = (await db.select("instance_presets", {}) as InstancePreset[]).filter((preset) => groupIds.has(preset.group_id));
        const instances = (await db.select("instances", { type_id: type.id }) as InstanceRow[]).length;
        output.push({ ...type, groups: groups.length, presets: presets.length, instances });
      }
      return output;
    },

    async listGroups(typeId) {
      const groups = (await db.select("instance_groups", typeId ? { type_id: typeId } : {}) as InstanceGroup[]).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
      const output: InstanceGroupView[] = [];
      for (const group of groups) output.push(await groupView(group));
      return output;
    },

    async createGroup(input) {
      const type = types.get(text(input.type_id).trim().toLowerCase());
      if (!type) throw new Error("instance_type_missing");
      const name = text(input.name).trim().slice(0, 80);
      if (!name) throw new Error("instance_group_name");
      const now = new Date().toISOString();
      const created = await db.create("instance_groups", {
        type_id: type.id, slug: slugify(text(input.slug) || name), name,
        description: text(input.description).slice(0, 500), sort_order: num(input.sort_order, 100),
        enabled: input.enabled !== false, created_at: now, updated_at: now,
      }) as InstanceGroup;
      await syncStore();
      return groupView(created);
    },

    async updateGroup(id, input) {
      const group = await db.selectOne("instance_groups", { id }) as InstanceGroup | undefined;
      if (!group) throw new Error("instance_group_missing");
      const updates: Partial<InstanceGroup> = { updated_at: new Date().toISOString() };
      if (typeof input.name === "string" && input.name.trim()) updates.name = input.name.trim().slice(0, 80);
      if (typeof input.description === "string") updates.description = input.description.slice(0, 500);
      if (input.sort_order !== undefined) updates.sort_order = num(input.sort_order, group.sort_order);
      if (typeof input.enabled === "boolean") updates.enabled = input.enabled;
      await db.update("instance_groups", { id }, updates);
      await syncStore();
      return groupView({ ...group, ...updates });
    },

    async deleteGroup(id) {
      const presets = await db.select("instance_presets", { group_id: id }) as InstancePreset[];
      if (presets.length) throw new Error("instance_group_in_use");
      await db.remove("instance_groups", { id });
      await syncStore();
    },

    async listPresets(groupId) {
      const presets = (await db.select("instance_presets", groupId ? { group_id: groupId } : {}) as InstancePreset[]).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
      const output: InstancePresetView[] = [];
      for (const preset of presets) output.push(await presetView(preset));
      return output;
    },

    async findPreset(id) { return presetById(id); },

    async createPreset(rawInput) {
      const input = rawInput as unknown as Partial<InstancePresetView>;
      const group = await db.selectOne("instance_groups", { id: num(input.group_id) }) as InstanceGroup | undefined;
      if (!group) throw new Error("instance_group_missing");
      const name = text(input.name).trim().slice(0, 80);
      const image = text(input.image).trim().slice(0, 200);
      if (!name) throw new Error("instance_preset_name");
      if (!image) throw new Error("instance_preset_image");
      const now = new Date().toISOString();
      const preset = await db.create("instance_presets", {
        group_id: group.id!, slug: slugify(text(input.slug) || name), name,
        tagline: text(input.tagline).slice(0, 120), icon: text(input.icon).slice(0, 200), description: text(input.description).slice(0, 2000),
        image, pull_policy: input.pull_policy === "always" || input.pull_policy === "never" ? input.pull_policy : "missing",
        command: text(input.command).slice(0, 2000), workdir: text(input.workdir).slice(0, 200),
        env_json: JSON.stringify(object(input.env ?? {})),
        ports_json: JSON.stringify(normalizePorts(input.ports)),
        mounts_json: JSON.stringify(normalizeMounts(input.mounts)),
        files_json: JSON.stringify(normalizeFiles(input.files)),
        params_json: JSON.stringify(normalizeParams(input.params)),
        health_json: JSON.stringify(normalizeHealth(input.health)),
        stop_signal: text(input.stop_signal, "SIGTERM").slice(0, 32), stop_timeout_seconds: Math.min(600, Math.max(1, num(input.stop_timeout_seconds, 30))),
        restart: input.restart === "on-failure" || input.restart === "always" ? input.restart : "no",
        limits_json: JSON.stringify(normalizeLimits(input.limits)), specs_json: JSON.stringify(normalizeSpecIds(input.specs ?? [])),
        sort_order: num(input.sort_order, 100), enabled: input.enabled !== false, created_at: now, updated_at: now,
      }) as InstancePreset;
      await syncStore();
      return presetView(preset);
    },

    async updatePreset(id, input) {
      const preset = await db.selectOne("instance_presets", { id }) as InstancePreset | undefined;
      if (!preset) throw new Error("instance_preset_missing");
      const updates: Partial<InstancePreset> = { updated_at: new Date().toISOString() };
      // Administrators send the structured view (env/ports/…) rather than the JSON columns.
      const patch = input as unknown as Partial<InstancePresetView>;
      if (patch.group_id && patch.group_id !== preset.group_id) {
        if (!await db.selectOne("instance_groups", { id: patch.group_id })) throw new Error("instance_group_missing");
        updates.group_id = patch.group_id;
      }
      if (typeof patch.name === "string" && patch.name.trim()) updates.name = patch.name.trim().slice(0, 80);
      if (typeof patch.image === "string" && patch.image.trim()) updates.image = patch.image.trim().slice(0, 200);
      if (typeof patch.tagline === "string") updates.tagline = patch.tagline.slice(0, 120);
      if (typeof patch.icon === "string") updates.icon = patch.icon.slice(0, 200);
      if (typeof patch.description === "string") updates.description = patch.description.slice(0, 2000);
      if (patch.pull_policy) updates.pull_policy = patch.pull_policy;
      if (typeof patch.command === "string") updates.command = patch.command.slice(0, 2000);
      if (typeof patch.workdir === "string") updates.workdir = patch.workdir.slice(0, 200);
      if (patch.env) updates.env_json = JSON.stringify(object(patch.env));
      if (patch.ports) updates.ports_json = JSON.stringify(normalizePorts(patch.ports));
      if (patch.mounts) updates.mounts_json = JSON.stringify(normalizeMounts(patch.mounts));
      if (patch.files) updates.files_json = JSON.stringify(normalizeFiles(patch.files));
      if (patch.params) updates.params_json = JSON.stringify(normalizeParams(patch.params));
      if (patch.health) updates.health_json = JSON.stringify(normalizeHealth(patch.health));
      if (typeof patch.stop_signal === "string" && patch.stop_signal.trim()) updates.stop_signal = patch.stop_signal.slice(0, 32);
      if (patch.stop_timeout_seconds !== undefined) updates.stop_timeout_seconds = Math.min(600, Math.max(1, num(patch.stop_timeout_seconds, 30)));
      if (patch.restart) updates.restart = patch.restart;
      if (patch.limits) updates.limits_json = JSON.stringify(normalizeLimits(patch.limits));
      if (Array.isArray(patch.specs)) updates.specs_json = JSON.stringify(normalizeSpecIds(patch.specs));
      if (patch.sort_order !== undefined) updates.sort_order = num(patch.sort_order, preset.sort_order);
      if (typeof patch.enabled === "boolean") updates.enabled = patch.enabled;
      await db.update("instance_presets", { id }, updates);
      await syncStore();
      return presetView({ ...preset, ...updates } as InstancePreset);
    },

    async deletePreset(id) {
      const used = (await db.select("instances", { preset_id: id }) as InstanceRow[]).length;
      if (used) throw new Error("instance_preset_in_use");
      await db.remove("instance_presets", { id });
      await syncStore();
    },

    async listSpecs() {
      const specs = (await db.select("instance_specs", {}) as InstanceSpec[]).sort((a, b) => a.sort_order - b.sort_order || a.cpu - b.cpu || a.price_cents - b.price_cents);
      const output: InstanceSpecView[] = [];
      for (const spec of specs) output.push({ ...spec, instances: (await db.select("instances", { spec_id: spec.id }) as InstanceRow[]).length });
      return output;
    },

    async createSpec(input) {
      const name = text(input.name).trim().slice(0, 80);
      if (!name) throw new Error("instance_spec_name");
      const now = new Date().toISOString();
      const created = await db.create("instance_specs", {
        name, cpu: Math.max(0.1, num(input.cpu, 1)), memory_mb: Math.max(128, Math.trunc(num(input.memory_mb, 1024))),
        disk_gb: Math.max(1, Math.trunc(num(input.disk_gb, 10))), price_cents: Math.max(0, Math.trunc(num(input.price_cents, 0))),
        enabled: input.enabled !== false, sort_order: num(input.sort_order, 100), description: text(input.description).slice(0, 300),
        created_at: now, updated_at: now,
      }) as InstanceSpec;
      await syncStore();
      return { ...created, instances: 0 };
    },

    async updateSpec(id, input) {
      const spec = await db.selectOne("instance_specs", { id }) as InstanceSpec | undefined;
      if (!spec) throw new Error("instance_spec_missing");
      const updates: Partial<InstanceSpec> = { updated_at: new Date().toISOString() };
      if (typeof input.name === "string" && input.name.trim()) updates.name = input.name.trim().slice(0, 80);
      if (input.cpu !== undefined) updates.cpu = Math.max(0.1, num(input.cpu, spec.cpu));
      if (input.memory_mb !== undefined) updates.memory_mb = Math.max(128, Math.trunc(num(input.memory_mb, spec.memory_mb)));
      if (input.disk_gb !== undefined) updates.disk_gb = Math.max(1, Math.trunc(num(input.disk_gb, spec.disk_gb)));
      if (input.price_cents !== undefined) updates.price_cents = Math.max(0, Math.trunc(num(input.price_cents, spec.price_cents)));
      if (typeof input.enabled === "boolean") updates.enabled = input.enabled;
      if (input.sort_order !== undefined) updates.sort_order = num(input.sort_order, spec.sort_order);
      if (typeof input.description === "string") updates.description = input.description.slice(0, 300);
      await db.update("instance_specs", { id }, updates);
      await syncStore();
      return { ...spec, ...updates, instances: (await db.select("instances", { spec_id: id }) as InstanceRow[]).length };
    },

    async deleteSpec(id) {
      if ((await db.select("instances", { spec_id: id }) as InstanceRow[]).length) throw new Error("instance_spec_in_use");
      await db.remove("instance_specs", { id });
      await syncStore();
    },

    async get(instanceIdValue) {
      const row = await db.selectOne("instances", { instance_id: instanceIdValue }) as InstanceRow | undefined;
      if (!row) return undefined;
      const preset = row.preset_id ? await presetById(row.preset_id) : undefined;
      const spec = row.spec_id ? await db.selectOne("instance_specs", { id: row.spec_id }) as InstanceSpec | undefined : undefined;
      let status = row.status;
      if (row.container_id && (status === "running" || status === "stopped")) {
        const state = await docker.inspect(row.container_id).catch(() => undefined);
        if (state) status = state.running ? "running" : "stopped";
        else if (status === "running") status = "stopped";
      }
      const project = await db.selectOne("projects", { id: row.project_id }) as { name?: string } | undefined;
      return instanceModel({ ...row, status }, preset, spec, project?.name);
    },

    async listForUser(user) {
      if (user.id === undefined) return [];
      const rows = (await db.select("instances", { owner_user_id: user.id }) as InstanceRow[]).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const output: Instance[] = [];
      for (const row of rows) { const instance = await service.get(row.instance_id); if (instance) output.push(instance); }
      return output;
    },

    async listForProject(projectId) {
      const rows = (await db.select("instances", { project_id: projectId }) as InstanceRow[]).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const output: Instance[] = [];
      for (const row of rows) { const instance = await service.get(row.instance_id); if (instance) output.push(instance); }
      return output;
    },

    async authorize(session, instanceIdValue) {
      const instance = await service.get(instanceIdValue);
      if (!instance) { session.status = 404; session.respond({ error: session.text("instances.errors.notFound") }, "json"); return undefined; }
      const user = await users.current(session);
      if (!user) { session.status = 401; session.respond({ error: session.text("instances.errors.auth") }, "json"); return undefined; }
      if (instance.owner_user_id === user.id || users.isAdmin(user)) return instance;
      const access = await projectService.authorize(session, instance.project_id, "view").catch(() => undefined);
      if (access?.project.id) return instance;
      session.status = 404; session.respond({ error: session.text("instances.errors.notFound") }, "json");
      return undefined;
    },

    async start(instanceIdValue, actor) {
      const row = await db.selectOne("instances", { instance_id: instanceIdValue }) as InstanceRow | undefined;
      if (!row) throw new Error("instance_missing");
      const preset = await presetById(row.preset_id);
      if (!preset) throw new Error("instance_preset_missing");
      const environment = { ...defaultsOf(preset.params, preset.env), ...json<ConfigValues>(row.params_json, {}) };
      await service.recordEvent(instanceIdValue, "start", `start requested by ${actor?.username ?? "system"}`, actor);
      if (row.container_id) {
        const state = await docker.inspect(row.container_id).catch(() => undefined);
        if (state && !state.running) {
          await docker.start(row.container_id);
          await db.update("instances", { id: row.id }, { status: "running", started_at: new Date().toISOString(), updated_at: new Date().toISOString() });
          return (await service.get(instanceIdValue))!;
        }
      }
      await boot(row, preset, environment);
      return (await service.get(instanceIdValue))!;
    },

    async stop(instanceIdValue, actor) {
      const row = await db.selectOne("instances", { instance_id: instanceIdValue }) as InstanceRow | undefined;
      if (!row) throw new Error("instance_missing");
      const preset = await presetById(row.preset_id);
      await service.recordEvent(instanceIdValue, "stop", `stop requested by ${actor?.username ?? "system"}`, actor);
      if (row.container_id) await docker.stop(row.container_id, preset?.stop_signal, preset?.stop_timeout_seconds ?? 30).catch(() => undefined);
      await db.update("instances", { id: row.id }, { status: "stopped", stopped_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return (await service.get(instanceIdValue))!;
    },

    async remove(instanceIdValue, actor, deleteData = false) {
      const row = await db.selectOne("instances", { instance_id: instanceIdValue }) as InstanceRow | undefined;
      if (!row) throw new Error("instance_missing");
      if (row.container_id) await docker.remove(row.container_id, { force: true }).catch(() => undefined);
      await db.update("instances", { id: row.id }, { status: "removed", updated_at: new Date().toISOString() });
      await service.recordEvent(instanceIdValue, "remove", `removed by ${actor?.username ?? "system"}${deleteData ? " (data deleted)" : ""}`, actor);
      if (deleteData) {
        const { rmSync } = await import("node:fs");
        rmSync(path.join(dataRoot, instanceIdValue), { recursive: true, force: true });
      }
    },

    async events(instanceIdValue, limit = 50) {
      const rows = await db.select("instance_events", { instance_id: instanceIdValue }) as Array<{ id?: number; instance_id: string; event_type: string; message: string; actor_user_id: number; created_at: string }>;
      return rows.sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).slice(0, Math.max(1, Math.min(limit, 200)));
    },

    async recordEvent(instanceIdValue, type, message, actor) {
      await db.create("instance_events", { instance_id: instanceIdValue, event_type: type, message: message.slice(0, 2000), actor_user_id: actor?.id ?? 0, created_at: new Date().toISOString() });
    },

    async sendCommand(instanceIdValue, command) {
      const row = await db.selectOne("instances", { instance_id: instanceIdValue }) as InstanceRow | undefined;
      if (!row?.container_id) return undefined;
      const before = await docker.logs(row.container_id, 200).catch(() => "");
      await docker.writeStdin(row.container_id, `${command}\n`).catch(() => undefined);
      // The answer arrives on stdout shortly after; poll briefly for new lines.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const after = await docker.logs(row.container_id, 200).catch(() => "");
        if (after.length > before.length) return after.slice(before.length);
      }
      return undefined;
    },

    async environment(instanceIdValue) {
      const row = await db.selectOne("instances", { instance_id: instanceIdValue }) as InstanceRow | undefined;
      if (!row) return undefined;
      const preset = await presetById(row.preset_id);
      if (!preset) return undefined;
      return { preset, values: { ...defaultsOf(preset.params, preset.env), ...json<ConfigValues>(row.params_json, {}) } };
    },
  };
  ctx.registerComponent("instances", service);

  /* ---------------------------------------------------------------- *
   * Store: every enabled preset is a product; specs are its options.
   * ---------------------------------------------------------------- */
  async function syncStore() {
    const groups = new Map((await db.select("instance_groups", {}) as InstanceGroup[]).map((group) => [group.id, group]));
    const specs = await db.select("instance_specs", {}) as InstanceSpec[];
    for (const preset of await db.select("instance_presets", {}) as InstancePreset[]) {
      const group = groups.get(preset.group_id);
      if (!group?.enabled || !preset.enabled) continue;
      const offered = specs.filter((spec) => spec.enabled && json<number[]>(preset.specs_json, []).includes(spec.id!));
      if (!offered.length) continue;
      const cheapest = offered.reduce((best, spec) => spec.price_cents < best.price_cents ? spec : best, offered[0]);
      const params = json<ConfigParam[]>(preset.params_json, []).filter((param) => param.scope === "purchase");
      try {
        store.registerProduct("server-instances", {
          id: `preset-${preset.id}`,
          name: preset.name,
          summary: preset.tagline || group.name,
          description: preset.description,
          provider: group.name,
          category: "server",
          priceCents: cheapest.price_cents,
          period: "month",
          quantity: "fixed",
          sortOrder: preset.sort_order,
          highlights: [preset.image, group.name],
          price: (selections) => {
            const chosen = offered.find((spec) => String(spec.id) === String(selections.spec));
            return chosen?.price_cents ?? cheapest.price_cents;
          },
          fields: [
            { key: "spec", label: "Specification", required: true, options: offered.map((spec) => ({ value: String(spec.id), label: spec.name, description: `${spec.cpu} vCPU · ${spec.memory_mb} MB${spec.disk_gb ? ` · ${spec.disk_gb} GB` : ""}` })) },
            ...params.map((param) => ({
              key: param.key,
              label: param.field.title ?? param.key,
              type: (param.field.type === "enum" ? "select" : param.field.type === "number" || param.field.type === "integer" ? "number" : param.field.type === "boolean" ? "boolean" : "text") as "select" | "number" | "boolean" | "text",
              required: !("default" in param.field && param.field.default !== undefined),
              options: param.field.type === "enum" ? param.field.values.map((choice) => ({ value: choice.value, label: choice.title ?? choice.value })) : undefined,
            })),
          ],
        });
      } catch (error) {
        logger.warn(`could not publish preset ${preset.slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  store.registerPurchaseHandler("server-instances", async (request) => {
    const presetId = Number(String(request.selections.spec ?? "")) && Number(String(request.productId ?? "").replace("type-", "").replace("preset-", ""))
      ? Number(String(request.productId).replace("preset-", "")) : 0;
    const preset = presetId ? await db.selectOne("instance_presets", { id: presetId }) as InstancePreset | undefined : undefined;
    if (!preset) throw new Error("INSTANCE_PRESET_MISSING");
    const group = await db.selectOne("instance_groups", { id: preset.group_id }) as InstanceGroup | undefined;
    if (!group) throw new Error("INSTANCE_GROUP_MISSING");
    const spec = await db.selectOne("instance_specs", { id: Number(request.selections.spec) }) as InstanceSpec | undefined;
    if (!spec) throw new Error("INSTANCE_SPEC_MISSING");
    if (!json<number[]>(preset.specs_json, []).includes(spec.id!)) throw new Error("INSTANCE_SPEC_NOT_OFFERED");

    const view = await presetView(preset);
    const params: ConfigValues = {};
    for (const param of view.params.filter((entry) => entry.scope === "purchase")) {
      const raw = request.selections[param.key];
      if (raw === undefined || raw === "") continue;
      params[param.key] = param.field.type === "number" || param.field.type === "integer" ? Number(raw)
        : param.field.type === "boolean" ? raw === "true" : String(raw);
    }

    const id = instanceId();
    const now = new Date().toISOString();
    const row = await db.create("instances", {
      instance_id: id, tenant_id: request.tenant.id!, project_id: request.project.id, owner_user_id: request.user.id!,
      type_id: group.type_id, group_id: group.id!, preset_id: preset.id!, spec_id: spec.id!,
      name: `${preset.name} ${id.slice(-4)}`, container_id: "", status: "creating", cpu: spec.cpu, memory_mb: spec.memory_mb,
      disk_gb: spec.disk_gb, ports_json: "", params_json: JSON.stringify(params), last_error: "",
      order_id: request.idempotencyKey, started_at: "", stopped_at: "", created_at: now, updated_at: now,
    }) as InstanceRow;
    await service.recordEvent(id, "created", `created ${preset.name} with spec ${spec.name}`, request.user);
    try {
      await boot(row, view, { ...defaultsOf(view.params, view.env), ...params });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.update("instances", { id: row.id }, { status: "failed", last_error: message.slice(0, 500), updated_at: new Date().toISOString() });
      await service.recordEvent(id, "error", `provisioning failed: ${message}`);
      throw error;
    }
    const instance = (await service.get(id))!;
    return {
      name: instance.name, resourceId: id, status: instance.status,
      attributes: {
        instanceId: id, preset: preset.slug, image: preset.image, type: group.type_id,
        ports: instance.ports, cpu: spec.cpu, memoryMb: spec.memory_mb, diskGb: spec.disk_gb,
      },
    };
  });

  /* ---------------------------------------------------------------- *
   * Normalisers for administrator input.
   * ---------------------------------------------------------------- */
  function normalizePorts(value: unknown): PresetPort[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => {
      const port = object(entry);
      return {
        name: text(port.name).trim().slice(0, 40) || "port",
        container: Math.max(1, Math.trunc(num(port.container, 25565))),
        protocol: port.protocol === "udp" ? "udp" as const : "tcp" as const,
        host: port.host === "auto" || port.host === undefined || port.host === "" ? "auto" as const : Math.max(1, Math.trunc(num(port.host, 0))),
      };
    }).filter((port, index, all) => all.findIndex((entry) => entry.name === port.name) === index);
  }
  function normalizeMounts(value: unknown): PresetMount[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => {
      const mount = object(entry);
      return { source: text(mount.source).trim().replace(/^\/+/, "").slice(0, 120) || "server", target: text(mount.target).trim().slice(0, 200) || "/data", mode: mount.mode === "ro" ? "ro" as const : "rw" as const };
    });
  }
  function normalizeFiles(value: unknown): PresetFile[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => {
      const file = object(entry);
      const source: PresetFile["source"] = file.source === "url" || file.source === "path" ? file.source : "inline";
      return { source, value: text(file.value).slice(0, 20000), target: text(file.target).trim().slice(0, 200), overwrite: file.overwrite === true };
    }).filter((file) => file.target);
  }
  function normalizeParams(value: unknown): ConfigParam[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => {
      const param = object(entry);
      const field = object(param.field) as { type?: string };
      return {
        key: text(param.key).trim().slice(0, 60),
        scope: param.scope === "provision" ? "provision" as const : "purchase" as const,
        field: (field.type ? field : { type: "string" }) as ConfigParam["field"],
      };
    }).filter((param) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(param.key));
  }
  function normalizeHealth(value: unknown): PresetHealth {
    const health = object(value);
    const kind = health.kind === "tcp" || health.kind === "http" || health.kind === "log" ? health.kind : "none" as const;
    return { kind, target: text(health.target).slice(0, 200), timeoutSeconds: Math.min(3600, Math.max(5, num(health.timeoutSeconds, 180))) };
  }
  function normalizeLimits(value: unknown) {
    const limits = object(value);
    const output: { cpu?: number; memoryMb?: number; diskGb?: number; pids?: number } = {};
    if (num(limits.cpu, 0) > 0) output.cpu = num(limits.cpu);
    if (num(limits.memoryMb, 0) > 0) output.memoryMb = Math.trunc(num(limits.memoryMb));
    if (num(limits.diskGb, 0) > 0) output.diskGb = Math.trunc(num(limits.diskGb));
    if (num(limits.pids, 0) > 0) output.pids = Math.trunc(num(limits.pids));
    return output;
  }
  function normalizeSpecIds(value: unknown) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((entry) => Math.trunc(num(entry, 0))).filter((id) => id > 0))];
  }

  /* ---------------------------------------------------------------- *
   * Routes are implemented in routes.ts and mounted here.
   * ---------------------------------------------------------------- */
  const { mountRoutes } = await import("./routes.js");
  mountRoutes(ctx, {
    db, users, docker, service, settings, dataRoot,
    presetView, presetById, groupView, syncStore, expand,
    boot: async (row, preset, environment) => boot(row, preset, environment as ConfigValues),
  });

  await syncStore();

  for (const type of builtinTypes) {
    if (!types.has(type.id)) types.set(type.id, type);
  }

  ctx.component.dashboard.addEntry({
    id: "instances",
    dev: fileURLToPath(new URL("../frontend/index.tsx", import.meta.url)),
    prod: fileURLToPath(new URL("../dist/frontend/instances.js", import.meta.url)),
    plugin: "instances",
  });
}

export default apply;
