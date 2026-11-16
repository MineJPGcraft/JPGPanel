import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Context, Logger, Schema } from "yumeri";
import type {
  Instance, InstanceConfigSchema, InstanceCreateRequest, InstanceCreation, InstanceProvisioner,
  InstanceService, InstanceTypeDefinition, InstanceVariant,
} from "@jpgpanel/server-instances";
import { mergeConfig } from "@jpgpanel/server-instances";
import "@jpgpanel/server-instances";

export const depend = ["database", "instances"];

/**
 * Plain shell servers. Unlike a game type, the software list is not baked into the
 * plugin: administrators create instance types here (for example "Ubuntu 24.04",
 * "Python 3.12 runtime") and define how each one is prepared, then assign specs.
 */
export interface ShellTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** Base image label shown on the card, for example "ubuntu:24.04". */
  image: string;
  /** Steps executed while provisioning, one shell command per line. */
  install_script: string;
  /** Command that keeps the instance alive in the foreground. */
  run_command: string;
  /** Environment variables injected before install/run. */
  env_json: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

declare module "@yumerijs/types" { interface Tables { shell_templates: ShellTemplate } }

export interface ShellConfig { defaultRunCommand: string; maxScriptBytes: number }

export const config: Schema<ShellConfig> = Schema.object({
  defaultRunCommand: Schema.string("Command used when a template does not set one").key("shell-instance.defaultRunCommand").default("sleep infinity"),
  maxScriptBytes: Schema.number("Largest install or run command accepted").key("shell-instance.maxScriptBytes").default(32768),
});

const logger = new Logger("shell-instance");

export const configSchema: InstanceConfigSchema = {
  version: 1,
  sections: [
    {
      id: "runtime", title: "Runtime",
      fields: {
        workdir: { type: "string", title: "Working directory", default: "server", description: "Relative to the instance directory." },
        runCommand: { type: "string", title: "Run command", default: "", description: "Overrides the template command. Empty uses the template." },
        installOnStart: { type: "boolean", title: "Run the install script before every start", default: false },
        restartOnCrash: { type: "boolean", title: "Restart after a crash", default: true },
      },
    },
    {
      id: "environment", title: "Environment",
      fields: {
        nodeVersion: { type: "string", title: "Node.js version", default: "", description: "Optional, installed with nvm when set." },
        pythonVersion: { type: "string", title: "Python version", default: "", description: "Optional, installed with uv when set." },
        extraEnv: { type: "string", title: "Extra environment", default: "", description: "KEY=value per line." },
      },
    },
  ],
};

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function str(value: unknown, fallback = "") { return typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value); }
function slugify(value: string) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48); }

