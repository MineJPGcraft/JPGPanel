import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Logger, Schema, Session } from "yumeri";
import type { User } from "@mirelia/user";
import type { ProjectService } from "@mirelia/project";
import type { StoreFieldOption, StoreService } from "@mirelia/store";
import "@mirelia/dashboard";
import "@mirelia/project";
import "@mirelia/store";
import "@mirelia/user";
import {
  config as contractConfig, depend, provide,
  type Instance, type InstanceConfig, type InstanceCreation, type InstanceEventRow, type InstanceEventType,
  type InstanceOption, type InstancePowerState, type InstanceProvisioner, type InstanceRow, type InstanceService,
  type InstanceSpec, type InstanceSpecView, type InstanceConfigSchema, type InstanceConfigValues,
  type InstanceTypeDefinition, type InstanceTypeView,
} from "./contract.js";
import {
  InstanceRuntime, existsSync, fileSize, listFiles, mkdirSync, readFileSync, safePath, statSync, writeFileSync,
} from "./runtime.js";
import { applyPatch, ConfigError, mergeConfig } from "./config.js";

export { depend, provide };
export const config: Schema<InstanceConfig> = contractConfig;
export type {
  Instance, InstanceConfig, InstanceCreation, InstanceEventRow, InstanceEventType, InstanceOption, InstancePowerState,
  InstanceCreateRequest, InstanceProvisioner, InstanceRow, InstanceService, InstanceSpec, InstanceSpecView,
  InstanceConfigField, InstanceConfigSchema, InstanceConfigSection, InstanceConfigValues, InstanceFileTrack,
  InstanceDownloadSource, InstanceRemoteFile, InstanceTypeDefinition, InstanceTypeOffer, InstanceTypeView, TerminalLine,
} from "./contract.js";
export { mergeConfig, schemaDefaults } from "./config.js";
export type { InstanceRuntime } from "./runtime.js";

const logger = new Logger("server-instances");

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function hostId() { return `srv_${randomBytes(5).toString("hex")}`; }
function slugify(value: string) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48); }
function defaultRuntime(): InstanceConfig { return { publicUrl: "http://localhost:3001", terminalBufferLines: 500, defaultGraceMs: 10_000 }; }

/** Wrap a type definition for the public views without leaking hooks. */
function publicType(type: InstanceTypeDefinition, specs: InstanceSpecView[]): InstanceTypeView {
  return {
    id: type.id, name: type.name, description: type.description, pluginId: type.pluginId, offer: type.offer,
    configSchema: type.configSchema, files: type.files ?? [],
    downloadSources: (type.downloads ?? []).map((source) => ({ id: source.id, title: source.title })),
    routeCount: type.routes?.length ?? 0, specs,
  };
}

function decorate(row: InstanceRow, spec?: InstanceSpec, config: InstanceConfigValues = {}): Instance {
  let attributes: Record<string, unknown> = {};
  try { const parsed = JSON.parse(row.attributes_json || "{}"); attributes = object(parsed); } catch { attributes = {}; }
  return { ...row, attributes, config, spec };
}

