import { spawnSync } from "node:child_process";
import { Context, Logger, Schema, type Session } from "yumeri";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { User } from "@mirelia/user";
import type { InstanceService } from "@jpgpanel/server-instances";
import "@jpgpanel/server-instances";
import "@mirelia/dashboard";

export const depend = ["dashboard", "database", "instances", "user"];
export const provide = ["files"];

/**
 * File manager and backups for instances. It works on the instance directory that
 * `server-instances` owns (`data/instances/<instanceId>`), so every instance type gets
 * the same browsing, editing, upload, delete, rename and backup tools without doing
 * anything itself. Types can narrow what is reachable through `InstanceFileTrack`
 * (writable files) and hide secrets from the editor.
 */
export interface FileManagerConfig {
  maxEditBytes: number;
  maxUploadBytes: number;
  hidden: string[];
  backupKeep: number;
}

export const config: Schema<FileManagerConfig> = Schema.object({
  maxEditBytes: Schema.number("Largest file the editor will open, in bytes").key("files.maxEditBytes").default(2 * 1024 * 1024),
  maxUploadBytes: Schema.number("Largest upload accepted, in bytes").key("files.maxUploadBytes").default(64 * 1024 * 1024),
  hidden: Schema.array(Schema.string("Filename or glob-ish suffix"), "Names hidden from the listing").key("files.hidden").default([".jar-name"]),
  backupKeep: Schema.number("Backups kept per instance").key("files.backupKeep").default(10),
});

export interface BackupFilesService {
  createBackup(instanceId: string, user?: User): Promise<BackupEntry>;
  backups(instanceId: string): BackupEntry[];
  restore(instanceId: string, id: string, user?: User): Promise<void>;
  keep(): number;
}

export interface FileEntry { name: string; directory: boolean; size: number; modified: string }
export interface BackupEntry { id: string; name: string; size: number; created_at: string }

const logger = new Logger("file-manager");

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Resolve a user supplied path inside `root`, refusing escapes. */
export function safePath(root: string, relative: string) {
  const resolved = path.resolve(root, relative.replace(/^\/+/, ""));
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : undefined;
}

