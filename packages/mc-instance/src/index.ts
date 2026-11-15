import { Context, Logger, Schema } from "yumeri";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "@mirelia/dashboard";
import type {
  Instance, InstanceCreateRequest, InstanceCreation, InstanceProvisioner, InstanceRuntime, InstanceService, InstanceTypeDefinition,
} from "@jpgpanel/server-instances";
import "@jpgpanel/server-instances";

export const depend = ["database", "instances"];
export const provide: string[] = [];

declare module "@yumerijs/types" {
  interface Tables {
    mc_configs: MinecraftConfig;
    mc_eula: MinecraftEula;
  }
}

export interface MinecraftConfig {
  id?: number;
  instance_id: string;
  server_type: string;
  version: string;
  memory_mb: number;
  port: number;
  motd: string;
  max_players: number;
  online_mode: boolean;
  difficulty: string;
  view_distance: number;
  pvp: boolean;
  enforce_whitelist: boolean;
  updated_at: string;
}

export interface MinecraftEula {
  id?: number;
  instance_id: string;
  accepted: boolean;
  accepted_by: number;
  accepted_at: string;
}

export interface MinecraftConfigValues {
  serverType: "vanilla" | "paper" | "fabric";
  version: string;
  memoryMb: number;
  port: number;
  motd: string;
  maxPlayers: number;
  onlineMode: boolean;
  difficulty: "peaceful" | "easy" | "normal" | "hard";
  viewDistance: number;
  pvp: boolean;
  enforceWhitelist: boolean;
}

export interface MinecraftConfigPatch {
  server_type?: string;
  version?: string;
  memory_mb?: number;
  port?: number;
  motd?: string;
  max_players?: number;
  online_mode?: boolean;
  difficulty?: string;
  view_distance?: number;
  pvp?: boolean;
  enforce_whitelist?: boolean;
}

export interface MinecraftConfigInput {
  runtime: { cwd: string; exists(file: string): boolean; read(file: string): string | undefined; write(file: string, content: string): string };
}

const logger = new Logger("mc-instance");
const DEFAULT_VERSION = "1.21.4";
const VANILLA_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const PAPER_API = "https://fill.papermc.io/v3/projects/paper";

export const config: Schema<{ handshakeTimeoutMs: number }> = Schema.object({
  handshakeTimeoutMs: Schema.number("How long to wait for the Minecraft handshake before declaring the server ready").key("mc-instance.handshakeTimeoutMs").default(180000),
});

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Escape a Java properties value. */
function escapeProperties(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/:/g, "\\:").replace(/=/g, "\\=");
}

function serverProperties(config: MinecraftConfigValues) {
  return [
    `motd=${escapeProperties(config.motd)}`,
    `server-port=${config.port}`,
    `max-players=${config.maxPlayers}`,
    `online-mode=${config.onlineMode}`,
    `difficulty=${config.difficulty}`,
    `view-distance=${config.viewDistance}`,
    `pvp=${config.pvp}`,
    `enforce-whitelist=${config.enforceWhitelist}`,
    "enable-command-block=true",
    "spawn-protection=16",
    "white-list=false",
  ].join("\n") + "\n";
}

/** Parse server.properties back into the panel's shape. */
export function parseProperties(text: string) {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=:\s]+)\s*[=:]\s*(.*)$/);
    if (match) values.set(match[1], match[2].replace(/\\:/g, ":").replace(/\\=/g, "="));
  }
  return values;
}

export function configFromProperties(values: Map<string, string>, base: MinecraftConfig): MinecraftConfigValues {
  const number = (key: string, fallback: number) => { const parsed = Number(values.get(key)); return Number.isFinite(parsed) ? parsed : fallback; };
  return {
    serverType: (base.server_type as MinecraftConfigValues["serverType"]) ?? "vanilla",
    version: base.version || DEFAULT_VERSION,
    memoryMb: base.memory_mb || 2048,
    port: number("server-port", base.port || 25565),
    motd: values.get("motd") ?? base.motd ?? "Mirelia Minecraft server",
    maxPlayers: number("max-players", base.max_players || 20),
    onlineMode: values.get("online-mode") !== "false",
    difficulty: (values.get("difficulty") as MinecraftConfigValues["difficulty"]) ?? "normal",
    viewDistance: number("view-distance", base.view_distance || 10),
    pvp: values.get("pvp") !== "false",
    enforceWhitelist: values.get("enforce-whitelist") === "true",
  };
}

