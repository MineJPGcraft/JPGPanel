import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, LinkButton, api, useI18n } from "@mirelia/dashboard/frontend";
import { ArchiveRestore, ChevronRight, Download, File, Folder, FolderUp, LoaderCircle, Pencil, Plus, Save, Trash2 } from "lucide-react";

interface Entry { name: string; directory: boolean; size: number; modified: string }
interface Backup { id: string; name: string; size: number; created_at: string }

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** Browse, edit and back up files of an instance. Needs the file-manager plugin. */
export default function FileManagerPanel({ instanceId }: { instanceId: string }) {
  const { t, language } = useI18n();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ path: string; content: string }>();
  const [saving, setSaving] = useState(false);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState<string>();
  const load = useCallback(async (target: string) => {
    setLoading(true); setError("");
    try {
      const [files, backupList] = await Promise.all([
        api.get<{ entries: Entry[] }>(`/instances/${instanceId}/files?path=${encodeURIComponent(target)}`),
        api.get<{ backups: Backup[] }>(`/instances/${instanceId}/backups`).catch(() => ({ data: { backups: [] as Backup[] } })),
      ]);
      setEntries(files.data.entries); setBackups(backupList.data.backups);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.files.errors.notFound")); }
    finally { setLoading(false); }
  }, [instanceId, t]);
  useEffect(() => { void load(path); }, [load, path]);

  const join = (name: string) => (path ? `${path}/${name}` : name);
  async function open(entry: Entry) {
    if (entry.directory) { setPath(join(entry.name)); return; }
    setBusy(entry.name);
    try {
      const { data } = await api.get<{ content: string }>(`/instances/${instanceId}/files?path=${encodeURIComponent(join(entry.name))}&file=1`);
      setEditing({ path: join(entry.name), content: data.content });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.files.errors.tooLarge")); }
    finally { setBusy(undefined); }
  }
  async function save() {
    if (!editing) return;
    setSaving(true); setError("");
    try { await api.put(`/instances/${instanceId}/files`, { path: editing.path, content: editing.content }); setEditing(undefined); await load(path); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.files.errors.readOnly")); }
    finally { setSaving(false); }
  }
  async function remove(entry: Entry) {
    if (!window.confirm(t("cloud.files.confirmDelete", { name: entry.name }))) return;
    setBusy(entry.name);
    try { await api.delete(`/instances/${instanceId}/files?path=${encodeURIComponent(join(entry.name))}`); await load(path); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.files.errors.notFound")); }
    finally { setBusy(undefined); }
  }
  async function create(kind: "mkdir" | "touch") {
    const name = window.prompt(kind === "mkdir" ? t("cloud.files.newFolder") : t("cloud.files.newFile"));
    if (!name) return;
    try { await api.post(`/instances/${instanceId}/files`, { action: kind, path: join(name) }); await load(path); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.files.errors.path")); }
  }
  async function upload() {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const content = await file.text();
      try { await api.put(`/instances/${instanceId}/files`, { path: join(file.name), content }); await load(path); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.files.errors.tooLarge")); }
    };
    input.click();
  }
  async function backup(action: "create" | "restore", id?: string) {
    setBusy(id ?? "create"); setError("");
    try {
      if (action === "create") await api.post(`/instances/${instanceId}/backups`, {});
      else await api.post(`/instances/${instanceId}/backups/${encodeURIComponent(id!)}/restore`, {});
      await load(path);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.files.errors.backup")); }
    finally { setBusy(undefined); }
  }
  const up = path.split("/").filter(Boolean).slice(0, -1).join("/");
  return <div className="space-y-4">
    <section className="rounded-md border border-border">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
        <div className="min-w-0"><p className="flex items-center gap-1.5 text-sm font-semibold"><Folder className="size-4 text-muted-foreground" />{t("cloud.files.title")}</p><p className="truncate text-xs text-muted-foreground">/{path}</p></div>
        <div className="flex flex-wrap gap-1">
          {path && <Button size="sm" variant="ghost" onPress={() => setPath(up)}><FolderUp />{t("cloud.files.up")}</Button>}
          <Button size="sm" variant="ghost" onPress={() => void create("mkdir")}><Plus />{t("cloud.files.newFolder")}</Button>
          <Button size="sm" variant="ghost" onPress={() => void create("touch")}><File />{t("cloud.files.newFile")}</Button>
          <Button size="sm" variant="ghost" onPress={() => void upload()}><Download />{t("cloud.files.upload")}</Button>
        </div>
      </header>
      {error && <p role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</p>}
      {loading ? <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p>
        : entries.length ? <div className="divide-y divide-border">{entries.map((entry) => <div key={entry.name} className="flex items-center gap-2 px-3 py-2 text-sm">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground" onClick={() => void open(entry)}>
            {entry.directory ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{entry.name}</span>
            {busy === entry.name && <LoaderCircle className="size-3.5 animate-spin" />}
          </button>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{entry.directory ? "—" : formatBytes(entry.size)}</span>
          <time className="hidden shrink-0 text-xs text-muted-foreground sm:block">{new Date(entry.modified).toLocaleString(language)}</time>
          <Button size="icon-xs" variant="ghost" aria-label={t("cloud.files.rename")} onPress={() => { const next = window.prompt(t("cloud.files.rename"), entry.name); if (next) void api.post(`/instances/${instanceId}/files`, { action: "rename", path: join(entry.name), to: join(next) }).then(() => load(path)); }}><Pencil /></Button>
          <Button size="icon-xs" variant="ghost" aria-label={t("cloud.files.delete")} onPress={() => void remove(entry)}><Trash2 /></Button>
        </div>)}</div>
          : <p className="p-4 text-sm text-muted-foreground">{t("cloud.files.empty")}</p>}
    </section>
    <section className="rounded-md border border-border">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
        <div><p className="text-sm font-semibold">{t("cloud.files.backups")}</p><p className="text-xs text-muted-foreground">{t("cloud.files.backupsHint")}</p></div>
        <Button size="sm" isDisabled={busy === "create"} onPress={() => void backup("create")}>{busy === "create" ? <LoaderCircle className="animate-spin" /> : <Plus />}{busy === "create" ? t("cloud.files.creating") : t("cloud.files.createBackup")}</Button>
      </header>
      {backups.length ? <div className="divide-y divide-border">{backups.map((backup) => <div key={backup.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{backup.name}</span>
        <Badge variant="outline">{formatBytes(backup.size)}</Badge>
        <time className="text-xs text-muted-foreground">{new Date(backup.created_at).toLocaleString(language)}</time>
        <Button size="sm" variant="ghost" isDisabled={busy === backup.id} onPress={() => void backup("restore", backup.id)}>{busy === backup.id ? <LoaderCircle className="animate-spin" /> : <ArchiveRestore />}{t("cloud.files.restore")}</Button>
      </div>)}</div> : <p className="p-4 text-sm text-muted-foreground">{t("cloud.files.noBackups")}</p>}
    </section>
    <Dialog isOpen={Boolean(editing)} onOpenChange={(open) => { if (!open && !saving) setEditing(undefined); }}>
      <DialogHeader><DialogTitle>{editing?.path}</DialogTitle><DialogDescription>{t("cloud.files.description")}</DialogDescription></DialogHeader>
      <textarea value={editing?.content ?? ""} onChange={(event) => setEditing((current) => current ? { ...current, content: event.target.value } : current)} spellCheck={false} className="h-80 w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-xs outline-none focus-visible:border-ring" />
      <DialogFooter><Button variant="outline" onPress={() => setEditing(undefined)} isDisabled={saving}>{t("cloud.common.cancel")}</Button><Button onPress={() => void save()} isDisabled={saving}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}{t("cloud.files.save")}</Button></DialogFooter>
    </Dialog>
    <LinkButton size="sm" variant="ghost" href={`/instances/${instanceId}`}><ChevronRight />{t("cloud.instances.detail.back")}</LinkButton>
  </div>;
}
