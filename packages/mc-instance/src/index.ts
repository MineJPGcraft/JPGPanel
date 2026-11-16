import { Context, Logger, Schema } from "yumeri";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "@mirelia/dashboard";
import type {
  Instance, InstanceConfigSchema, InstanceConfigValues, InstanceCreateRequest, InstanceCreation,
  InstanceDownloadSource, InstanceProvisioner, InstanceRuntime, InstanceService, InstanceTypeDefinition, InstanceVariant,
} from "@jpgpanel/server-instances";
import { mergeConfig } from "@jpgpanel/server-instances";
import "@jpgpanel/server-instances";

export const depend = ["database", "instances"];
export const provide: string[] = [];

declare module "@yumerijs/types" {
  interface Tables {
    mc_runtime: MinecraftRuntime;
    mc_eula: MinecraftEula;
  }
}

export interface MinecraftRuntime {
  id?: number;
  instance_id: string;
  jar_path: string;
  updated_at: string;
}

export interface MinecraftEula {
  id?: number;
  instance_id: string;
  accepted: boolean;
  accepted_by: number;
  accepted_at: string;
}

const logger = new Logger("mc-instance");
const DEFAULT_VERSION = "1.21.4";
const VANILLA_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const PAPER_API = "https://fill.papermc.io/v3/projects/paper";
const FABRIC_META = "https://meta.fabricmc.net/v2";

export const config: Schema<{ handshakeTimeoutMs: number }> = Schema.object({
  handshakeTimeoutMs: Schema.number("How long to wait for the Minecraft handshake before declaring the server ready").key("mc-instance.handshakeTimeoutMs").default(180000),
});

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function bool(value: unknown, fallback = false) { return typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : fallback; }
function num(value: unknown, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function str(value: unknown, fallback = "") { return typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value); }

/* ------------------------------------------------------------------ *
 * server.properties mapping. Every setting is addressable both by its
 * java-style key (`max-players`) and by the panel's config key.
 * ------------------------------------------------------------------ */

/** Panel config key -> server.properties key. */
const propertyKeys: Record<string, string> = {
  motd: "motd", maxPlayers: "max-players", onlineMode: "online-mode", enforceWhitelist: "enforce-whitelist",
  difficulty: "difficulty", gamemode: "gamemode", forceGamemode: "force-gamemode", hardcore: "hardcore",
  pvp: "pvp", playerIdleTimeout: "player-idle-timeout", allowFlight: "allow-flight", allowNether: "allow-nether",
  spawnMonsters: "spawn-monsters", spawnNpcs: "spawn-npcs", spawnAnimals: "spawn-animals", generateStructures: "generate-structures",
  levelName: "level-name", levelSeed: "level-seed", levelType: "level-type", levelNameFolder: "level-name",
  viewDistance: "view-distance", simulationDistance: "simulation-distance", maxWorldSize: "max-world-size",
  spawnProtection: "spawn-protection", serverPort: "server-port", serverIp: "server-ip", networkCompressionThreshold: "network-compression-threshold",
  rateLimit: "rate-limit", enableStatus: "enable-status", enableQuery: "enable-query", queryPort: "query.port",
  enableRcon: "enable-rcon", rconPort: "rcon.port", rconPassword: "rcon.password", logIps: "log-ips",
  enableCommandBlock: "enable-command-block", opPermissionLevel: "op-permission-level", functionPermissionLevel: "function-permission-level",
  syncChunkWrites: "sync-chunk-writes", maxTickTime: "max-tick-time", whiteList: "white-list", requireResourcePack: "require-resource-pack",
  resourcePack: "resource-pack", resourcePackPrompt: "resource-pack-prompt", resourcePackSha1: "resource-pack-sha1",
  enforceSecureProfile: "enforce-secure-profile", hideOnlinePlayers: "hide-online-players", useNativeTransport: "use-native-transport",
  preventProxyConnections: "prevent-proxy-connections", playerSampling: "player-reporting", pauseWhenEmpty: "pause-when-empty-seconds",
};

function escapeProperty(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/:/g, "\\:").replace(/=/g, "\\=");
}