export function normalizedConfig(patch: MinecraftConfigPatch, current: MinecraftConfigValues): MinecraftConfigValues {
  const next = { ...current };
  if (patch.motd !== undefined) next.motd = String(patch.motd).slice(0, 59);
  if (patch.max_players !== undefined) next.maxPlayers = Math.max(1, Math.min(1000, Math.trunc(Number(patch.max_players))));
  if (patch.online_mode !== undefined) next.onlineMode = patch.online_mode === true || (patch.online_mode as unknown) === "true";
  if (patch.pvp !== undefined) next.pvp = patch.pvp === true || (patch.pvp as unknown) === "true";
  if (patch.enforce_whitelist !== undefined) next.enforceWhitelist = patch.enforce_whitelist === true || (patch.enforce_whitelist as unknown) === "true";
  if (patch.difficulty && ["peaceful", "easy", "normal", "hard"].includes(patch.difficulty)) next.difficulty = patch.difficulty as MinecraftConfigValues["difficulty"];
  if (patch.view_distance !== undefined) next.viewDistance = Math.max(2, Math.min(32, Math.trunc(Number(patch.view_distance))));
  if (patch.port !== undefined) next.port = Math.max(1024, Math.min(65535, Math.trunc(Number(patch.port))));
  if (patch.server_type && ["vanilla", "paper", "fabric"].includes(patch.server_type)) next.serverType = patch.server_type as MinecraftConfigValues["serverType"];
  if (patch.version && /^\d+(\.\d+){1,2}(-[a-zA-Z0-9.]+)?$/.test(patch.version)) next.version = patch.version;
  if (patch.memory_mb !== undefined) next.memoryMb = Math.max(256, Math.min(65536, Math.trunc(Number(patch.memory_mb))));
  return next;
}

/**
 * Download the server jar and write the initial configuration.
 * Network failures are logged on the console and reported through the instance
 * attributes, but they do not fail the purchase: the instance stays usable and
 * the server can be (re)installed later.
 */
async function downloadServer(jar: string, type: string, version: string, runtime: MinecraftRuntimeLogger) {
  if (existsSync(jar)) return true;
  mkdirSync(path.dirname(jar), { recursive: true });
  if (type === "paper") {
    // Paper v3 API: builds are newest first and downloads are grouped per platform.
    const builds = await fetch(`${PAPER_API}/versions/${version}/builds`).then((response) => response.ok ? response.json() : undefined).catch(() => undefined) as Array<Record<string, unknown>> | undefined;
    const latest = Array.isArray(builds) ? builds[0] : undefined;
    const download = object(object(latest?.downloads)["server:default"]);
    const url = typeof download.url === "string" ? download.url : "";
    if (!url) throw new Error(`Paper build for ${version} is unavailable`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Paper download failed (${response.status})`);
    writeFileSync(jar, Buffer.from(await response.arrayBuffer()));
    runtime.log(`downloaded Paper ${version} build ${latest?.id ?? "?"}`);
    return true;
  }
  if (type === "fabric") {
    const response = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${version}/latest`);
    const loader = object(await response.json());
    const server = object(loader.server);
    const url = typeof server.url === "string" ? server.url : "";
    if (!url) throw new Error("Fabric loader metadata is unavailable");
    const jarResponse = await fetch(url);
    if (!jarResponse.ok) throw new Error(`Fabric download failed (${jarResponse.status})`);
    writeFileSync(jar, Buffer.from(await jarResponse.arrayBuffer()));
    runtime.log(`downloaded Fabric loader for ${version}`);
    return true;
  }
  const manifest = object(await fetch(VANILLA_MANIFEST).then((response) => response.json()));
  const versions = Array.isArray(manifest.versions) ? manifest.versions as Array<Record<string, unknown>> : [];
  const match = versions.find((entry) => entry.id === version);
  if (!match || typeof match.url !== "string") throw new Error(`Minecraft version ${version} is unavailable`);
  const details = object(await fetch(match.url).then((response) => response.json()));
  const downloads = object(details.downloads);
  const serverJar = object(downloads.server);
  if (typeof serverJar.url !== "string") throw new Error("Mojang does not publish a server jar for this version");
  const jarResponse = await fetch(serverJar.url);
  if (!jarResponse.ok) throw new Error(`Mojang download failed (${jarResponse.status})`);
  writeFileSync(jar, Buffer.from(await jarResponse.arrayBuffer()));
  runtime.log(`downloaded vanilla ${version}`);
  return true;
}