export async function apply(ctx: Context, pluginConfig: InstanceConfig = defaultRuntime()) {
  const settings = { ...defaultRuntime(), ...pluginConfig };
  const db = ctx.component.database;
  const users = ctx.component.user;
  const projectService = ctx.component.project as ProjectService;
  const store = ctx.component.store as StoreService;
  const root = path.resolve(process.cwd(), "data", "instances");

  /* ---------------------------------------------------------------- *
   * Tables.
   * ---------------------------------------------------------------- */
  await db.extend("instances", {
    id: { type: "integer", autoIncrement: true },
    instance_id: { type: "string", nullable: false },
    tenant_id: { type: "integer", nullable: false },
    project_id: { type: "integer", nullable: false },
    owner_user_id: { type: "integer", nullable: false },
    spec_id: { type: "integer", initial: 0, nullable: false },
    type_id: { type: "string", nullable: false },
    plugin_id: { type: "string", nullable: false },
    name: { type: "string", nullable: false },
    provider_ref: { type: "string", initial: "", nullable: false },
    status: { type: "string", initial: "stopped", nullable: false },
    health: { type: "string", initial: "unknown", nullable: false },
    cpu: { type: "integer", initial: 1, nullable: false },
    memory_mb: { type: "integer", initial: 1024, nullable: false },
    disk_gb: { type: "integer", initial: 10, nullable: false },
    port: { type: "integer", initial: 0, nullable: false },
    attributes_json: { type: "text", initial: "{}", nullable: false },
    config_json: { type: "text", initial: "{}", nullable: false },
    order_id: { type: "string", initial: "", nullable: false },
    last_error: { type: "string", initial: "", nullable: false },
    started_at: { type: "timestamp", initial: "", nullable: false },
    stopped_at: { type: "timestamp", initial: "", nullable: false },
    created_at: { type: "timestamp", nullable: false },
    updated_at: { type: "timestamp", nullable: false },
  }, { unique: ["instance_id"] });
  await db.extend("instance_specs", {
    id: { type: "integer", autoIncrement: true },
    slug: { type: "string", nullable: false },
    type_id: { type: "string", nullable: false },
    name: { type: "string", nullable: false },
    cpu: { type: "integer", initial: 1, nullable: false },
    memory_mb: { type: "integer", initial: 1024, nullable: false },
    disk_gb: { type: "integer", initial: 10, nullable: false },
    price_cents: { type: "integer", initial: 0, nullable: false },
    enabled: { type: "boolean", initial: true, nullable: false },
    description: { type: "text", initial: "", nullable: false },
    created_at: { type: "timestamp", nullable: false },
    updated_at: { type: "timestamp", nullable: false },
  }, { unique: ["slug"] });
  await db.extend("instance_events", {
    id: { type: "integer", autoIncrement: true },
    instance_id: { type: "string", nullable: false },
    event_type: { type: "string", nullable: false },
    message: { type: "text", initial: "", nullable: false },
    actor_user_id: { type: "integer", initial: 0, nullable: false },
    created_at: { type: "timestamp", nullable: false },
  });

  const types = new Map<string, InstanceTypeDefinition>();
  const runtimes = new Map<string, InstanceRuntime>();
  ctx.affect(() => { for (const runtime of runtimes.values()) runtime.dispose(); runtimes.clear(); });

  function runtimeFor(instance: InstanceRow) {
    let runtime = runtimes.get(instance.instance_id);
    if (!runtime) {
      runtime = new InstanceRuntime(instance.instance_id, path.join(root, instance.instance_id), settings.terminalBufferLines);
      runtimes.set(instance.instance_id, runtime);
    }
    return runtime;
  }

  function provisionerFor(instance: InstanceRow): InstanceProvisioner {
    const runtime = runtimeFor(instance);
    return {
      runtime,
      directory: path.join(root, instance.instance_id),
      progress: async (attributes, message) => {
        const merged = { ...JSON.parse(instance.attributes_json || "{}"), ...attributes };
        instance.attributes_json = JSON.stringify(merged);
        await db.update("instances", { id: instance.id }, { attributes_json: instance.attributes_json, updated_at: new Date().toISOString() });
        if (message) await service.recordEvent(instance.instance_id, "configured", message);
      },
    };
  }

  /* ---------------------------------------------------------------- *
   * Specs: the administrator defines sizing and price, the store sells it.
   * ---------------------------------------------------------------- */
  async function specs(): Promise<InstanceSpec[]> {
    return (await db.select("instance_specs", {}) as InstanceSpec[]).sort((a, b) => a.cpu - b.cpu || a.price_cents - b.price_cents);
  }

  async function specView(spec: InstanceSpec): Promise<InstanceSpecView> {
    const instances = await db.select("instances", { spec_id: spec.id! }) as InstanceRow[];
    return { ...spec, instances: instances.length };
  }

  /** Push every enabled spec into the store as a product of its instance type. */
  let storeSyncGeneration = 0;
  async function syncStore() {
    const generation = ++storeSyncGeneration;
    const list = (await specs()).filter((spec) => Boolean(spec.enabled) && types.has(spec.type_id));
    const byType = new Map<string, InstanceSpec[]>();
    for (const spec of list) {
      const group = byType.get(spec.type_id) ?? [];
      group.push(spec);
      byType.set(spec.type_id, group);
    }
    for (const [typeId, group] of byType) {
      const type = types.get(typeId);
      if (!type) continue;
      if (generation !== storeSyncGeneration) return;
      const cheapest = group.reduce((best, spec) => spec.price_cents < best.price_cents ? spec : best, group[0]);
      try {
        store.registerProduct("server-instances", {
          id: `type-${typeId}`,
          name: type.offer.name,
          summary: type.offer.summary ?? `${group.length} spec${group.length === 1 ? "" : "s"} available`,
          description: type.description ?? "",
          provider: type.offer.provider ?? type.pluginId,
          category: "server",
          priceCents: cheapest.price_cents,
          period: type.offer.period ?? "month",
          quantity: "fixed",
          sortOrder: type.offer.sortOrder ?? 50,
          repeatable: type.offer.repeatable !== false,
          popular: type.offer.popular === true,
          highlights: type.offer.highlights ?? [],
          price: (selections) => {
            const chosen = group.find((spec) => String(spec.id) === String(selections.spec));
            return chosen?.price_cents ?? cheapest.price_cents;
          },
          fields: [
            {
              key: "spec", label: "Specification", required: true,
              options: group.map((spec) => ({
                value: String(spec.id),
                label: spec.name,
                description: `${spec.cpu} vCPU · ${spec.memory_mb} MB RAM${spec.disk_gb ? ` · ${spec.disk_gb} GB disk` : ""}`,
              })),
            },
            ...(type.offer.options ?? []).map((option) => ({
              key: option.key, label: option.label, type: option.type, required: option.required !== false,
              options: option.type === "select"
                ? (option.options ?? []).map((choice) => ({ value: choice.value, label: choice.label, description: choice.description, disabled: choice.disabled }))
                : undefined,
            })),
          ],
        });
      } catch (error) {
        logger.warn(`Could not publish instance type ${typeId} to the store: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function typeOf(row: InstanceRow) { return types.get(row.type_id); }

  function parseConfig(row: InstanceRow): InstanceConfigValues {
    try {
      const parsed = JSON.parse(row.config_json || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as InstanceConfigValues : {};
    } catch { return {}; }
  }

  /** Stored configuration merged over the type's schema defaults. */
  async function storedConfig(row: InstanceRow) {
    const definition = typeOf(row);
    return definition ? mergeConfig(definition.configSchema, parseConfig(row)) : parseConfig(row);
  }

  const service: InstanceService = {
    registerType(definition) {
      const id = String(definition.id ?? "").trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]{1,39}$/.test(id)) throw new Error(`Invalid instance type id: ${definition.id}`);
      if (!definition.offer || !Number.isSafeInteger(definition.offer.priceCents) || definition.offer.priceCents < 0) {
        throw new Error(`Instance type ${id} needs an integer offer price in cents`);
      }
      const existing = types.get(id);
      if (existing && existing.pluginId !== definition.pluginId) throw new Error(`Instance type ${id} is already registered by ${existing.pluginId}`);
      types.set(id, { ...definition, id });
      void syncStore().catch((error) => logger.error(`Store sync failed: ${error instanceof Error ? error.message : String(error)}`));
      logger.info(`Registered instance type ${id} from ${definition.pluginId}`);
      const remove = () => { if (types.get(id) === definition || types.get(id)?.pluginId === definition.pluginId) types.delete(id); };
      ctx.affect(remove);
      return remove;
    },

    listTypes() { return [...types.values()].map((type) => publicType(type, [])); },
    findType(typeId) { const type = types.get(typeId); return type ? publicType(type, []) : undefined; },

    async listSpecs() {
      const list = await specs();
      return Promise.all(list.map(specView));
    },
    async createSpec(input) {
      const type = types.get(String(input.type_id ?? "").trim().toLowerCase());
      if (!type) throw new Error("instance_type_missing");
      const name = String(input.name ?? "").trim().slice(0, 80);
      if (!name) throw new Error("instance_spec_name");
      const slug = slugify(String(input.slug ?? name)) || slugify(`${type.id}-${Date.now()}`);
      const now = new Date().toISOString();
      const created = await db.create("instance_specs", {
        slug, type_id: type.id, name,
        cpu: Math.max(1, Math.trunc(Number(input.cpu ?? 1))),
        memory_mb: Math.max(128, Math.trunc(Number(input.memory_mb ?? 1024))),
        disk_gb: Math.max(0, Math.trunc(Number(input.disk_gb ?? 10))),
        price_cents: Math.max(0, Math.trunc(Number(input.price_cents ?? type.offer.priceCents))),
        enabled: input.enabled !== false,
        description: String(input.description ?? "").slice(0, 500),
        created_at: now, updated_at: now,
      }) as InstanceSpec;
      await syncStore();
      return specView(created);
    },
    async updateSpec(id, input) {
      const current = await db.selectOne("instance_specs", { id }) as InstanceSpec | undefined;
      if (!current) throw new Error("instance_spec_missing");
      const updates: Partial<InstanceSpec> = { updated_at: new Date().toISOString() };
      if (typeof input.name === "string" && input.name.trim()) updates.name = input.name.trim().slice(0, 80);
      if (input.cpu !== undefined) updates.cpu = Math.max(1, Math.trunc(Number(input.cpu)));
      if (input.memory_mb !== undefined) updates.memory_mb = Math.max(128, Math.trunc(Number(input.memory_mb)));
      if (input.disk_gb !== undefined) updates.disk_gb = Math.max(0, Math.trunc(Number(input.disk_gb)));
      if (input.price_cents !== undefined) updates.price_cents = Math.max(0, Math.trunc(Number(input.price_cents)));
      if (typeof input.enabled === "boolean") updates.enabled = input.enabled;
      if (typeof input.description === "string") updates.description = input.description.slice(0, 500);
      await db.update("instance_specs", { id }, updates);
      await syncStore();
      return specView({ ...current, ...updates } as InstanceSpec);
    },
    async deleteSpec(id) {
      const used = (await db.select("instances", { spec_id: id }) as InstanceRow[]).length;
      if (used) throw new Error("instance_spec_in_use");
      await db.remove("instance_specs", { id });
      await syncStore();
    },

    async createInstanceForOrder(request) {
      const type = types.get(String(request.selections.type ?? "").trim().toLowerCase()) ?? undefined;
      const spec = await db.selectOne("instance_specs", { id: request.specId }) as InstanceSpec | undefined;
      if (!spec) throw new Error("INSTANCE_SPEC_MISSING");
      const definition = types.get(spec.type_id);
      if (!definition) throw new Error("INSTANCE_TYPE_UNAVAILABLE");
      void type;
      const instanceId = hostId();
      const now = new Date().toISOString();
      const row = await db.create("instances", {
        instance_id: instanceId, tenant_id: request.tenantId, project_id: request.project.id, owner_user_id: request.user.id!,
        spec_id: spec.id!, type_id: spec.type_id, plugin_id: definition.pluginId, name: `${definition.name} ${instanceId.slice(-4)}`,
        provider_ref: "", status: "starting", health: "unknown", cpu: spec.cpu, memory_mb: spec.memory_mb, disk_gb: spec.disk_gb,
        port: 0, attributes_json: JSON.stringify({ selections: request.selections }),
        config_json: JSON.stringify(mergeConfig(definition.configSchema, request.config)), order_id: request.orderKey,
        last_error: "", started_at: "", stopped_at: "", created_at: now, updated_at: now,
      }) as InstanceRow;
      await service.recordEvent(instanceId, "created", `created ${definition.name} with spec ${spec.name}`, request.user);
      const provisioner = provisionerFor(row);
      try {
        const created: InstanceCreation = await definition.create(request, provisioner);
        await db.update("instances", { id: row.id }, {
          name: created.name.slice(0, 120), provider_ref: created.id, port: created.port,
          status: "stopped", attributes_json: JSON.stringify({ ...JSON.parse(row.attributes_json), ...created.attributes }),
          last_error: "", updated_at: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.update("instances", { id: row.id }, { status: "failed", last_error: message.slice(0, 500), updated_at: new Date().toISOString() });
        await service.recordEvent(instanceId, "error", `provisioning failed: ${message}`);
        throw error;
      }
      return (await service.get(instanceId))!;
    },

    async get(instanceId) {
      const row = await db.selectOne("instances", { instance_id: instanceId }) as InstanceRow | undefined;
      if (!row) return undefined;
      const spec = row.spec_id ? await db.selectOne("instance_specs", { id: row.spec_id }) as InstanceSpec | undefined : undefined;
      const runtime = runtimes.get(instanceId);
      const status: InstancePowerState = runtime?.running ? "running" : (row.status === "running" ? "stopped" : row.status);
      return decorate({ ...row, status }, spec, await storedConfig(row));
    },

    async listForUser(user) {
      if (user.id === undefined) return [];
      const rows = (await db.select("instances", { owner_user_id: user.id }) as InstanceRow[]).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const specsById = new Map((await specs()).map((spec) => [spec.id, spec]));
      const output: Instance[] = [];
      for (const row of rows) {
        const runtime = runtimes.get(row.instance_id);
        const status: InstancePowerState = runtime?.running ? "running" : (row.status === "running" ? "stopped" : row.status);
        output.push(decorate({ ...row, status }, row.spec_id ? specsById.get(row.spec_id) : undefined, await storedConfig(row)));
      }
      return output;
    },

    async authorize(session, instanceId, admin = false) {
      const instance = await service.get(instanceId);
      if (!instance) { session.status = 404; session.respond({ error: session.text("instances.errors.notFound") }, "json"); return undefined; }
      const user = await users.current(session);
      if (!user) { session.status = 401; session.respond({ error: session.text("instances.errors.auth") }, "json"); return undefined; }
      if (instance.owner_user_id === user.id || users.isAdmin(user)) return instance;
      const access = await projectService.authorize(session, instance.project_id, "manage_products").catch(() => undefined);
      if (access?.project.id) return instance;
      session.status = 404; session.respond({ error: session.text("instances.errors.notFound") }, "json");
      return undefined;
    },

    async config(instanceId) {
      const row = await db.selectOne("instances", { instance_id: instanceId }) as InstanceRow | undefined;
      const definition = row ? typeOf(row) : undefined;
      if (!row || !definition) return undefined;
      return { schema: definition.configSchema, values: mergeConfig(definition.configSchema, parseConfig(row)) };
    },

    async saveConfig(instanceId, patch, actor) {
      const row = await db.selectOne("instances", { instance_id: instanceId }) as InstanceRow | undefined;
      const definition = row ? typeOf(row) : undefined;
      if (!row || !definition) throw new Error("instance_missing");
      const next = applyPatch(definition.configSchema, mergeConfig(definition.configSchema, parseConfig(row)), patch);
      await db.update("instances", { id: row.id }, { config_json: JSON.stringify(next), updated_at: new Date().toISOString() });
      if (definition.applyConfig) {
        const instance = decorate({ ...row, config_json: JSON.stringify(next) }, undefined, next);
        await definition.applyConfig(instance, next, provisionerFor(row));
      }
      await service.recordEvent(instanceId, "configured", `configuration saved by ${actor?.username ?? "system"}`, actor);
      return next;
    },

    async events(instanceId, limit = 50) {
      const rows = await db.select("instance_events", { instance_id: instanceId }) as InstanceEventRow[];
      return rows.sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).slice(0, Math.max(1, Math.min(limit, 200)));
    },

    async recordEvent(instanceId, type, message, actor) {
      await db.create("instance_events", {
        instance_id: instanceId, event_type: type, message: message.slice(0, 2000), actor_user_id: actor?.id ?? 0,
        created_at: new Date().toISOString(),
      });
    },

    async power(instanceId, action, actor) {
      const instance = await service.get(instanceId);
      if (!instance) throw new Error("instance_missing");
      const definition = types.get(instance.type_id);
      if (!definition) throw new Error("INSTANCE_TYPE_UNAVAILABLE");
      const row = await db.selectOne("instances", { instance_id: instanceId }) as InstanceRow;
      const provisioner = provisionerFor(row);
      const now = new Date().toISOString();
      if (action === "start") {
        await db.update("instances", { id: row.id }, { status: "starting", last_error: "", updated_at: now });
        await service.recordEvent(instanceId, "start", `start requested by ${actor?.username ?? "system"}`, actor);
        try {
          if (definition.start) await definition.start(instance, provisioner);
          else throw new Error("instance type cannot be started");
          const runtime = runtimes.get(instance.instance_id);
          if (runtime && !runtime.running) throw new Error("instance process exited during startup, see the console");
          await db.update("instances", { id: row.id }, { status: "running", started_at: now, last_error: "", updated_at: now });
          await definition.onPower?.(instance, "running");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await db.update("instances", { id: row.id }, { status: "failed", last_error: message.slice(0, 500), updated_at: new Date().toISOString() });
          await service.recordEvent(instanceId, "error", `start failed: ${message}`, actor);
          throw error;
        }
      } else {
        await db.update("instances", { id: row.id }, { status: "stopping", updated_at: now });
        await service.recordEvent(instanceId, "stop", `stop requested by ${actor?.username ?? "system"}`, actor);
        if (definition.stop) await definition.stop(instance, provisioner);
        else provisioner.runtime.stop(settings.defaultGraceMs);
        await db.update("instances", { id: row.id }, { status: "stopped", stopped_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        await definition.onPower?.(instance, "stopped");
      }
      return (await service.get(instanceId))!;
    },
  };

  ctx.registerComponent("instances", service);

  /* ---------------------------------------------------------------- *
   * Provisioning through the store: the buyer checks out, an instance appears.
   * ---------------------------------------------------------------- */
  store.registerPurchaseHandler("server-instances", async (request) => {
    const specId = Number(request.selections.spec);
    const spec = await db.selectOne("instance_specs", { id: specId }) as InstanceSpec | undefined;
    if (!spec) throw new Error("INSTANCE_SPEC_MISSING");
    const definition = types.get(spec.type_id);
    if (!definition) throw new Error("INSTANCE_TYPE_UNAVAILABLE");
    const selections: Record<string, string | number | boolean> = {};
    for (const option of definition.offer.options ?? []) {
      const raw = request.selections[option.key];
      if (raw === undefined || raw === "") {
        if (option.required !== false) throw new Error(`INSTANCE_OPTION_MISSING:${option.key}`);
        continue;
      }
      selections[option.key] = option.type === "number" ? Number(raw) : option.type === "boolean" ? raw === "true" : raw;
    }
    const instance = await service.createInstanceForOrder({
      user: request.user, tenantId: request.tenant.id!, project: request.project, selections, config: selections,
      specId, spec: { cpu: spec.cpu, memoryMb: spec.memory_mb, diskGb: spec.disk_gb }, orderKey: request.idempotencyKey,
    });
    return {
      name: instance.name, resourceId: instance.instance_id, status: instance.status,
      attributes: {
        instanceId: instance.instance_id, type: spec.type_id, spec: spec.name,
        cpu: spec.cpu, memoryMb: spec.memory_mb, diskGb: spec.disk_gb, ...instance.attributes,
      },
    };
  });
  ctx.affect(() => { storeSyncGeneration += 1; });

  /* ---------------------------------------------------------------- *
   * HTTP API.
   * ---------------------------------------------------------------- */
  function fail(session: Session, status: number, key: string, extra: Record<string, unknown> = {}) {
    session.status = status;
    session.respond({ error: session.text(key), ...extra }, "json");
  }

  ctx.route("/api/instances/types").methods("GET").action(async (session) => {
    const user = await users.current(session);
    if (!user) return fail(session, 401, "instances.errors.auth");
    session.respond({ types: service.listTypes() }, "json");
  });

  ctx.route("/api/instances").methods("GET").action(async (session) => {
    const user = await users.current(session);
    if (!user) return fail(session, 401, "instances.errors.auth");
    session.respond({ instances: await service.listForUser(user), types: service.listTypes() }, "json");
  });

  ctx.route("/api/instances/:id").methods("GET").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const type = types.get(instance.type_id);
    session.respond({
      instance,
      type: type ? publicType(type, []) : undefined,
      events: await service.events(id),
      endpoints: type?.routes?.map((route) => ({ method: route.method, path: `/api/instances/${id}/type/${route.path}` })) ?? [],
    }, "json");
  });

  ctx.route("/api/instances/:id/power").methods("POST").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const body = object(await session.parseRequestBody());
    const action = body.action === "stop" ? "stop" : body.action === "start" ? "start" : "";
    if (!action) return fail(session, 400, "instances.errors.action");
    const user = await users.current(session);
    try {
      const updated = await service.power(id, action, user);
      session.respond({ instance: updated }, "json");
    } catch (error) {
      fail(session, 502, "instances.errors.power", { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Configuration of the instance, merged over the type's schema defaults. */
  ctx.route("/api/instances/:id/config").methods("GET").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const config = await service.config(id);
    if (!config) return fail(session, 404, "instances.errors.notFound");
    session.respond({ ...config, summary: typeOf(instance as InstanceRow)?.describe?.(instance, config.values) ?? "" }, "json");
  });

  ctx.route("/api/instances/:id/config").methods("PUT").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const user = await users.current(session);
    const patch = object(await session.parseRequestBody());
    try {
      const values = await service.saveConfig(id, patch as InstanceConfigValues, user);
      session.respond({ values, summary: typeOf(instance as InstanceRow)?.describe?.(instance, values) ?? "" }, "json");
    } catch (error) {
      if (error instanceof ConfigError) { fail(session, 400, "instances.errors.config", { issues: error.issues }); return; }
      fail(session, 400, "instances.errors.config", { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Files the instance type tracks, shown in the file manager. */
  ctx.route("/api/instances/:id/files").methods("GET").action(async (session, query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const definition = typeOf(instance as InstanceRow);
    if (!definition) return fail(session, 404, "instances.errors.notFound");
    const requested = query.get("path");
    const directory = path.join(root, instance.instance_id);
    if (!requested) {
      const tracked = (definition.files ?? []).map((file) => ({
        ...file, exists: existsSync(path.join(directory, file.path)), size: fileSize(path.join(directory, file.path)),
      }));
      const entries = listFiles(directory).slice(0, 200);
      session.respond({ tracked, entries }, "json");
      return;
    }
    const resolved = safePath(directory, requested);
    if (!resolved) return fail(session, 400, "instances.errors.file");
    if (!existsSync(resolved) || statSync(resolved).isDirectory()) return fail(session, 404, "instances.errors.file");
    if (statSync(resolved).size > 2 * 1024 * 1024) return fail(session, 413, "instances.errors.fileTooLarge");
    session.respond({ path: requested, content: readFileSync(resolved, "utf8"), size: statSync(resolved).size }, "json");
  });

  ctx.route("/api/instances/:id/files").methods("PUT").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const definition = typeOf(instance as InstanceRow);
    const body = object(await session.parseRequestBody());
    const requested = String(body.path ?? "");
    const tracked = definition?.files?.find((file) => file.path === requested);
    if (!tracked?.writable) return fail(session, 403, "instances.errors.fileReadOnly");
    const directory = path.join(root, instance.instance_id);
    const resolved = safePath(directory, requested);
    if (!resolved) return fail(session, 400, "instances.errors.file");
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, String(body.content ?? "").slice(0, 2 * 1024 * 1024));
    await service.recordEvent(id, "configured", `edited ${requested}`, await users.current(session));
    session.respond({ ok: true, size: statSync(resolved).size }, "json");
  });

  /** Remote files (server jars, mods, plugins) the type can list and download. */
  ctx.route("/api/instances/:id/downloads").methods("GET").action(async (session, query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const definition = typeOf(instance as InstanceRow);
    const source = definition?.downloads?.find((entry) => entry.id === query.get("source"));
    if (!source) return fail(session, 404, "instances.errors.notFound");
    try { session.respond({ files: await source.list(instance) }, "json"); }
    catch (error) { fail(session, 502, "instances.errors.download", { detail: error instanceof Error ? error.message : String(error) }); }
  });

  ctx.route("/api/instances/:id/downloads").methods("POST").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const definition = typeOf(instance as InstanceRow);
    const body = object(await session.parseRequestBody());
    const source = definition?.downloads?.find((entry) => entry.id === body.source);
    if (!source) return fail(session, 404, "instances.errors.notFound");
    try {
      const files = await source.list(instance);
      const selected = files.find((file) => file.name === body.name);
      if (!selected) return fail(session, 404, "instances.errors.file");
      const row = await db.selectOne("instances", { instance_id: id }) as InstanceRow;
      const provisioner = provisionerFor(row);
      provisioner.runtime.pushLine("system", `downloading ${selected.name}`);
      const response = await fetch(selected.url);
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const target = safePath(path.join(root, id), String(body.target ?? `server/${selected.name}`).replace(/^\/+/, ""));
      if (!target) throw new Error("invalid target path");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      await service.recordEvent(id, "configured", `downloaded ${selected.name}`, await users.current(session));
      session.respond({ ok: true, name: selected.name }, "json");
    } catch (error) {
      fail(session, 502, "instances.errors.download", { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  ctx.route("/api/instances/:id/terminal").methods("POST").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const body = object(await session.parseRequestBody());
    const command = String(body.command ?? "").trim();
    if (!command) return fail(session, 400, "instances.errors.action");
    const runtime = runtimeFor(instance);
    const definition = typeOf(instance as InstanceRow);
    const [name, ...rest] = command.split(/\s+/);
    const interceptor = definition?.commands?.find((entry) => entry.name === name.toLowerCase());
    const user = await users.current(session);
    if (interceptor && user) {
      // Instance types may answer console commands themselves (backup, whitelist …).
      try {
        const output = await interceptor.run(instance, rest.join(" "), user, provisionerFor(await db.selectOne("instances", { instance_id: id }) as InstanceRow));
        runtime.pushLine("system", `> ${command}`);
        if (output) runtime.pushLine("system", output);
        session.respond({ ok: true, handled: true, output: output ?? "" }, "json");
        return;
      } catch (error) {
        fail(session, 409, "instances.errors.command", { detail: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    try {
      runtime.write(command.slice(0, 2000));
      session.respond({ ok: true }, "json");
    } catch {
      fail(session, 409, "instances.errors.terminalStopped");
    }
  });

  ctx.route("/api/instances/:id/console").methods("GET").action(async (session, query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const after = Number(query.get("after") ?? 0);
    const runtime = runtimeFor(instance);
    session.respond({ lines: runtime.tail(Number.isFinite(after) ? after : 0), running: runtime.running }, "json");
  });

  /** Server-sent events: the browser keeps one connection and receives console lines. */
  ctx.route("/api/instances/:id/console/stream").methods("GET").action(async (session, query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const runtime = runtimeFor(instance);
    const response = session.client.res;
    if (!response) return fail(session, 500, "instances.errors.console");
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    for (const line of runtime.tail(Number(query.get("after") ?? 0) || 0)) send(line);
    const unsubscribe = runtime.subscribe(send);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    const close = () => { clearInterval(heartbeat); unsubscribe(); response.end(); };
    session.client.req?.on("close", close);
  });

  /* Administrator: specs. */
  async function requireAdmin(session: Session) { return users.requireAdmin(session); }

  ctx.route("/api/instances/admin/specs").methods("GET").action(async (session) => {
    if (!await requireAdmin(session)) return;
    session.respond({ specs: await service.listSpecs(), types: service.listTypes() }, "json");
  });
  ctx.route("/api/instances/admin/specs").methods("POST").action(async (session) => {
    if (!await requireAdmin(session)) return;
    try {
      const spec = await service.createSpec(object(await session.parseRequestBody()) as Partial<InstanceSpec>);
      session.status = 201;
      session.respond({ spec }, "json");
    } catch (error) {
      fail(session, 400, "instances.errors.spec", { detail: error instanceof Error ? error.message : String(error) });
    }
  });
  ctx.route("/api/instances/admin/specs/:id").methods("PUT").action(async (session, _query, id) => {
    if (!await requireAdmin(session)) return;
    try {
      session.respond({ spec: await service.updateSpec(Number(id), object(await session.parseRequestBody()) as Partial<InstanceSpec>) }, "json");
    } catch {
      fail(session, 400, "instances.errors.spec");
    }
  });
  ctx.route("/api/instances/admin/specs/:id").methods("DELETE").action(async (session, _query, id) => {
    if (!await requireAdmin(session)) return;
    try { await service.deleteSpec(Number(id)); session.respond({ ok: true }, "json"); }
    catch { fail(session, 409, "instances.errors.specInUse"); }
  });
  ctx.route("/api/instances/admin/instances").methods("GET").action(async (session) => {
    if (!await requireAdmin(session)) return;
    const rows = await db.select("instances", {}) as InstanceRow[];
    session.respond({ instances: rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).map((row) => decorate(row)) }, "json");
  });

  /* Instance types may mount extra endpoints, for example Minecraft world settings. */
  function typeRoutes(type: InstanceTypeDefinition) {
    for (const route of type.routes ?? []) {
      const relative = route.path.replace(/^\/+/, "");
      ctx.route(`/api/instances/:id/type/${relative}`).methods(route.method).action(async (session, query, id) => {
        const instance = await service.authorize(session, id);
        if (!instance) return;
        if (instance.type_id !== type.id) return fail(session, 404, "instances.errors.notFound");
        const user = await users.current(session);
        if (!user) return fail(session, 401, "instances.errors.auth");
        const body = route.method === "GET" || route.method === "DELETE" ? {} : object(await session.parseRequestBody());
        const row = await db.selectOne("instances", { instance_id: instance.instance_id }) as InstanceRow;
        await route.handle(session, user, instance, body, query, provisionerFor(row));
      });
    }
  }

  /** Late registration support: types registered after this plugin resolved are mounted on first use. */
  const mounted = new Set<string>();
  function mountPending() {
    for (const [id, type] of types) {
      if (mounted.has(id) || !type.routes?.length) continue;
      mounted.add(id);
      typeRoutes(type);
    }
  }
  ctx.setInterval(mountPending, 2000);
  mountPending();

  void syncStore().catch(() => undefined);

  ctx.i18n({ cloud: { instances: {
    nav: { section: { zh: "实例", en: "Instances", ja: "インスタンス" }, instances: { zh: "我的实例", en: "Instances", ja: "インスタンス" }, specs: { zh: "实例规格", en: "Specifications", ja: "インスタンス仕様" } },
    title: { zh: "我的实例", en: "My instances", ja: "インスタンス一覧" },
    description: { zh: "管理分配给您的服务器实例：启动、停止、查看终端与配置。", en: "Manage the server instances assigned to you: start, stop, open the terminal and configure them.", ja: "割り当てられたサーバーインスタンスを管理します：起動、停止、ターミナル、設定。" },
    empty: { zh: "还没有实例，先到商城购买一个吧。", en: "No instances yet. Buy one from the store first.", ja: "インスタンスはまだありません。ストアで購入してください。" },
    browse: { zh: "前往商城", en: "Browse store", ja: "ストアへ" },
    loading: { zh: "正在加载实例…", en: "Loading instances…", ja: "インスタンスを読み込み中…" },
    unassigned: { zh: "未分配", en: "Unassigned", ja: "未割り当て" },
    status: { running: { zh: "运行中", en: "Running", ja: "稼働中" }, stopped: { zh: "已停止", en: "Stopped", ja: "停止中" }, starting: { zh: "启动中", en: "Starting", ja: "起動中" }, stopping: { zh: "停止中", en: "Stopping", ja: "停止処理中" }, failed: { zh: "异常", en: "Failed", ja: "異常" } },
    start: { zh: "启动", en: "Start", ja: "起動" },
    stop: { zh: "停止", en: "Stop", ja: "停止" },
    open: { zh: "打开控制台", en: "Open console", ja: "コンソールを開く" },
    spec: { zh: "规格", en: "Specification", ja: "仕様" },
    type: { zh: "类型", en: "Type", ja: "種類" },
    project: { zh: "项目", en: "Project", ja: "プロジェクト" },
    created: { zh: "创建于", en: "Created", ja: "作成日" },
    detail: {
      back: { zh: "返回实例列表", en: "Back to instances", ja: "インスタンス一覧に戻る" },
      overview: { zh: "概览", en: "Overview", ja: "概要" },
      console: { zh: "终端", en: "Terminal", ja: "ターミナル" },
      activity: { zh: "操作记录", en: "Activity", ja: "操作履歴" },
      connect: { zh: "连接地址", en: "Address", ja: "接続先" },
      commandPlaceholder: { zh: "输入命令并按回车，例如 stop", en: "Type a command and press enter, e.g. stop", ja: "コマンドを入力して Enter（例: stop）" },
      send: { zh: "发送", en: "Send", ja: "送信" },
      clear: { zh: "清空", en: "Clear", ja: "クリア" },
      stoppedHint: { zh: "实例已停止，启动后可输入命令。", en: "The instance is stopped. Start it to send commands.", ja: "インスタンスは停止中です。起動するとコマンドを送信できます。" },
      noLines: { zh: "暂无输出", en: "No output yet", ja: "出力はありません" },
      lastError: { zh: "最近错误", en: "Last error", ja: "最新のエラー" },
    },
    admin: {
      title: { zh: "实例规格", en: "Instance specifications", ja: "インスタンス仕様" },
      description: { zh: "定义实例规格（核数、内存、磁盘与价格），启用的规格会自动上架到商城。", en: "Define instance specifications (CPU, memory, disk and price). Enabled specifications are published to the store automatically.", ja: "仕様（CPU、メモリ、ディスク、価格）を定義します。有効な仕様は自動的にストアへ出品されます。" },
      newSpec: { zh: "新建规格", en: "New specification", ja: "仕様を作成" },
      editSpec: { zh: "编辑规格", en: "Edit specification", ja: "仕様を編集" },
      type: { zh: "实例类型", en: "Instance type", ja: "インスタンス種別" },
      name: { zh: "规格名称", en: "Name", ja: "仕様名" },
      cpu: { zh: "CPU 核心数", en: "CPU cores", ja: "CPU コア数" },
      memory: { zh: "内存（MB）", en: "Memory (MB)", ja: "メモリ（MB）" },
      disk: { zh: "磁盘（GB）", en: "Disk (GB)", ja: "ディスク（GB）" },
      price: { zh: "每月价格（元）", en: "Price per month (CNY)", ja: "月額（CNY）" },
      descriptionField: { zh: "说明", en: "Description", ja: "説明" },
      enabled: { zh: "已上架", en: "Published", ja: "出品中" },
      disabled: { zh: "已下架", en: "Hidden", ja: "非公開" },
      instances: { zh: "实例数", en: "Instances", ja: "インスタンス数" },
      delete: { zh: "删除", en: "Delete", ja: "削除" },
      noTypes: { zh: "还没有插件注册实例类型。", en: "No plugin has registered an instance type yet.", ja: "インスタンス種別を登録したプラグインはありません。" },
      empty: { zh: "还没有规格", en: "No specifications yet", ja: "仕様はまだありません" },
      saved: { zh: "规格已保存", en: "Specification saved", ja: "仕様を保存しました" },
      instancesTitle: { zh: "全部实例", en: "All instances", ja: "すべてのインスタンス" },
    },
    config: {
      title: { zh: "配置", en: "Configuration", ja: "設定" },
      changed: { zh: "已修改", en: "Changed", ja: "変更あり" },
      description: { zh: "保存后会写入实例配置，重启服务器后生效。", en: "Saving writes the instance configuration; restart the server to apply it.", ja: "保存すると設定が書き込まれます。再起動で反映されます。" },
      save: { zh: "保存配置", en: "Save configuration", ja: "設定を保存" },
      saved: { zh: "配置已保存", en: "Configuration saved", ja: "設定を保存しました" },
      search: { zh: "搜索配置项", en: "Search settings", ja: "設定を検索" },
    },
    files: {
      title: { zh: "文件", en: "Files", ja: "ファイル" },
      description: { zh: "实例目录中的文件。受管文件可直接编辑。", en: "Files inside the instance directory. Managed files are editable.", ja: "インスタンスディレクトリ内のファイルです。管理対象ファイルは編集できます。" },
      tracked: { zh: "受管文件", en: "Managed files", ja: "管理対象ファイル" },
      missing: { zh: "未生成", en: "Not created yet", ja: "未生成" },
      empty: { zh: "目录为空", en: "The directory is empty", ja: "ディレクトリは空です" },
      save: { zh: "保存文件", en: "Save file", ja: "ファイルを保存" },
      saved: { zh: "文件已保存", en: "File saved", ja: "ファイルを保存しました" },
      readOnly: { zh: "该文件为只读", en: "This file is read-only", ja: "このファイルは読み取り専用です" },
      tooLarge: { zh: "文件过大，无法在面板中编辑", en: "The file is too large to edit in the panel", ja: "ファイルが大きすぎて編集できません" },
    },
    downloads: {
      title: { zh: "下载", en: "Downloads", ja: "ダウンロード" },
      description: { zh: "从上游获取服务端、模组或插件文件。", en: "Fetch server, mod or plugin files from upstream.", ja: "サーバー、MOD、プラグインを取得します。" },
      install: { zh: "下载到实例", en: "Download", ja: "ダウンロード" },
      installing: { zh: "正在下载…", en: "Downloading…", ja: "ダウンロード中…" },
      empty: { zh: "没有可下载的文件", en: "No files available", ja: "ダウンロードできるファイルはありません" },
      done: { zh: "下载完成", en: "Download complete", ja: "ダウンロード完了" },
    },
    errors: {
      auth: { zh: "请先登录", en: "Authentication is required", ja: "ログインしてください" },
      config: { zh: "配置无效", en: "Invalid configuration", ja: "設定が無効です" },
      file: { zh: "文件不存在或路径无效", en: "The file does not exist or the path is invalid", ja: "ファイルが存在しないかパスが無効です" },
      fileReadOnly: { zh: "该文件不允许在面板中修改", en: "This file cannot be edited in the panel", ja: "このファイルはパネルから変更できません" },
      fileTooLarge: { zh: "文件过大", en: "The file is too large", ja: "ファイルが大きすぎます" },
      download: { zh: "下载失败", en: "The download failed", ja: "ダウンロードに失敗しました" },
      command: { zh: "命令执行失败", en: "The command failed", ja: "コマンドの実行に失敗しました" },
      notFound: { zh: "实例不存在或无权访问", en: "Instance not found or access denied", ja: "インスタンスが存在しないか権限がありません" },
      action: { zh: "请求无效", en: "Invalid request", ja: "リクエストが無効です" },
      power: { zh: "实例操作失败", en: "The instance operation failed", ja: "インスタンス操作に失敗しました" },
      terminalStopped: { zh: "实例已停止，无法发送命令", en: "The instance is stopped; commands cannot be sent", ja: "インスタンスは停止中のためコマンドを送信できません" },
      console: { zh: "无法打开终端", en: "Could not open the terminal", ja: "ターミナルを開けません" },
      spec: { zh: "规格数据无效", en: "Invalid specification", ja: "仕様データが無効です" },
      specInUse: { zh: "该规格已有实例，不能删除", en: "This specification is used by instances and cannot be deleted", ja: "この仕様は使用中のため削除できません" },
    },
  } } });

  ctx.component.dashboard.addEntry({
    id: "instances",
    dev: fileURLToPath(new URL("../frontend/index.tsx", import.meta.url)),
    prod: fileURLToPath(new URL("../dist/frontend/instances.js", import.meta.url)),
    plugin: "instances",
  });
}

export default apply;
