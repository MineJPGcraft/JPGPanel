import type { Context, Session } from "yumeri";
import type { InstanceService, InstanceConfig } from "./contract.js";
import type { DockerDriver } from "./docker.js";
import type { expand as expandParams } from "./index.js";

interface RouteDeps {
  db: any;
  users: any;
  docker: DockerDriver;
  service: InstanceService;
  settings: InstanceConfig;
  dataRoot: string;
  presetView: (preset: any, withGroup?: boolean) => Promise<any>;
  presetById: (id: number) => Promise<any>;
  boot: (row: any, preset: any, environment: Record<string, unknown>) => Promise<string>;
  groupView: (group: any) => Promise<any>;
  syncStore: () => Promise<void>;
  expand: typeof expandParams;
}

/**
 * Every endpoint of the instance panel: type/group/preset/spec administration, the
 * instance list and pages, container power control, log console and the exec terminal.
 */
export function mountRoutes(ctx: Context, deps: RouteDeps) {
  const { db, users, docker, service, presetById, boot } = deps;
  const admin = () => users.requireAdmin;

  function fail(session: Session, status: number, key: string, extra: Record<string, unknown> = {}) {
    session.status = status;
    session.respond({ error: session.text(`cloud.instances.errors.${key}`), ...extra }, "json");
  }

  async function requireAdmin(session: Session) {
    return users.requireAdmin(session);
  }

  /* ------------------------------ catalogue ------------------------------ */
  ctx.route("/api/instances/types").methods("GET").action(async (session) => {
    if (!await users.current(session)) return fail(session, 401, "auth");
    const types = await service.listTypes();
    const groups = await service.listGroups();
    const presets = await service.listPresets();
    const specs = await service.listSpecs();
    session.respond({ types, groups, presets, specs }, "json");
  });

  ctx.route("/api/instances/docker/status").methods("GET").action(async (session) => {
    if (!await requireAdmin(session)) return;
    const reachable = await docker.ping();
    session.respond({ reachable, socket: deps.settings.dockerSocket }, "json");
  });

  ctx.route("/api/instances/admin/groups").methods("GET").action(async (session) => {
    if (!await requireAdmin(session)) return;
    session.respond({ groups: await service.listGroups() }, "json");
  });
  ctx.route("/api/instances/admin/groups").methods("POST").action(async (session) => {
    if (!await requireAdmin(session)) return;
    try { const group = await service.createGroup(await session.parseRequestBody() as never); session.status = 201; session.respond({ group }, "json"); }
    catch (error) { fail(session, 400, "group", { detail: error instanceof Error ? error.message : String(error) }); }
  });
  ctx.route("/api/instances/admin/groups/:id").methods("PUT").action(async (session, _query, id) => {
    if (!await requireAdmin(session)) return;
    try { session.respond({ group: await service.updateGroup(Number(id), await session.parseRequestBody() as never) }, "json"); }
    catch (error) { fail(session, 400, "group", { detail: error instanceof Error ? error.message : String(error) }); }
  });
  ctx.route("/api/instances/admin/groups/:id").methods("DELETE").action(async (session, _query, id) => {
    if (!await requireAdmin(session)) return;
    try { await service.deleteGroup(Number(id)); session.respond({ ok: true }, "json"); }
    catch { fail(session, 409, "groupInUse"); }
  });

  /* ------------------------------ presets ------------------------------ */
  ctx.route("/api/instances/admin/presets").methods("GET").action(async (session, query) => {
    if (!await requireAdmin(session)) return;
    const groupId = Number(query.get("groupId") ?? 0);
    session.respond({ presets: await service.listPresets(groupId || undefined) }, "json");
  });
  ctx.route("/api/instances/admin/presets").methods("POST").action(async (session) => {
    if (!await requireAdmin(session)) return;
    try { const preset = await service.createPreset(await session.parseRequestBody() as never); session.status = 201; session.respond({ preset }, "json"); }
    catch (error) { fail(session, 400, "preset", { detail: error instanceof Error ? error.message : String(error) }); }
  });
  ctx.route("/api/instances/admin/presets/:id").methods("GET").action(async (session, _query, id) => {
    if (!await requireAdmin(session)) return;
    const preset = await presetById(Number(id));
    if (!preset) return fail(session, 404, "notFound");
    session.respond({ preset }, "json");
  });
  ctx.route("/api/instances/admin/presets/:id").methods("PUT").action(async (session, _query, id) => {
    if (!await requireAdmin(session)) return;
    try { session.respond({ preset: await service.updatePreset(Number(id), await session.parseRequestBody() as never) }, "json"); }
    catch (error) { fail(session, 400, "preset", { detail: error instanceof Error ? error.message : String(error) }); }
  });
  ctx.route("/api/instances/admin/presets/:id").methods("DELETE").action(async (session, _query, id) => {
    if (!await requireAdmin(session)) return;
    try { await service.deletePreset(Number(id)); session.respond({ ok: true }, "json"); }
    catch { fail(session, 409, "presetInUse"); }
  });

  /* ------------------------------ specs ------------------------------ */
  ctx.route("/api/instances/admin/specs").methods("GET").action(async (session) => {
    if (!await requireAdmin(session)) return;
    session.respond({ specs: await service.listSpecs(), groups: await service.listGroups(), presets: await service.listPresets() }, "json");
  });
  ctx.route("/api/instances/admin/specs").methods("POST").action(async (session) => {
    if (!await requireAdmin(session)) return;
    try { const spec = await service.createSpec(await session.parseRequestBody() as never); session.status = 201; session.respond({ spec }, "json"); }
    catch (error) { fail(session, 400, "spec", { detail: error instanceof Error ? error.message : String(error) }); }
  });
  ctx.route("/api/instances/admin/specs/:id").methods("PUT").action(async (session, _query, id) => {
    if (!await requireAdmin(session)) return;
    try { session.respond({ spec: await service.updateSpec(Number(id), await session.parseRequestBody() as never) }, "json"); }
    catch (error) { fail(session, 400, "spec", { detail: error instanceof Error ? error.message : String(error) }); }
  });
  ctx.route("/api/instances/admin/specs/:id").methods("DELETE").action(async (session, _query, id) => {
    if (!await requireAdmin(session)) return;
    try { await service.deleteSpec(Number(id)); session.respond({ ok: true }, "json"); }
    catch { fail(session, 409, "specInUse"); }
  });

  /* ------------------------------ instances ------------------------------ */
  ctx.route("/api/instances").methods("GET").action(async (session) => {
    const user = await users.current(session);
    if (!user) return fail(session, 401, "auth");
    session.respond({ instances: await service.listForUser(user), presets: await service.listPresets(), specs: await service.listSpecs() }, "json");
  });

  ctx.route("/api/projects/:id/instances").methods("GET").action(async (session, _query, id) => {
    const instance = await service.authorize(session, String(id)) ?? undefined;
    void instance;
    session.respond({ instances: await service.listForProject(Number(id)) }, "json");
  });

  ctx.route("/api/instances/:id").methods("GET").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    session.respond({ instance, preset: instance.preset, events: await service.events(id) }, "json");
  });

  ctx.route("/api/instances/:id/power").methods("POST").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const body = (await session.parseRequestBody()) as Record<string, unknown>;
    const user = await users.current(session);
    try {
      if (body.action === "stop") session.respond({ instance: await service.stop(id, user) }, "json");
      else if (body.action === "start") session.respond({ instance: await service.start(id, user) }, "json");
      else fail(session, 400, "action");
    } catch (error) { fail(session, 502, "boot", { detail: error instanceof Error ? error.message : String(error) }); }
  });

  ctx.route("/api/instances/:id").methods("DELETE").action(async (session, query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    try { await service.remove(id, await users.current(session), query.get("data") === "1"); session.respond({ ok: true }, "json"); }
    catch (error) { fail(session, 502, "boot", { detail: error instanceof Error ? error.message : String(error) }); }
  });

  ctx.route("/api/instances/:id/recreate").methods("POST").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const preset = await presetById(instance.preset_id);
    if (!preset) return fail(session, 404, "notFound");
    const row = await db.selectOne("instances", { instance_id: id });
    try {
      await boot({ ...row, container_id: "" }, preset, instance.params);
      session.respond({ instance: await service.get(id) }, "json");
    } catch (error) { fail(session, 502, "boot", { detail: error instanceof Error ? error.message : String(error) }); }
  });

  /* ------------------------------ logs ------------------------------ */
  ctx.route("/api/instances/:id/logs").methods("GET").action(async (session, query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    if (!instance.container_id) { session.respond({ logs: "" }, "json"); return; }
    const logs = await docker.logs(instance.container_id, Math.min(2000, Number(query.get("tail") ?? 300)) || 300);
    session.respond({ logs }, "json");
  });

  ctx.route("/api/instances/:id/logs/stream").methods("GET").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const response = session.client.res;
    if (!response) return fail(session, 500, "console");
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    session.responseHandled = true;
    let last = "";
    const push = async () => {
      if (!instance.container_id) return;
      const logs = await docker.logs(instance.container_id, 400).catch(() => "");
      if (logs.length > last.length) { response.write(`data: ${JSON.stringify({ data: logs.slice(last.length) })}\n\n`); last = logs; }
    };
    await push();
    const timer = setInterval(() => { void push(); }, 2000);
    const close = () => { clearInterval(timer); response.end(); };
    session.client.req?.on("close", close);
  });

  /* ------------------------------ terminal ------------------------------ */
  ctx.route("/api/instances/:id/terminal").methods("POST").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    if (!instance.container_id) return fail(session, 409, "terminalStopped");
    const body = (await session.parseRequestBody()) as Record<string, unknown>;
    const shell = String(body.shell ?? "/bin/sh");
    const terminalId = `tty_${Math.random().toString(16).slice(2, 10)}`;
    const listeners = terminalSessions.get(id) ?? new Map();
    try {
      const sessionHandle = await docker.attachExec(instance.container_id, ["-it", shell].slice(1), (chunk) => {
        for (const listener of listeners.values()) listener(chunk);
      });
      terminalSessions.set(id, listeners);
      listeners.set(terminalId, () => undefined);
      terminals.set(terminalId, { write: sessionHandle.write, close: sessionHandle.close });
      session.respond({ terminalId, shell }, "json");
    } catch (error) { fail(session, 502, "console", { detail: error instanceof Error ? error.message : String(error) }); }
  });

  ctx.route("/api/instances/:id/terminal/input").methods("POST").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const body = (await session.parseRequestBody()) as Record<string, unknown>;
    const terminal = terminals.get(String(body.terminalId ?? ""));
    if (!terminal) return fail(session, 409, "terminalStopped");
    terminal.write(String(body.data ?? "").slice(0, 8192));
    session.respond({ ok: true }, "json");
  });

  ctx.route("/api/instances/:id/terminal/output").methods("GET").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const response = session.client.res;
    if (!response) return fail(session, 500, "console");
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    session.responseHandled = true;
    const listeners = terminalSessions.get(id) ?? new Map();
    terminalSessions.set(id, listeners);
    const key = `out_${Math.random().toString(16).slice(2, 10)}`;
    listeners.set(key, (chunk: string) => response.write(`data: ${JSON.stringify({ data: chunk })}\n\n`));
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    const close = () => { clearInterval(heartbeat); listeners.delete(key); response.end(); };
    session.client.req?.on("close", close);
  });

  ctx.route("/api/instances/:id/terminal/close").methods("POST").action(async (session, _query, id) => {
    const instance = await service.authorize(session, id);
    if (!instance) return;
    const body = (await session.parseRequestBody()) as Record<string, unknown>;
    const terminalId = String(body.terminalId ?? "");
    terminals.get(terminalId)?.close();
    terminals.delete(terminalId);
    session.respond({ ok: true }, "json");
  });

  void admin;
  void presetById;
  void boot;
}

const terminalSessions = new Map<string, Map<string, (chunk: string) => void>>();
const terminals = new Map<string, { write(data: string): void; close(): void }>();