function renderProperties(block: InstanceConfigValues) {
  const lines: string[] = ["#Minecraft server properties", "#Written by the JPGPanel Minecraft instance type"];
  for (const [key, property] of Object.entries(propertyKeys)) {
    if (!(key in block)) continue;
    const value = block[key];
    lines.push(`${property}=${typeof value === "string" ? escapeProperty(value) : value}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Parse server.properties into panel config keys. */
export function readProperties(text: string) {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=:\s]+)\s*[=:]\s*(.*)$/);
    if (match) values.set(match[1], match[2].replace(/\\:/g, ":").replace(/\\=/g, "="));
  }
  const block: InstanceConfigValues = {};
  for (const [key, property] of Object.entries(propertyKeys)) {
    const raw = values.get(property);
    if (raw === undefined) continue;
    if (raw === "true" || raw === "false") block[key] = raw === "true";
    else if (/^-?\d+$/.test(raw)) block[key] = Number(raw);
    else block[key] = raw;
  }
  return { block, raw: values };
}

/* ------------------------------------------------------------------ *
 * The configuration schema: everything an MCSM-style panel exposes.
 * ------------------------------------------------------------------ */

export const configSchema: InstanceConfigSchema = {
  version: 3,
  sections: [
    {
      id: "server", title: "Server software",
      description: "Which server jar runs and with which JVM.",
      fields: {
        serverType: { type: "enum", title: "Server software", default: "paper", values: [
          { value: "paper", title: "Paper", description: "Optimised Spigot fork, supports plugins" },
          { value: "vanilla", title: "Vanilla", description: "Official Mojang server" },
          { value: "fabric", title: "Fabric", description: "Mod loader" },
          { value: "purpur", title: "Purpur", description: "Paper fork with extra settings" },
          { value: "forge", title: "Forge", description: "Classic mod loader (installer)" },
          { value: "spigot", title: "Spigot", description: "BuildTools required" },
          { value: "custom", title: "Custom jar", description: "Use a jar you uploaded" },
        ] },
        version: { type: "string", title: "Minecraft version", default: DEFAULT_VERSION, pattern: "^[0-9]+(\\.[0-9]+){1,2}(-[A-Za-z0-9.]+)?$" },
        jarFile: { type: "string", title: "Custom jar file", default: "", description: "Used when server software is custom." },
        javaArgs: { type: "string", title: "Extra JVM arguments", default: "-XX:+UseG1GC -XX:+ParallelRefProcEnabled" },
        javaVersion: { type: "enum", title: "Java runtime", default: "auto", values: [
          { value: "auto", title: "Automatic" }, { value: "17", title: "Java 17" }, { value: "21", title: "Java 21" },
        ] },
        memoryMb: { type: "integer", title: "Memory limit (MB)", default: 2048, minimum: 512, maximum: 32768, step: 256 },
        memoryInitialMb: { type: "integer", title: "Initial memory (MB)", default: 1024, minimum: 256, maximum: 32768, step: 256 },
      },
    },
    {
      id: "network", title: "Network",
      fields: {
        serverPort: { type: "integer", title: "Server port", default: 25565, minimum: 1024, maximum: 65535 },
        serverIp: { type: "string", title: "Bind address", default: "", description: "Empty binds every interface." },
        enableStatus: { type: "boolean", title: "Answer status requests", default: true },
        networkCompressionThreshold: { type: "integer", title: "Compression threshold", default: 256, minimum: -1, maximum: 65536 },
        rateLimit: { type: "integer", title: "Packet rate limit", default: 0, minimum: 0, maximum: 10000 },
        enableQuery: { type: "boolean", title: "Enable query protocol", default: false },
        queryPort: { type: "integer", title: "Query port", default: 25565, minimum: 1024, maximum: 65535 },
        enableRcon: { type: "boolean", title: "Enable RCON", default: false },
        rconPort: { type: "integer", title: "RCON port", default: 25575, minimum: 1024, maximum: 65535 },
        rconPassword: { type: "string", title: "RCON password", default: "" },
        preventProxyConnections: { type: "boolean", title: "Block proxy connections", default: false },
        enforceSecureProfile: { type: "boolean", title: "Require secure profiles", default: true },
        useNativeTransport: { type: "boolean", title: "Use native transport", default: true },
        hideOnlinePlayers: { type: "boolean", title: "Hide online players", default: false },
        logIps: { type: "boolean", title: "Log player IPs", default: true },
      },
    },
    {
      id: "gameplay", title: "Gameplay",
      fields: {
        gamemode: { type: "enum", title: "Default game mode", default: "survival", values: [
          { value: "survival", title: "Survival" }, { value: "creative", title: "Creative" },
          { value: "adventure", title: "Adventure" }, { value: "spectator", title: "Spectator" },
        ] },
        forceGamemode: { type: "boolean", title: "Force game mode", default: false },
        hardcore: { type: "boolean", title: "Hardcore", default: false },
        difficulty: { type: "enum", title: "Difficulty", default: "normal", values: [
          { value: "peaceful", title: "Peaceful" }, { value: "easy", title: "Easy" },
          { value: "normal", title: "Normal" }, { value: "hard", title: "Hard" },
        ] },
        pvp: { type: "boolean", title: "Allow PvP", default: true },
        motd: { type: "string", title: "MOTD", default: "A JPGPanel Minecraft server", maxLength: 59 },
        maxPlayers: { type: "integer", title: "Max players", default: 20, minimum: 1, maximum: 1000 },
        onlineMode: { type: "boolean", title: "Online mode (Mojang auth)", default: true },
        allowFlight: { type: "boolean", title: "Allow flight", default: false },
        allowNether: { type: "boolean", title: "Allow the Nether", default: true },
        playerIdleTimeout: { type: "integer", title: "Idle kick (minutes)", default: 0, minimum: 0, maximum: 1440 },
        spawnMonsters: { type: "boolean", title: "Spawn monsters", default: true },
        spawnNpcs: { type: "boolean", title: "Spawn NPCs", default: true },
        spawnAnimals: { type: "boolean", title: "Spawn animals", default: true },
        generateStructures: { type: "boolean", title: "Generate structures", default: true },
        enableCommandBlock: { type: "boolean", title: "Enable command blocks", default: true },
        opPermissionLevel: { type: "integer", title: "Operator permission level", default: 4, minimum: 0, maximum: 4 },
        functionPermissionLevel: { type: "integer", title: "Function permission level", default: 2, minimum: 0, maximum: 4 },
        maxWorldSize: { type: "integer", title: "Max world radius", default: 29999984, minimum: 1, maximum: 29999984 },
      },
    },
    {
      id: "world", title: "World",
      fields: {
        levelName: { type: "string", title: "World folder", default: "world", pattern: "^[A-Za-z0-9_-]+$" },
        levelSeed: { type: "string", title: "Seed", default: "" },
        levelType: { type: "enum", title: "World type", default: "minecraft:normal", values: [
          { value: "minecraft:normal", title: "Normal" }, { value: "minecraft:flat", title: "Flat" },
          { value: "minecraft:large_biomes", title: "Large biomes" }, { value: "minecraft:amplified", title: "Amplified" },
          { value: "minecraft:single_biome_surface", title: "Single biome" },
        ] },
        viewDistance: { type: "integer", title: "View distance", default: 10, minimum: 2, maximum: 32 },
        simulationDistance: { type: "integer", title: "Simulation distance", default: 10, minimum: 2, maximum: 32 },
        spawnProtection: { type: "integer", title: "Spawn protection radius", default: 16, minimum: 0, maximum: 1000 },
        syncChunkWrites: { type: "boolean", title: "Synchronous chunk writes", default: true },
        pauseWhenEmpty: { type: "integer", title: "Pause when empty (seconds)", default: 0, minimum: 0, maximum: 3600 },
        maxTickTime: { type: "integer", title: "Max tick time (ms)", default: 60000, minimum: -1, maximum: 600000 },
        whiteList: { type: "boolean", title: "Whitelist enabled", default: false },
        enforceWhitelist: { type: "boolean", title: "Enforce whitelist", default: false },
        resourcePack: { type: "string", title: "Resource pack URL", default: "" },
        resourcePackPrompt: { type: "string", title: "Resource pack prompt", default: "" },
        resourcePackSha1: { type: "string", title: "Resource pack SHA-1", default: "" },
        requireResourcePack: { type: "boolean", title: "Require resource pack", default: false },
      },
    },
    {
      id: "runtime", title: "Panel runtime",
      description: "How the panel supervises the process.",
      fields: {
        restartOnCrash: { type: "boolean", title: "Restart after a crash", default: true },
        stopCommand: { type: "string", title: "Graceful stop command", default: "stop", maxLength: 32 },
        stopTimeoutSeconds: { type: "integer", title: "Stop timeout (seconds)", default: 30, minimum: 5, maximum: 300 },
        autoStart: { type: "boolean", title: "Start when the instance is created", default: false },
        autoBackupHours: { type: "integer", title: "Automatic backup interval (hours)", default: 0, minimum: 0, maximum: 168, description: "0 disables automatic backups." },
      },
    },
  ],
};

export const files = [
  { path: "server/server.properties", title: "server.properties", config: true, writable: true, language: "properties" as const },
  { path: "server/eula.txt", title: "eula.txt", writable: true, language: "properties" as const },
  { path: "server/ops.json", title: "ops.json", writable: true, language: "json" as const },
  { path: "server/whitelist.json", title: "whitelist.json", writable: true, language: "json" as const },
  { path: "server/banned-players.json", title: "banned-players.json", writable: true, language: "json" as const },
  { path: "server/banned-ips.json", title: "banned-ips.json", writable: true, language: "json" as const },
  { path: "server/bukkit.yml", title: "bukkit.yml", writable: true, language: "yaml" as const },
  { path: "server/spigot.yml", title: "spigot.yml", writable: true, language: "yaml" as const },
  { path: "server/paper-global.yml", title: "paper-global.yml", writable: false, language: "yaml" as const },
  { path: "server/config/paper-global.yml", title: "config/paper-global.yml", writable: false, language: "yaml" as const },
  { path: "server/server.properties.bak", title: "server.properties.bak", writable: false, language: "properties" as const },
];

/* ------------------------------------------------------------------ *
 * Upstream helpers.
 * ------------------------------------------------------------------ */

async function vanillaBuild(version: string) {
  const manifest = object(await fetch(VANILLA_MANIFEST).then((response) => response.json()));
  const versions = Array.isArray(manifest.versions) ? manifest.versions as Array<Record<string, unknown>> : [];
  const entry = versions.find((item) => item.id === version);
  if (!entry || typeof entry.url !== "string") throw new Error(`Minecraft version ${version} is unavailable`);
  const details = object(await fetch(entry.url).then((response) => response.json()));
  const server = object(object(details.downloads).server);
  if (typeof server.url !== "string") throw new Error("Mojang does not publish a server jar for this version");
  return { url: server.url, sha1: typeof server.sha1 === "string" ? server.sha1 : undefined };
}

async function paperBuild(version: string, project = "paper") {
  const builds = await fetch(`https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds`).then((response) => response.ok ? response.json() : []).catch(() => []);
  const latest = Array.isArray(builds) ? builds[0] : undefined;
  const download = object(object(latest?.downloads)["server:default"]);
  if (typeof download.url !== "string") throw new Error(`${project} ${version} is unavailable`);
  return { url: download.url, build: String(latest?.id ?? "") };
}

async function fabricLoader(version: string) {
  const loader = object(await fetch(`${FABRIC_META}/versions/loader/${version}/latest`).then((response) => response.json()));
  const server = object(loader.server);
  if (typeof server.url !== "string") throw new Error("Fabric loader is unavailable");
  return { url: server.url };
}

export async function apply(ctx: Context) {
  const db = ctx.component.database;
  const instances = ctx.component.instances as InstanceService;

  await db.extend("mc_runtime", {
    id: { type: "integer", autoIncrement: true }, instance_id: { type: "string", nullable: false },
    jar_path: { type: "string", initial: "", nullable: false }, updated_at: { type: "timestamp", nullable: false },
  }, { unique: ["instance_id"] });
  await db.extend("mc_eula", {
    id: { type: "integer", autoIncrement: true }, instance_id: { type: "string", nullable: false },
    accepted: { type: "boolean", initial: false, nullable: false }, accepted_by: { type: "integer", initial: 0, nullable: false },
    accepted_at: { type: "timestamp", initial: "", nullable: false },
  }, { unique: ["instance_id"] });

  const directoryOf = (instance: Instance) => path.join(process.cwd(), "data", "instances", instance.instance_id);
  const serverDir = (instance: Instance) => path.join(directoryOf(instance), "server");

  async function runtimeRow(instanceId: string) {
    return db.selectOne("mc_runtime", { instance_id: instanceId }) as Promise<MinecraftRuntime | undefined>;
  }

  async function setJar(instance: Instance, jarPath: string) {
    const now = new Date().toISOString();
    const existing = await runtimeRow(instance.instance_id);
    if (existing) await db.update("mc_runtime", { id: existing.id }, { jar_path: jarPath, updated_at: now });
    else await db.create("mc_runtime", { instance_id: instance.instance_id, jar_path: jarPath, updated_at: now });
  }

  /** Resolve the jar command line for the configured software. Downloads when missing. */
  async function ensureJar(instance: Instance, values: InstanceConfigValues, provisioner: InstanceProvisioner) {
    const type = str(values.serverType, "paper");
    const version = str(values.version, DEFAULT_VERSION);
    const server = serverDir(instance);
    mkdirSync(server, { recursive: true });
    if (type === "custom") {
      const custom = str(values.jarFile);
      if (!custom) throw new Error("no custom jar configured");
      const candidate = path.join(server, path.basename(custom));
      if (!existsSync(candidate)) throw new Error(`custom jar ${path.basename(custom)} is missing from the server folder`);
      await setJar(instance, candidate);
      return candidate;
    }
    const name = `${type}-${version}.jar`;
    const target = path.join(server, `server.jar`);
    if (existsSync(target) && (await runtimeRow(instance.instance_id))?.jar_path?.endsWith(name)) return target;
    provisioner.runtime.pushLine("system", `installing ${type} ${version}`);
    let source: { url: string };
    if (type === "paper" || type === "purpur") source = await paperBuild(version, type === "purpur" ? "purpur" : "paper");
    else if (type === "fabric") source = await fabricLoader(version);
    else if (type === "vanilla") source = await vanillaBuild(version);
    else throw new Error(`${type} cannot be downloaded automatically; upload a jar and choose "custom"`);
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`download failed (${response.status})`);
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    writeFileSync(path.join(server, ".jar-name"), name);
    await setJar(instance, target);
    provisioner.runtime.pushLine("system", `installed ${type} ${version}`);
    return target;
  }

  /** Write server.properties from the configured block, keeping a backup. */
  async function applyConfig(instance: Instance, values: InstanceConfigValues) {
    const server = serverDir(instance);
    mkdirSync(server, { recursive: true });
    const properties = path.join(server, "server.properties");
    if (existsSync(properties)) writeFileSync(path.join(server, "server.properties.bak"), readFileSync(properties));
    writeFileSync(properties, renderProperties(values));
    // Never revoke an EULA the owner already accepted; only write it when missing.
    const eula = path.join(server, "eula.txt");
    if (!existsSync(eula)) writeFileSync(eula, "eula=false\n");
  }

  async function eulaAccepted(instanceId: string) {
    const row = await db.selectOne("mc_eula", { instance_id: instanceId }) as MinecraftEula | undefined;
    return Boolean(row?.accepted);
  }

  async function startVanilla(instance: Instance, provisioner: InstanceProvisioner, jar: string, values: InstanceConfigValues) {
    const memory = num(values.memoryMb, Math.max(1024, instance.memory_mb));
    const initial = Math.min(num(values.memoryInitialMb, Math.floor(memory / 2)), memory);
    const extra = str(values.javaArgs).split(/\s+/).filter(Boolean);
    provisioner.runtime.start([
      "java", `-Xms${initial}M`, `-Xmx${memory}M`, ...extra, "-jar", path.basename(jar), "nogui",
    ], serverDir(instance));
    await waitForHandshake(instance.instance_id, provisioner.runtime, 180_000);
  }

  const downloads: InstanceDownloadSource[] = [
    {
      id: "paper", title: "Paper builds",
      async list() {
        const versions = await fetch(`${PAPER_API}`).then((response) => response.json()).catch(() => undefined);
        const list = object(versions);
        void list;
        const builds = await fetch(`${PAPER_API}/versions`).then((response) => response.ok ? response.json() : []).catch(() => []);
        const entries = Array.isArray(builds) ? builds as Array<Record<string, unknown>> : [];
        return entries.slice(0, 30).map((entry) => ({
          name: `${str(entry.version ?? entry.id)}.jar`,
          url: `paper:${str(entry.version ?? entry.id)}`,
          version: str(entry.version ?? entry.id),
          description: "Paper server jar",
        }));
      },
    },
    {
      id: "vanilla", title: "Vanilla versions",
      async list() {
        const manifest = object(await fetch(VANILLA_MANIFEST).then((response) => response.json()));
        const versions = Array.isArray(manifest.versions) ? manifest.versions as Array<Record<string, unknown>> : [];
        return versions.filter((entry) => entry.type === "release").slice(0, 30).map((entry) => ({
          name: `minecraft_server.${str(entry.id)}.jar`, url: `vanilla:${str(entry.id)}`, version: str(entry.id),
        }));
      },
    },
  ];

  /** Software the plugin can install. Paper-family versions come from PaperMC, Mojang from Mojang. */
  const softwareGroups: Array<{ id: string; title: string; group: string; recommended?: boolean; feed?: string }> = [
    { id: "paper", title: "Paper", group: "paper", recommended: true, feed: "paper" },
    { id: "purpur", title: "Purpur", group: "paper", feed: "purpur" },
    { id: "folia", title: "Folia", group: "paper", feed: "folia" },
    { id: "spigot", title: "Spigot", group: "paper" },
    { id: "vanilla", title: "Mojang", group: "vanilla", feed: "mojang" },
    { id: "fabric", title: "Fabric", group: "modded" },
    { id: "forge", title: "Forge", group: "modded" },
    { id: "purpur-experimental", title: "Purpur (experimental)", group: "experimental", feed: "purpur" },
  ];

  /** Version list per software, cached briefly so the picker is fast but current. */
  const versionCache = new Map<string, { at: number; versions: string[] }>();
  async function versionsFor(software: { id: string; feed?: string }): Promise<string[]> {
    const feed = software.feed;
    if (!feed) return [];
    const cached = versionCache.get(software.id);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.versions;
    let versions: string[] = [];
    try {
      if (feed === "mojang") {
        const manifest = object(await fetch(VANILLA_MANIFEST).then((response) => response.json()));
        const entries = Array.isArray(manifest.versions) ? manifest.versions as Array<Record<string, unknown>> : [];
        versions = entries.filter((entry) => entry.type === "release").slice(0, 20).map((entry) => str(entry.id));
      } else {
        const list = await fetch(`https://fill.papermc.io/v3/projects/${feed}/versions`).then((response) => response.ok ? response.json() : undefined).catch(() => undefined);
        // v3 answers `{ versions: [{ version: { id, support } }] }`.
        const entries = Array.isArray(list) ? list as Array<Record<string, unknown>> : Array.isArray(object(list).versions) ? object(list).versions as Array<Record<string, unknown>> : [];
        versions = entries.map((entry) => {
          const nested = object(entry.version);
          return str(nested.id ?? entry.version ?? entry.id);
        }).filter(Boolean).slice(0, 20);
      }
    } catch { versions = []; }
    versionCache.set(software.id, { at: Date.now(), versions });
    return versions;
  }

  const type: InstanceTypeDefinition = {
    id: "minecraft",
    name: "Minecraft Java",
    tagline: "纯净 / 插件服",
    icon: "block",
    basePriceCents: 2000,
    pluginId: "mc-instance",
    description: "Paper, Purpur, Fabric, Forge or vanilla servers with a full MCSM-style configuration panel, console, file manager and backups.",
    configSchema,
    files,
    downloads,

    /** Variants are the server software; the installed version is a spec-level config. */
    async variants() {
      const variants: InstanceVariant[] = [];
      for (const software of softwareGroups) {
        const versions = await versionsFor(software);
        if (software.feed && !versions.length) {
          variants.push({ id: software.id, title: software.title, group: software.group, description: "version list unavailable", recommended: software.recommended });
          continue;
        }
        if (!versions.length) {
          variants.push({ id: software.id, title: software.title, group: software.group, recommended: software.recommended });
          continue;
        }
        for (const version of versions.slice(0, 3)) {
          variants.push({
            id: `${software.id}:${version}`,
            title: software.title,
            group: software.group,
            version,
            recommended: software.recommended && version === versions[0],
            parameters: { software: software.id, version },
          });
        }
      }
      return variants;
    },

    async resolveInstall(variant) {
      const software = variant.parameters?.software ?? variant.id.split(":")[0];
      const version = variant.parameters?.version ?? variant.version ?? DEFAULT_VERSION;
      if (software === "paper" || software === "purpur" || software === "folia") {
        const build = await paperBuild(version, software);
        return { url: build.url, target: "server/server.jar", meta: { software, version, build: build.build } };
      }
      if (software === "vanilla") {
        const build = await vanillaBuild(version);
        return { url: build.url, target: "server/server.jar", meta: { software, version, sha1: build.sha1 } };
      }
      if (software === "fabric") {
        const build = await fabricLoader(version);
        return { url: build.url, target: "server/server.jar", meta: { software, version } };
      }
      throw new Error(`install source for ${software} is not automated yet; upload a jar and pick "custom"`);
    },
    offer: {
      id: "minecraft",
      name: "Minecraft server",
      summary: "Managed Minecraft server with fine-grained configuration, console and file manager",
      provider: "mc-instance",
      priceCents: 2000,
      period: "month",
      spec: { cpu: 2, memoryMb: 2048, diskGb: 20 },
      sortOrder: 20,
      highlights: ["Paper / Purpur / Fabric / Vanilla", "Full server.properties editor", "Web console", "Backups"],
      // Software and version are chosen through the variant, not as extra store options.
    },

    async create(request: InstanceCreateRequest, provisioner: InstanceProvisioner): Promise<InstanceCreation> {
      const directory = provisioner.directory;
      mkdirSync(path.join(directory, "server"), { recursive: true });
      mkdirSync(path.join(directory, "backups"), { recursive: true });
      // The variant carries the software and version the buyer picked.
      const variant = request.variant;
      const software = str(variant?.parameters?.software, "paper") as InstanceConfigValues[string];
      const version = str(variant?.parameters?.version ?? variant?.version, DEFAULT_VERSION) as InstanceConfigValues[string];
      const values = mergeConfig(configSchema, { ...request.config, serverType: software, version });
      const instance = {
        instance_id: provisioner.runtime.instanceId,
        tenant_id: request.tenantId, project_id: request.project.id, owner_user_id: request.user.id ?? 0,
        spec_id: 0, type_id: "minecraft", plugin_id: "mc-instance", name: "", provider_ref: "", status: "starting", health: "unknown",
        cpu: request.spec.cpu, memory_mb: request.spec.memoryMb, disk_gb: request.spec.diskGb ?? 0, port: num(values.serverPort, 25565),
        variant_id: variant?.id ?? "", attributes_json: "{}", config_json: JSON.stringify(values), order_id: request.orderKey, last_error: "",
        started_at: "", stopped_at: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        attributes: {}, config: values,
      } as unknown as Instance;
      await applyConfig(instance, values);
      await db.create("mc_eula", { instance_id: instance.instance_id, accepted: false, accepted_by: 0, accepted_at: "" }).catch(() => undefined);

      let jarReady = false;
      let jarError = "";
      try {
        await ensureJar(instance, values, provisioner);
        jarReady = true;
      } catch (error) {
        jarError = error instanceof Error ? error.message : String(error);
        provisioner.runtime.pushLine("stderr", `server jar install failed: ${jarError}`);
      }
      await provisioner.progress({ jarReady, jarError, serverType: values.serverType, version: values.version }, `instance prepared (${values.serverType} ${values.version})`);

      return {
        id: `mc_${provisioner.runtime.instanceId}`,
        name: `Minecraft ${str(values.serverType)} ${str(values.version)}`,
        port: num(values.serverPort, 25565),
        attributes: { jarReady, jarError, serverType: values.serverType, version: values.version },
      };
    },

    async applyConfig(instance, values) {
      await applyConfig(instance, values);
    },

    describe(_instance, values) {
      return `${str(values.serverType)} ${str(values.version)} · ${num(values.memoryMb)} MB · port ${num(values.serverPort)}`;
    },

    async start(instance, provisioner) {
      if (!await eulaAccepted(instance.instance_id)) throw new Error("Minecraft EULA has not been accepted for this instance");
      const config = await instances.config(instance.instance_id);
      const values = config?.values ?? instance.config ?? {};
      await applyConfig(instance, values);
      const jar = await ensureJar(instance, values, provisioner);
      await startVanilla(instance, provisioner, jar, values);
    },

    async stop(_instance, provisioner) {
      if (!provisioner.runtime.running) return;
      const config = await instances.config(_instance.instance_id);
      const stopCommand = str(config?.values.stopCommand, "stop");
      try { provisioner.runtime.write(stopCommand); } catch { /* stdin may be closed */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { provisioner.runtime.stop(10_000); resolve(); }, num(config?.values.stopTimeoutSeconds, 30) * 1000);
        const unsubscribe = provisioner.runtime.subscribe((line) => {
          if (/Closing Server|Stopping server/i.test(line.text)) { clearTimeout(timer); unsubscribe(); resolve(); }
        });
      });
    },

    commands: [
      {
        name: "eula", description: "Accept the Minecraft EULA (eula accept)",
        async run(instance, argument, user) {
          if (!/^accept$/i.test(argument.trim())) throw new Error("usage: eula accept");
          await acceptEula(instance, user.id ?? 0);
          return "EULA accepted";
        },
      },
    ],

    routes: [
      {
        method: "GET", path: "eula",
        async handle(session, _user, instance) {
          session.respond({ accepted: await eulaAccepted(instance.instance_id) }, "json");
        },
      },
      {
        method: "POST", path: "eula",
        async handle(session, user, instance) {
          await acceptEula(instance, user.id ?? 0);
          session.respond({ accepted: true }, "json");
        },
      },
      {
        method: "POST", path: "reinstall",
        async handle(session, user, instance, _body, _query, provisioner) {
          const config = await instances.config(instance.instance_id);
          try { await ensureJar(instance, config?.values ?? {}, provisioner); }
          catch (error) { session.status = 502; session.respond({ error: error instanceof Error ? error.message : String(error) }, "json"); return; }
          session.respond({ ok: true, by: user.username }, "json");
        },
      },
      {
        method: "GET", path: "versions",
        async handle(session, _user, _instance, _body, query) {
          const software = query.get("software") ?? "paper";
          try {
            if (software === "vanilla") {
              const manifest = object(await fetch(VANILLA_MANIFEST).then((response) => response.json()));
              const versions = Array.isArray(manifest.versions) ? manifest.versions as Array<Record<string, unknown>> : [];
              session.respond({ versions: versions.filter((entry) => entry.type === "release").slice(0, 40).map((entry) => str(entry.id)) }, "json");
              return;
            }
            const list = await fetch(`https://fill.papermc.io/v3/projects/${software === "purpur" ? "purpur" : "paper"}/versions`).then((response) => response.ok ? response.json() : []).catch(() => []);
            const versions = Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
            session.respond({ versions: versions.map((entry) => str(entry.version ?? entry.id)).filter(Boolean).slice(0, 40) }, "json");
          } catch (error) {
            session.status = 502; session.respond({ error: error instanceof Error ? error.message : String(error) }, "json");
          }
        },
      },
    ],
  };

  async function acceptEula(instance: Instance, userId: number) {
    const now = new Date().toISOString();
    const existing = await db.selectOne("mc_eula", { instance_id: instance.instance_id }) as MinecraftEula | undefined;
    if (existing) await db.update("mc_eula", { id: existing.id }, { accepted: true, accepted_by: userId, accepted_at: now });
    else await db.create("mc_eula", { instance_id: instance.instance_id, accepted: true, accepted_by: userId, accepted_at: now });
    const server = serverDir(instance);
    mkdirSync(server, { recursive: true });
    writeFileSync(path.join(server, "eula.txt"), "eula=true\n");
    await instances.recordEvent(instance.instance_id, "configured", `EULA accepted by user ${userId}`);
  }

  instances.registerType(type);

  ctx.i18n({ cloud: { mc: {
    eulaTitle: { zh: "Minecraft 最终用户许可协议", en: "Minecraft EULA", ja: "Minecraft EULA" },
    eulaHint: { zh: "同意 Mojang 的 EULA 之后才能启动服务器。", en: "Accepting the Mojang EULA is required before the server can start.", ja: "サーバーを起動するには Mojang EULA への同意が必要です。" },
    eulaAccept: { zh: "我已阅读并同意 EULA", en: "I have read and accept the EULA", ja: "EULA を読み、同意します" },
    eulaLink: { zh: "查看 EULA", en: "Read the EULA", ja: "EULA を読む" },
    eulaAccepted: { zh: "已同意 EULA", en: "EULA accepted", ja: "EULA 同意済み" },
    eulaRequired: { zh: "接受 EULA 后才能启动服务器。", en: "Accept the EULA to start the server.", ja: "EULA に同意するとサーバーを起動できます。" },
    quickConfig: { zh: "服务器配置", en: "Server configuration", ja: "サーバー設定" },
    quickConfigHint: { zh: "保存后会立即写入 server.properties 与 eula.txt，重启服务器后生效。", en: "Saving writes server.properties and eula.txt immediately; restart the server to apply.", ja: "保存すると server.properties と eula.txt が更新されます。再起動で反映されます。" },
    save: { zh: "保存配置", en: "Save configuration", ja: "設定を保存" },
    saving: { zh: "保存中…", en: "Saving…", ja: "保存中…" },
    saved: { zh: "配置已保存，重启服务器后生效。", en: "Configuration saved. Restart the server to apply.", ja: "設定を保存しました。再起動で反映されます。" },
    reinstall: { zh: "重新下载服务端", en: "Re-download server", ja: "サーバーを再取得" },
    reinstallHint: { zh: "服务端文件缺失或损坏时可重新下载。", en: "Download the server jar again if it is missing or broken.", ja: "サーバーファイルが欠損している場合に再取得します。" },
    search: { zh: "搜索配置项", en: "Search settings", ja: "設定を検索" },
  } } });

  void fileURLToPath;
}

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