export async function apply(ctx: Context, pluginConfig: FileManagerConfig = { maxEditBytes: 2 * 1024 * 1024, maxUploadBytes: 64 * 1024 * 1024, hidden: [".jar-name"], backupKeep: 10 }) {
  const settings = { ...pluginConfig };
  const instances = ctx.component.instances as InstanceService;
  const users = ctx.component.user;
  const root = path.resolve(process.cwd(), "data", "instances");
  const directoryOf = (instanceId: string) => path.join(root, instanceId);

  ctx.i18n({ cloud: { files: {
    title: { zh: "文件管理", en: "File manager", ja: "ファイル管理" },
    description: { zh: "浏览、编辑、上传实例目录中的文件，并创建或还原备份。", en: "Browse, edit and upload files in the instance directory, and create or restore backups.", ja: "インスタンスディレクトリ内のファイルを閲覧・編集・アップロードし、バックアップを作成・復元します。" },
    path: { zh: "当前目录", en: "Current folder", ja: "現在のフォルダ" },
    up: { zh: "上级目录", en: "Up", ja: "上へ" },
    newFolder: { zh: "新建文件夹", en: "New folder", ja: "新しいフォルダ" },
    newFile: { zh: "新建文件", en: "New file", ja: "新しいファイル" },
    upload: { zh: "上传文件", en: "Upload file", ja: "ファイルをアップロード" },
    empty: { zh: "目录为空", en: "This folder is empty", ja: "このフォルダは空です" },
    name: { zh: "名称", en: "Name", ja: "名前" },
    size: { zh: "大小", en: "Size", ja: "サイズ" },
    modified: { zh: "修改时间", en: "Modified", ja: "更新日時" },
    save: { zh: "保存", en: "Save", ja: "保存" },
    saved: { zh: "已保存", en: "Saved", ja: "保存しました" },
    delete: { zh: "删除", en: "Delete", ja: "削除" },
    rename: { zh: "重命名", en: "Rename", ja: "名前を変更" },
    confirmDelete: { zh: "确定删除 {name}？", en: "Delete {name}?", ja: "{name} を削除しますか？" },
    readOnly: { zh: "受管文件只允许在配置页修改", en: "Managed files are edited from the configuration page", ja: "管理対象ファイルは設定ページで編集します" },
    backups: { zh: "备份", en: "Backups", ja: "バックアップ" },
    backupsHint: { zh: "备份会打包实例目录（不含备份本身）。", en: "A backup archives the instance directory (excluding backups).", ja: "バックアップはインスタンスディレクトリを保存します（バックアップを除く）。" },
    createBackup: { zh: "创建备份", en: "Create backup", ja: "バックアップを作成" },
    restore: { zh: "还原", en: "Restore", ja: "復元" },
    creating: { zh: "正在创建…", en: "Creating…", ja: "作成中…" },
    restoring: { zh: "正在还原…", en: "Restoring…", ja: "復元中…" },
    noBackups: { zh: "暂无备份", en: "No backups yet", ja: "バックアップはありません" },
    created: { zh: "备份已创建", en: "Backup created", ja: "バックアップを作成しました" },
    restored: { zh: "备份已还原，重启服务器后生效", en: "Backup restored. Restart the server to apply.", ja: "バックアップを復元しました。再起動で反映されます。" },
    runningHint: { zh: "服务器运行中创建的备份可能包含正在写入的世界文件。", en: "Backups made while the server runs may catch the world mid-write.", ja: "稼働中に作成したバックアップは書き込み中のワールドを含む可能性があります。" },
    errors: {
      auth: { zh: "请先登录", en: "Authentication is required", ja: "ログインしてください" },
      notFound: { zh: "文件或目录不存在", en: "The file or folder does not exist", ja: "ファイルまたはフォルダが存在しません" },
      path: { zh: "路径无效", en: "Invalid path", ja: "無効なパスです" },
      tooLarge: { zh: "文件过大", en: "The file is too large", ja: "ファイルが大きすぎます" },
      readOnly: { zh: "该文件不可编辑", en: "This file cannot be edited", ja: "このファイルは編集できません" },
      backup: { zh: "备份操作失败", en: "The backup operation failed", ja: "バックアップ操作に失敗しました" },
    },
  } } });

  async function authorize(session: Session, instanceId: string) {
    return instances.authorize(session, instanceId);
  }

  function listing(instanceId: string, relative: string) {
    const base = directoryOf(instanceId);
    const directory = safePath(base, relative);
    if (!directory || !existsSync(directory) || !statSync(directory).isDirectory()) return undefined;
    const entries: FileEntry[] = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !settings.hidden.includes(entry.name))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        const stat = statSync(file);
        return { name: entry.name, directory: entry.isDirectory(), size: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return entries;
  }

  function backups(instanceId: string): BackupEntry[] {
    const directory = path.join(directoryOf(instanceId), "backups");
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".tar.gz"))
      .map((name) => ({ id: name, name, size: statSync(path.join(directory, name)).size, created_at: statSync(path.join(directory, name)).mtime.toISOString() }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async function createBackup(instanceId: string, user?: User) {
    const base = directoryOf(instanceId);
    const store = path.join(base, "backups");
    mkdirSync(store, { recursive: true });
    const name = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;
    const target = path.join(store, name);
    const result = runCapture(["tar", "-czf", target, "--exclude=backups", "-C", base, "."], base);
    if (result.code !== 0) throw new Error(result.output.slice(0, 400));
    const all = backups(instanceId);
    for (const stale of all.slice(Math.max(settings.backupKeep, 1))) rmSync(path.join(store, stale.name), { force: true });
    await instances.recordEvent(instanceId, "configured", `backup ${name} created`, user);
    return backups(instanceId)[0];
  }

  async function restoreBackup(instanceId: string, id: string, user?: User) {
    const base = directoryOf(instanceId);
    const file = path.join(base, "backups", path.basename(id));
    if (!existsSync(file)) throw new Error("backup missing");
    // Keep the current state before overwriting it.
    await createBackup(instanceId, user);
    const result = runCapture(["tar", "-xzf", file, "-C", base], base);
    if (result.code !== 0) throw new Error(result.output.slice(0, 400));
    await instances.recordEvent(instanceId, "configured", `backup ${id} restored`, user);
  }

  function fail(session: Session, status: number, key: string) {
    session.status = status;
    session.respond({ error: session.text(key) }, "json");
  }

  ctx.route("/api/instances/:id/files").methods("GET").action(async (session, query, id) => {
    if (!await authorize(session, id)) return;
    const relative = query.get("path") ?? "";
    // `file=1` reads one file; without it the route lists a folder.
    if (query.get("file") === "1") {
      const file = safePath(directoryOf(id), relative);
      if (!file || !existsSync(file) || statSync(file).isDirectory()) return fail(session, 404, "cloud.files.errors.notFound");
      const size = statSync(file).size;
      if (size > settings.maxEditBytes) return fail(session, 413, "cloud.files.errors.tooLarge");
      session.respond({ path: relative, content: readFileSync(file, "utf8"), size }, "json");
      return;
    }
    const entries = listing(id, relative);
    if (!entries) return fail(session, 404, "cloud.files.errors.notFound");
    session.respond({ path: relative, entries }, "json");
  });

  ctx.route("/api/instances/:id/files").methods("PUT").action(async (session, _query, id) => {
    if (!await authorize(session, id)) return;
    const body = object(await session.parseRequestBody());
    const relative = String(body.path ?? "");
    const file = safePath(directoryOf(id), relative);
    if (!file) return fail(session, 400, "cloud.files.errors.path");
    const content = String(body.content ?? "");
    if (Buffer.byteLength(content, "utf8") > settings.maxEditBytes) return fail(session, 413, "cloud.files.errors.tooLarge");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    await instances.recordEvent(id, "configured", `edited ${relative}`, await users.current(session));
    session.respond({ size: Buffer.byteLength(content, "utf8") }, "json");
  });

  ctx.route("/api/instances/:id/files").methods("POST").action(async (session, _query, id) => {
    if (!await authorize(session, id)) return;
    const body = object(await session.parseRequestBody());
    const action = String(body.action ?? "");
    const relative = String(body.path ?? "");
    const file = safePath(directoryOf(id), relative);
    if (!file) return fail(session, 400, "cloud.files.errors.path");
    const now = new Date().toISOString();
    if (action === "mkdir") { mkdirSync(file, { recursive: true }); session.status = 201; session.respond({ ok: true }, "json"); return; }
    if (action === "touch") { mkdirSync(path.dirname(file), { recursive: true }); if (!existsSync(file)) writeFileSync(file, ""); session.status = 201; session.respond({ ok: true }, "json"); return; }
    if (action === "rename") {
      const target = safePath(directoryOf(id), String(body.to ?? ""));
      if (!target || !existsSync(file)) return fail(session, 400, "cloud.files.errors.path");
      renameSync(file, target);
      session.respond({ ok: true, modified: now }, "json"); return;
    }
    fail(session, 400, "cloud.files.errors.path");
  });

  ctx.route("/api/instances/:id/files").methods("DELETE").action(async (session, query, id) => {
    if (!await authorize(session, id)) return;
    const file = safePath(directoryOf(id), query.get("path") ?? "");
    if (!file || !existsSync(file)) return fail(session, 404, "cloud.files.errors.notFound");
    rmSync(file, { recursive: true, force: true });
    await instances.recordEvent(id, "configured", `deleted ${query.get("path")}`, await users.current(session));
    session.respond({ ok: true }, "json");
  });

  ctx.route("/api/instances/:id/backups").methods("GET").action(async (session, _query, id) => {
    if (!await authorize(session, id)) return;
    session.respond({ backups: backups(id) }, "json");
  });

  ctx.route("/api/instances/:id/backups").methods("POST").action(async (session, _query, id) => {
    if (!await authorize(session, id)) return;
    try {
      const backup = await createBackup(id, await users.current(session));
      session.status = 201;
      session.respond({ backup, backups: backups(id) }, "json");
    } catch (error) {
      logger.warn(`backup failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      fail(session, 502, "cloud.files.errors.backup");
    }
  });

  ctx.route("/api/instances/:id/backups/:backupId").methods("DELETE").action(async (session, _query, id, backupId) => {
    if (!await authorize(session, id)) return;
    rmSync(path.join(directoryOf(id), "backups", path.basename(backupId)), { force: true });
    session.respond({ ok: true, backups: backups(id) }, "json");
  });

  ctx.route("/api/instances/:id/backups/:backupId/restore").methods("POST").action(async (session, _query, id, backupId) => {
    if (!await authorize(session, id)) return;
    try {
      await restoreBackup(id, backupId, await users.current(session));
      session.respond({ ok: true, backups: backups(id) }, "json");
    } catch (error) {
      fail(session, 502, "cloud.files.errors.backup");
    }
  });

  /** Backup helpers other plugins schedule, for example the automatic backup plugin. */
  ctx.registerComponent("files", {
    createBackup,
    backups,
    restore: restoreBackup,
    keep: () => settings.backupKeep,
  } satisfies BackupFilesService);

  ctx.component.dashboard.addEntry({ id: "file-manager", dev: fileURLToPath(new URL("../frontend/index.tsx", import.meta.url)), prod: fileURLToPath(new URL("../dist/frontend/files.js", import.meta.url)), plugin: "file-manager" });
}

function runCapture(command: string[], cwd: string) {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8", timeout: 600_000 });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export default apply;