interface MinecraftRuntimeLogger { log(message: string): void }

export async function apply(ctx: Context) {
  const db = ctx.component.database;
  const instances = ctx.component.instances as InstanceService;

  await db.extend("mc_configs", {
    id: { type: "integer", autoIncrement: true }, instance_id: { type: "string", nullable: false },
    server_type: { type: "string", initial: "vanilla", nullable: false }, version: { type: "string", initial: DEFAULT_VERSION, nullable: false },
    memory_mb: { type: "integer", initial: 2048, nullable: false }, port: { type: "integer", initial: 25565, nullable: false },
    motd: { type: "string", initial: "A Minecraft Server", nullable: false }, max_players: { type: "integer", initial: 20, nullable: false },
    online_mode: { type: "boolean", initial: true, nullable: false }, difficulty: { type: "string", initial: "normal", nullable: false },
    view_distance: { type: "integer", initial: 10, nullable: false }, pvp: { type: "boolean", initial: true, nullable: false },
    enforce_whitelist: { type: "boolean", initial: false, nullable: false }, updated_at: { type: "timestamp", nullable: false },
  }, { unique: ["instance_id"] });
  await db.extend("mc_eula", {
    id: { type: "integer", autoIncrement: true }, instance_id: { type: "string", nullable: false },
    accepted: { type: "boolean", initial: false, nullable: false }, accepted_by: { type: "integer", initial: 0, nullable: false },
    accepted_at: { type: "timestamp", initial: "", nullable: false },
  }, { unique: ["instance_id"] });

  const serverDir = (provisioner: InstanceProvisioner) => path.join(provisioner.directory, "server");
  const configPath = (provisioner: InstanceProvisioner) => path.join(provisioner.directory, "config", "mc.json");

  function readRuntime(provisioner: InstanceProvisioner) {
    const file = configPath(provisioner);
    if (!existsSync(file)) return undefined;
    try { return object(JSON.parse(readFileSync(file, "utf8"))); } catch { return undefined; }
  }

  async function currentConfig(instance: Instance): Promise<MinecraftConfigValues> {
    const row = await db.selectOne("mc_configs", { instance_id: instance.instance_id }) as MinecraftConfig | undefined;
    const directory = path.join(process.cwd(), "data", "instances", instance.instance_id);
    const propertiesFile = path.join(directory, "server", "server.properties");
    const base: MinecraftConfig = row ?? {
      instance_id: instance.instance_id, server_type: "vanilla", version: DEFAULT_VERSION, memory_mb: Math.max(1024, instance.memory_mb),
      port: instance.port || 25565, motd: "A Minecraft Server", max_players: 20, online_mode: true, difficulty: "normal",
      view_distance: 10, pvp: true, enforce_whitelist: false, updated_at: new Date().toISOString(),
    };
    if (existsSync(propertiesFile)) {
      const values = parseProperties(readFileSync(propertiesFile, "utf8"));
      return configFromProperties(new Map([...values].map(([key, value]) => [key, value])), base);
    }
    return configFromProperties(new Map(), base);
  }

  /** Write configuration to both the rows and the server's server.properties. */
  async function writeConfig(instance: Instance, values: MinecraftConfigValues, actorId = 0) {
    const now = new Date().toISOString();
    const existing = await db.selectOne("mc_configs", { instance_id: instance.instance_id }) as MinecraftConfig | undefined;
    const row = {
      instance_id: instance.instance_id, server_type: values.serverType, version: values.version, memory_mb: values.memoryMb,
      port: values.port, motd: values.motd, max_players: values.maxPlayers, online_mode: values.onlineMode, difficulty: values.difficulty,
      view_distance: values.viewDistance, pvp: values.pvp, enforce_whitelist: values.enforceWhitelist, updated_at: now,
    };
    if (existing) await db.update("mc_configs", { id: existing.id }, row);
    else await db.create("mc_configs", row);
    const server = path.join(process.cwd(), "data", "instances", instance.instance_id, "server");
    if (!existsSync(server)) mkdirSync(server, { recursive: true });
    writeFileSync(path.join(server, "server.properties"), serverProperties(values));
    void actorId;
    return currentConfig(instance);
  }

  async function jarPath(type: string, version: string, directory: string) {
    const prefix = type === "paper" ? "paper" : type === "fabric" ? "fabric" : "vanilla";
    return path.join(directory, "server", `${prefix}-${version}.jar`);
  }

  async function startVanilla(instance: Instance, provisioner: InstanceProvisioner, jar: string, memory: number) {
    provisioner.runtime.start(["java", `-Xms${Math.max(256, Math.floor(memory / 2))}M`, `-Xmx${memory}M`, "-jar", path.basename(jar), "nogui"], serverDir(provisioner));
    await waitForHandshake(instance.instance_id, provisioner.runtime, 180_000);
  }

  const type: InstanceTypeDefinition = {
    id: "minecraft",
    name: "Minecraft server",
    pluginId: "mc-instance",
    description: "Paper, Fabric or vanilla Minecraft servers with a web console, quick configuration and EULA handling.",
    offer: {
      id: "minecraft",
      name: "Minecraft server",
      summary: "Managed Minecraft server with console, quick configuration and versions",
      provider: "mc-instance",
      priceCents: 2000,
      period: "month",
      spec: { cpu: 2, memoryMb: 2048, diskGb: 20 },
      sortOrder: 20,
      highlights: ["Paper / Fabric / Vanilla", "Web console", "Quick configuration"],
      options: [
        { key: "edition", label: "Server software", type: "select", required: true, default: "paper", options: [
          { value: "paper", label: "Paper", description: "Optimised, plugin friendly" },
          { value: "vanilla", label: "Vanilla", description: "Official Mojang server" },
          { value: "fabric", label: "Fabric", description: "Mod loader" },
        ] },
        { key: "version", label: "Minecraft version", type: "text", required: true, default: DEFAULT_VERSION },
      ],
    },

    async create(request: InstanceCreateRequest, provisioner: InstanceProvisioner): Promise<InstanceCreation> {
      const serverType = ["paper", "vanilla", "fabric"].includes(String(request.selections.edition)) ? String(request.selections.edition) : "paper";
      const version = /^\d+(\.\d+){1,2}(-[a-zA-Z0-9.]+)?$/.test(String(request.selections.version ?? "")) ? String(request.selections.version) : DEFAULT_VERSION;
      const directory = provisioner.directory;
      mkdirSync(path.join(directory, "server"), { recursive: true });
      mkdirSync(path.join(directory, "snapshots"), { recursive: true });
      mkdirSync(path.join(directory, "config"), { recursive: true });
      const port = 25565;
      const memory = Math.max(1024, request.spec.memoryMb > 0 ? Math.min(request.spec.memoryMb, 32768) : 2048);
      const values: MinecraftConfigValues = {
        serverType: serverType as MinecraftConfigValues["serverType"], version, memoryMb: memory, port,
        motd: "Mirelia Minecraft server", maxPlayers: 20, onlineMode: true, difficulty: "normal", viewDistance: 10, pvp: true, enforceWhitelist: false,
      };
      writeFileSync(path.join(directory, "server", "server.properties"), serverProperties(values));
      writeFileSync(path.join(directory, "server", "eula.txt"), "eula=false\n");
      writeFileSync(configPath(provisioner), JSON.stringify({ edition: serverType, version }, null, 2));
      const now = new Date().toISOString();
      await db.create("mc_configs", {
        instance_id: provisioner.runtime.instanceId, server_type: serverType, version, memory_mb: memory, port, motd: values.motd,
        max_players: 20, online_mode: true, difficulty: "normal", view_distance: 10, pvp: true, enforce_whitelist: false, updated_at: now,
      }).catch(() => undefined);
      await db.create("mc_eula", { instance_id: provisioner.runtime.instanceId, accepted: false, accepted_by: 0, accepted_at: "" }).catch(() => undefined);

      let jarReady = false;
      let effectiveType = serverType;
      try {
        provisioner.runtime.pushLine("system", `preparing ${serverType} ${version}`);
        jarReady = await downloadServer(await jarPath(serverType, version, directory), serverType, version, { log: (message) => logger.info(`${provisioner.runtime.instanceId}: ${message}`) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        provisioner.runtime.pushLine("stderr", `${serverType} download failed: ${message}`);
        if (serverType !== "vanilla") {
          try {
            // Paper/Fabric may lag behind a brand new Minecraft release; the vanilla jar always exists.
            provisioner.runtime.pushLine("system", "falling back to the official vanilla server jar");
            jarReady = await downloadServer(await jarPath("vanilla", version, directory), "vanilla", version, { log: (message) => logger.info(`${provisioner.runtime.instanceId}: ${message}`) });
            if (jarReady) effectiveType = "vanilla";
          } catch (fallbackError) {
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            provisioner.runtime.pushLine("stderr", `vanilla download failed: ${fallbackMessage}`);
          }
        }
        if (!jarReady) await provisioner.progress({ jarReady: false, jarError: message }, `server jar download failed: ${message}`);
      }
      if (jarReady && effectiveType !== serverType) {
        await db.update("mc_configs", { instance_id: provisioner.runtime.instanceId }, { server_type: effectiveType, updated_at: new Date().toISOString() }).catch(() => undefined);
        await provisioner.progress({ jarReady: true, serverType: effectiveType, version }, `server files ready (vanilla ${version}, ${serverType} unavailable)`);
      } else if (jarReady) {
        await provisioner.progress({ jarReady: true, serverType, version }, `server files ready (${serverType} ${version})`);
      }
      return {
        id: `mc_${provisioner.runtime.instanceId}`, name: `Minecraft ${effectiveType} ${version}`, port,
        attributes: { edition: effectiveType, requestedEdition: serverType, version, jarReady, eulaAccepted: false },
      };
    },

    async start(instance: Instance, provisioner: InstanceProvisioner) {
      const eula = await db.selectOne("mc_eula", { instance_id: instance.instance_id }) as MinecraftEula | undefined;
      if (!eula?.accepted) throw new Error("Minecraft EULA has not been accepted for this instance");
      const values = await currentConfig(instance);
      const directory = provisioner.directory;
      const memory = Math.min(values.memoryMb, Math.max(512, instance.memory_mb));
      const jar = await jarPath(values.serverType, values.version, directory);
      if (!existsSync(jar)) {
        try { await downloadServer(jar, values.serverType, values.version, { log: (message) => logger.info(`${instance.instance_id}: ${message}`) }); }
        catch (error) {
          if (values.serverType === "vanilla") throw new Error(`server jar is missing and could not be downloaded: ${error instanceof Error ? error.message : String(error)}`);
          // e.g. a new Paper build lagging behind the Mojang jar it patches: fall back to vanilla.
          const vanilla = await jarPath("vanilla", values.version, directory);
          await downloadServer(vanilla, "vanilla", values.version, { log: (message) => logger.info(`${instance.instance_id}: ${message}`) });
          provisioner.runtime.pushLine("system", `${values.serverType} is unavailable for ${values.version}; starting the vanilla server instead`);
          await db.update("mc_configs", { instance_id: instance.instance_id }, { server_type: "vanilla", updated_at: new Date().toISOString() }).catch(() => undefined);
          return startVanilla(instance, provisioner, vanilla, memory);
        }
      }
      await startVanilla(instance, provisioner, jar, memory);
      await db.update("mc_configs", { instance_id: instance.instance_id }, { memory_mb: memory, updated_at: new Date().toISOString() }).catch(() => undefined);
    },

    async stop(_instance: Instance, provisioner: InstanceProvisioner) {
      const running = provisioner.runtime.running;
      if (!running) return;
      try { provisioner.runtime.write("stop"); } catch { /* stdin may already be closed. */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { provisioner.runtime.stop(10_000); resolve(); }, 30_000);
        const unsubscribe = provisioner.runtime.subscribe((line) => {
          if (/Closing Server|Stopping server/i.test(line.text)) { clearTimeout(timer); unsubscribe(); resolve(); }
        });
      });
    },

    routes: [
      {
        method: "GET" as const, path: "config",
        async handle(session, _user, instance) {
          const config = await currentConfig(instance);
          const eula = await db.selectOne("mc_eula", { instance_id: instance.instance_id }) as MinecraftEula | undefined;
          session.respond({ config, eulaAccepted: Boolean(eula?.accepted) }, "json");
        },
      },
      {
        method: "PUT" as const, path: "config",
        async handle(session, user, instance, body) {
          const current = await currentConfig(instance);
          const next = normalizedConfig(body as MinecraftConfigPatch, current);
          const saved = await writeConfig(instance, next, user.id ?? 0);
          await instances.recordEvent(instance.instance_id, "configured", `configuration updated by ${user.username}`, user);
          session.respond({ config: saved }, "json");
        },
      },
      {
        method: "POST" as const, path: "eula",
        async handle(session, user, instance, body) {
          const accepted = body.accept !== false;
          const now = new Date().toISOString();
          const existing = await db.selectOne("mc_eula", { instance_id: instance.instance_id }) as MinecraftEula | undefined;
          if (existing) await db.update("mc_eula", { id: existing.id }, { accepted, accepted_by: user.id ?? 0, accepted_at: accepted ? now : "" });
          else await db.create("mc_eula", { instance_id: instance.instance_id, accepted, accepted_by: user.id ?? 0, accepted_at: accepted ? now : "" });
          const server = path.join(process.cwd(), "data", "instances", instance.instance_id, "server");
          if (!existsSync(server)) mkdirSync(server, { recursive: true });
          writeFileSync(path.join(server, "eula.txt"), `eula=${accepted ? "true" : "false"}\n`);
          await instances.recordEvent(instance.instance_id, "configured", `EULA ${accepted ? "accepted" : "rejected"} by ${user.username}`, user);
          session.respond({ accepted }, "json");
        },
      },
      {
        method: "POST" as const, path: "reinstall",
        async handle(session, _user, instance) {
          const values = await currentConfig(instance);
          const directory = path.join(process.cwd(), "data", "instances", instance.instance_id);
          const jar = await jarPath(values.serverType, values.version, directory);
          try { await downloadServer(jar, values.serverType, values.version, { log: (message) => logger.info(`${instance.instance_id}: ${message}`) }); }
          catch (error) { session.status = 502; session.respond({ error: error instanceof Error ? error.message : String(error) }, "json"); return; }
          session.respond({ ok: true }, "json");
        },
      },
    ],
  };

  instances.registerType(type);

  ctx.i18n({ cloud: { mc: {
    eulaTitle: { zh: "Minecraft 最终用户许可协议", en: "Minecraft EULA", ja: "Minecraft EULA" },
    eulaHint: { zh: "Minecraft 要求您同意 Mojang 的 EULA 之后才能启动服务器。", en: "Minecraft requires accepting the Mojang EULA before the server can start.", ja: "サーバーを起動するには Mojang EULA への同意が必要です。" },
    eulaAccept: { zh: "我已阅读并同意 EULA", en: "I have read and accept the EULA", ja: "EULA を読み、同意します" },
    eulaLink: { zh: "查看 EULA", en: "Read the EULA", ja: "EULA を読む" },
    eulaAccepted: { zh: "已同意 EULA", en: "EULA accepted", ja: "EULA 同意済み" },
    eulaRequired: { zh: "接受 EULA 后才能启动服务器。", en: "Accept the EULA to start the server.", ja: "EULA に同意するとサーバーを起動できます。" },
    quickConfig: { zh: "快速配置", en: "Quick configuration", ja: "クイック設定" },
    quickConfigHint: { zh: "修改后点击保存会立即写入 server.properties，重启后生效。", en: "Saving writes server.properties immediately; restart the server to apply.", ja: "保存すると server.properties が更新されます。再起動で反映されます。" },
    software: { zh: "服务端", en: "Server software", ja: "サーバーソフト" },
    version: { zh: "版本", en: "Version", ja: "バージョン" },
    motd: { zh: "MOTD（服务器简介）", en: "MOTD", ja: "MOTD" },
    maxPlayers: { zh: "最大玩家数", en: "Max players", ja: "最大プレイヤー数" },
    difficulty: { zh: "难度", en: "Difficulty", ja: "難易度" },
    viewDistance: { zh: "视距", en: "View distance", ja: "描画距離" },
    memory: { zh: "分配内存（MB）", en: "Allocated memory (MB)", ja: "割り当てメモリ（MB）" },
    onlineMode: { zh: "正版验证", en: "Online mode", ja: "オンラインモード" },
    pvp: { zh: "允许 PvP", en: "Allow PvP", ja: "PvP を許可" },
    whitelist: { zh: "强制白名单", en: "Enforce whitelist", ja: "ホワイトリストを強制" },
    save: { zh: "保存配置", en: "Save configuration", ja: "設定を保存" },
    saving: { zh: "保存中…", en: "Saving…", ja: "保存中…" },
    saved: { zh: "配置已保存，重启服务器后生效。", en: "Configuration saved. Restart the server to apply.", ja: "設定を保存しました。再起動で反映されます。" },
    reinstall: { zh: "重新下载服务端", en: "Re-download server", ja: "サーバーを再取得" },
    reinstallHint: { zh: "服务端文件缺失或损坏时可重新下载。", en: "Download the server jar again if it is missing or broken.", ja: "サーバーファイルが欠損している場合に再取得します。" },
    difficulties: { peaceful: { zh: "和平", en: "Peaceful", ja: "ピースフル" }, easy: { zh: "简单", en: "Easy", ja: "イージー" }, normal: { zh: "普通", en: "Normal", ja: "ノーマル" }, hard: { zh: "困难", en: "Hard", ja: "ハード" } },
  } } });

  // The type panel is served by server-instances' bundle through the `instance:minecraft` slot.
  void fileURLToPath;
}

/** Poll the console for the vanilla ready message (Done (x.xxxs)! For help, type "help"). */
async function waitForHandshake(instanceId: string, runtime: InstanceRuntime, timeoutMs: number) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearInterval(timer);
      if (error) reject(error); else resolve();
    };
    const unsubscribe = runtime.subscribe((line) => {
      if (/Done \([\d.]+s\)!/.test(line.text)) finish();
      if (/Failed to start|Exception in thread "main"/.test(line.text)) finish(new Error("Minecraft server failed to start"));
    });
    const timer = setInterval(() => {
      if (!runtime.running) finish(new Error("Minecraft server exited during startup"));
      else if (Date.now() - started > timeoutMs) finish(new Error(`Minecraft server did not become ready within ${Math.round(timeoutMs / 1000)}s (${instanceId})`));
    }, 1000);
  });
}

export default apply;