export async function apply(ctx: Context, pluginConfig: ShellConfig = { defaultRunCommand: "sleep infinity", maxScriptBytes: 32768 }) {
  const db = ctx.component.database;
  const instances = ctx.component.instances as InstanceService;

  await db.extend("shell_templates", {
    id: { type: "integer", autoIncrement: true },
    slug: { type: "string", nullable: false },
    name: { type: "string", nullable: false },
    description: { type: "text", initial: "", nullable: false },
    image: { type: "string", initial: "debian:12", nullable: false },
    install_script: { type: "text", initial: "", nullable: false },
    run_command: { type: "string", initial: "sleep infinity", nullable: false },
    env_json: { type: "text", initial: "{}", nullable: false },
    enabled: { type: "boolean", initial: true, nullable: false },
    created_at: { type: "timestamp", nullable: false },
    updated_at: { type: "timestamp", nullable: false },
  }, { unique: ["slug"] });

  const templates = async () => (await db.select("shell_templates", {}) as ShellTemplate[]).sort((a, b) => a.name.localeCompare(b.name));

  /** The built-in types always exist; administrators can add more from the panel. */
  const builtin: Array<Omit<ShellTemplate, "id" | "created_at" | "updated_at">> = [
    {
      slug: "debian", name: "Debian shell", description: "Plain Debian container with a root shell and common tooling.",
      image: "debian:12", enabled: true, env_json: "{}",
      install_script: "apt-get update && apt-get install -y curl ca-certificates git && rm -rf /var/lib/apt/lists/*",
      run_command: "sleep infinity",
    },
    {
      slug: "node", name: "Node.js runtime", description: "Node.js LTS with pnpm, ready to run a service.",
      image: "node:22", enabled: true, env_json: "{}",
      install_script: "corepack enable && pnpm --version",
      run_command: "pnpm start",
    },
  ];
  for (const template of builtin) {
    if (await db.selectOne("shell_templates", { slug: template.slug })) continue;
    const now = new Date().toISOString();
    await db.create("shell_templates", { ...template, created_at: now, updated_at: now });
  }

  function environmentOf(template: ShellTemplate, values: Record<string, unknown>) {
    const env: Record<string, string> = {};
    try { Object.assign(env, object(JSON.parse(template.env_json || "{}"))); } catch { /* ignore broken env */ }
    for (const line of str(values.extraEnv).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) env[match[1]] = match[2];
    }
    return env;
  }

  function shellCommand(script: string) {
    if (!script.trim()) return undefined;
    if (Buffer.byteLength(script, "utf8") > pluginConfig.maxScriptBytes) throw new Error("install script is too large");
    return ["/bin/sh", "-c", script];
  }

  async function templateFor(variant: InstanceVariant) {
    const slug = variant.parameters?.template ?? variant.id.split(":")[0];
    return db.selectOne("shell_templates", { slug }) as Promise<ShellTemplate | undefined>;
  }

  const type: InstanceTypeDefinition = {
    id: "shell",
    name: "Shell",
    tagline: "Linux 容器 / 运行环境",
    icon: "terminal",
    basePriceCents: 500,
    pluginId: "shell-instance",
    description: "Plain shell servers administrators define themselves, with install steps and a run command.",
    configSchema,
    files: [
      { path: "server/install.sh", title: "install.sh", writable: true, language: "text" },
      { path: "server/run.sh", title: "run.sh", writable: true, language: "text" },
      { path: "config/env", title: "env", writable: true, language: "text" },
    ],
    offer: {
      id: "shell",
      name: "Shell server",
      summary: "Shell instances with administrator-defined images, install steps and run commands",
      provider: "shell-instance",
      priceCents: 500,
      period: "month",
      spec: { cpu: 1, memoryMb: 512, diskGb: 5 },
      sortOrder: 30,
      highlights: ["Any Linux image", "Custom install script", "Run any process"],
    },

    async variants() {
      const list = await templates();
      const baseTypes: InstanceVariant[] = list.filter((template) => template.enabled).map((template) => ({
        id: template.slug,
        title: template.name,
        group: "templates",
        description: template.description,
        version: template.image,
        parameters: { template: template.slug },
      }));
      // The generic shell lets an administrator sell a plain container without a template.
      return [{ id: "blank", title: "Plain shell", group: "templates", description: "Bare container with a shell", parameters: { template: "" } }, ...baseTypes];
    },

    async resolveInstall(variant) {
      const template = await templateFor(variant);
      if (!template?.install_script) return undefined;
      return { url: "", target: "server/install.sh", meta: { script: template.install_script } };
    },

    async create(request: InstanceCreateRequest, provisioner: InstanceProvisioner): Promise<InstanceCreation> {
      const template = await templateFor(request.variant);
      const values = mergeConfig(configSchema, request.config);
      const directory = provisioner.directory;
      const server = path.join(directory, "server");
      mkdirSync(server, { recursive: true });
      mkdirSync(path.join(directory, "config"), { recursive: true });

      const install = template?.install_script ?? "";
      const run = str(values.runCommand) || template?.run_command || pluginConfig.defaultRunCommand;
      writeFileSync(path.join(server, "install.sh"), `#!/bin/sh\n${install}\n`);
      writeFileSync(path.join(server, "run.sh"), `#!/bin/sh\n${run}\n`);
      const env = environmentOf(template ?? { env_json: "{}" } as ShellTemplate, values);
      writeFileSync(path.join(directory, "config", "env"), Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"));
      writeFileSync(path.join(directory, "config", "template.json"), JSON.stringify({ template: template?.slug ?? "", image: template?.image ?? "" }, null, 2));

      if (install) {
        provisioner.runtime.pushLine("system", `running install script for ${template?.name ?? "plain shell"}`);
        const command = shellCommand(install);
        if (command) await provisioner.runtime.run(command, { cwd: server, timeoutMs: 10 * 60 * 1000 }).catch((error: unknown) => {
          provisioner.runtime.pushLine("stderr", `install failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }

      return {
        id: `sh_${provisioner.runtime.instanceId}`,
        name: template ? `${template.name} (${template.image})` : "Shell instance",
        port: 0,
        attributes: { template: template?.slug ?? "", image: template?.image ?? "", install: install.slice(0, 4000), run },
      };
    },

    async start(instance, provisioner) {
      const config = await instances.config(instance.instance_id);
      const values = config?.values ?? {};
      const directory = path.join(process.cwd(), "data", "instances", instance.instance_id);
      const server = path.join(directory, str(values.workdir, "server"));
      mkdirSync(server, { recursive: true });
      if (values.installOnStart) {
        const install = readFileSync(path.join(server, "install.sh"), "utf8").replace(/^#!.*\n/, "");
        const command = shellCommand(install);
        if (command) await provisioner.runtime.run(command, { cwd: server, timeoutMs: 10 * 60 * 1000 });
      }
      const run = str(values.runCommand) || (existsSync(path.join(server, "run.sh")) ? readFileSync(path.join(server, "run.sh"), "utf8").replace(/^#!.*\n/, "") : pluginConfig.defaultRunCommand);
      provisioner.runtime.start(["/bin/sh", "-c", run], server);
    },

    async stop(_instance, provisioner) {
      const child = provisioner.runtime;
      if (!child.running) return;
      child.stop(5000);
      await new Promise((resolve) => setTimeout(resolve, 600));
    },
  };

  instances.registerType(type);

  /* ---------------------------------------------------------------- *
   * Administrator templates.
   * ---------------------------------------------------------------- */
  function fail(session: { status: number; text(key: string): string; respond(body: unknown, type: "json"): void }, status: number, key: string) {
    session.status = status;
    session.respond({ error: session.text(`cloud.shell.errors.${key}`) }, "json");
  }

  ctx.route("/api/instances/shell/templates").methods("GET").action(async (session) => {
    if (!await ctx.component.user.requireAdmin(session)) return;
    session.respond({ templates: await templates() }, "json");
  });

  ctx.route("/api/instances/shell/templates").methods("POST").action(async (session) => {
    if (!await ctx.component.user.requireAdmin(session)) return;
    const body = object(await session.parseRequestBody());
    const name = str(body.name).trim().slice(0, 80);
    if (!name) return fail(session, 400, "invalid");
    const slug = slugify(str(body.slug) || name) || `shell-${Date.now()}`;
    if (await db.selectOne("shell_templates", { slug })) return fail(session, 409, "exists");
    const now = new Date().toISOString();
    const template = await db.create("shell_templates", {
      slug, name, description: str(body.description).slice(0, 500), image: str(body.image, "debian:12").slice(0, 120),
      install_script: str(body.install_script).slice(0, pluginConfig.maxScriptBytes),
      run_command: str(body.run_command, pluginConfig.defaultRunCommand).slice(0, 2000),
      env_json: JSON.stringify(object(body.env)), enabled: body.enabled !== false, created_at: now, updated_at: now,
    }) as ShellTemplate;
    logger.info(`Created shell template ${slug}`);
    session.status = 201;
    session.respond({ template }, "json");
  });

  ctx.route("/api/instances/shell/templates/:id").methods("PUT").action(async (session, _query, id) => {
    if (!await ctx.component.user.requireAdmin(session)) return;
    const template = await db.selectOne("shell_templates", { id: Number(id) as unknown as string }) as ShellTemplate | undefined;
    if (!template) return fail(session, 404, "notFound");
    const body = object(await session.parseRequestBody());
    const updates: Partial<ShellTemplate> = { updated_at: new Date().toISOString() };
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim().slice(0, 80);
    if (typeof body.description === "string") updates.description = body.description.slice(0, 500);
    if (typeof body.image === "string" && body.image.trim()) updates.image = body.image.trim().slice(0, 120);
    if (typeof body.install_script === "string") updates.install_script = body.install_script.slice(0, pluginConfig.maxScriptBytes);
    if (typeof body.run_command === "string") updates.run_command = body.run_command.slice(0, 2000);
    if (body.env && typeof body.env === "object") updates.env_json = JSON.stringify(object(body.env));
    if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
    await db.update("shell_templates", { id: template.id }, updates);
    session.respond({ template: { ...template, ...updates } }, "json");
  });

  ctx.route("/api/instances/shell/templates/:id").methods("DELETE").action(async (session, _query, id) => {
    if (!await ctx.component.user.requireAdmin(session)) return;
    await db.remove("shell_templates", { id: Number(id) as unknown as string });
    session.respond({ ok: true }, "json");
  });

  ctx.i18n({ cloud: { shell: {
    title: { zh: "Shell 实例类型", en: "Shell instance types", ja: "シェルインスタンス種別" },
    description: { zh: "定义管理员可售卖的普通 shell 实例：镜像、安装脚本与启动命令。", en: "Define the plain shell instances administrators sell: image, install script and run command.", ja: "販売するシェルインスタンス（イメージ、インストールスクリプト、起動コマンド）を定義します。" },
    name: { zh: "名称", en: "Name", ja: "名前" },
    image: { zh: "镜像", en: "Image", ja: "イメージ" },
    install: { zh: "安装脚本", en: "Install script", ja: "インストールスクリプト" },
    runCommand: { zh: "启动命令", en: "Run command", ja: "起動コマンド" },
    env: { zh: "环境变量（KEY=value，每行一个）", en: "Environment (KEY=value per line)", ja: "環境変数（1 行に KEY=value）" },
    enabled: { zh: "可售", en: "Available", ja: "販売可能" },
    newTemplate: { zh: "新建 shell 类型", en: "New shell type", ja: "シェル種別を作成" },
    empty: { zh: "还没有 shell 类型", en: "No shell types yet", ja: "シェル種別はありません" },
    saved: { zh: "已保存", en: "Saved", ja: "保存しました" },
    errors: { invalid: { zh: "数据无效", en: "Invalid data", ja: "データが無効です" }, exists: { zh: "标识已存在", en: "The slug already exists", ja: "識別子が既に存在します" }, notFound: { zh: "不存在", en: "Not found", ja: "存在しません" } },
  } } });

  void spawnSync;
}

export default apply;
