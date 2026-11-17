import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, api, useI18n } from "@mirelia/dashboard/frontend";
import { Boxes, Check, ChevronDown, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";

export interface Group { id: number; type_id: string; slug: string; name: string; description: string; sort_order: number; enabled: boolean; presets: number; instances: number }
export interface Spec { id: number; name: string; cpu: number; memory_mb: number; disk_gb: number; price_cents: number; enabled: boolean; sort_order: number; description: string; instances: number }
export interface Param { key: string; field: { type: string; title?: string; default?: string | number | boolean; description?: string }; scope: "purchase" | "provision" }
export interface Preset {
  id: number; group_id: number; slug: string; name: string; tagline: string; icon: string; description: string; image: string;
  pull_policy: "missing" | "always" | "never"; command: string; workdir: string; env: Record<string, string>;
  ports: Array<{ name: string; container: number; protocol: "tcp" | "udp"; host: number | "auto" }>;
  mounts: Array<{ source: string; target: string; mode: "rw" | "ro" }>;
  files: Array<{ source: "inline" | "url" | "path"; value: string; target: string; overwrite: boolean }>;
  params: Param[]; health: { kind: "none" | "tcp" | "http" | "log"; target: string; timeoutSeconds: number };
  stop_signal: string; stop_timeout_seconds: number; restart: "no" | "on-failure" | "always";
  limits: { cpu?: number; memoryMb?: number; pids?: number };
  specs: number[]; sort_order: number; enabled: boolean; group?: Group;
}

type Draft = Omit<Preset, "id" | "slug" | "group"> & { id?: number };

const emptyPreset = (groupId: number): Draft => ({
  group_id: groupId, name: "", tagline: "", icon: "", description: "", image: "",
  pull_policy: "missing", command: "", workdir: "", env: {}, ports: [{ name: "game", container: 25565, protocol: "tcp", host: "auto" }],
  mounts: [{ source: "server", target: "/data", mode: "rw" }], files: [], params: [],
  health: { kind: "none", target: "", timeoutSeconds: 180 }, stop_signal: "SIGTERM", stop_timeout_seconds: 30,
  restart: "no", limits: {}, specs: [], sort_order: 100, enabled: true,
});

export default function AdminInstancesPage() {
  const { t } = useI18n();
  const [groups, setGroups] = useState<Group[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [types, setTypes] = useState<Array<{ id: string; name: string }>>([]);
  const [docker, setDocker] = useState<{ reachable: boolean; socket: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [groupDialog, setGroupDialog] = useState<{ id?: number; name: string; type_id: string; description: string }>();
  const [presetDraft, setPresetDraft] = useState<Draft>();
  const [specDialog, setSpecDialog] = useState<{ id?: number; name: string; cpu: string; memory_mb: string; disk_gb: string; price: string; description: string }>();
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [groupData, presetData, specData, typeData, dockerData] = await Promise.all([
        api.get<{ groups: Group[] }>("/instances/admin/groups"),
        api.get<{ presets: Preset[] }>("/instances/admin/presets"),
        api.get<{ specs: Spec[] }>("/instances/admin/specs"),
        api.get<{ types: Array<{ id: string; name: string }> }>("/instances/types"),
        api.get<{ reachable: boolean; socket: string }>("/instances/docker/status").catch(() => ({ data: { reachable: false, socket: "" } })),
      ]);
      setGroups(groupData.data.groups); setPresets(presetData.data.presets); setSpecs(specData.data.specs);
      setTypes(typeData.data.types); setDocker(dockerData.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "load failed"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!groupDialog) return;
    setSaving(true); setError("");
    try {
      const payload = { name: groupDialog.name, type_id: groupDialog.type_id, description: groupDialog.description };
      if (groupDialog.id) await api.put(`/instances/admin/groups/${groupDialog.id}`, payload);
      else await api.post("/instances/admin/groups", payload);
      setGroupDialog(undefined); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "save failed"); }
    finally { setSaving(false); }
  }
  async function savePreset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!presetDraft) return;
    setSaving(true); setError("");
    try {
      if (presetDraft.id) await api.put(`/instances/admin/presets/${presetDraft.id}`, presetDraft);
      else await api.post("/instances/admin/presets", presetDraft);
      setPresetDraft(undefined); setMessage(t("cloud.instances.admin.saved")); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "save failed"); }
    finally { setSaving(false); }
  }
  async function saveSpec(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!specDialog) return;
    setSaving(true); setError("");
    try {
      const payload = { name: specDialog.name, cpu: Number(specDialog.cpu), memory_mb: Number(specDialog.memory_mb), disk_gb: Number(specDialog.disk_gb), price_cents: Math.round(Number(specDialog.price) * 100), description: specDialog.description };
      if (specDialog.id) await api.put(`/instances/admin/specs/${specDialog.id}`, payload);
      else await api.post("/instances/admin/specs", payload);
      setSpecDialog(undefined); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "save failed"); }
    finally { setSaving(false); }
  }
  async function remove(path: string) {
    setError("");
    try { await api.delete(path); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "delete failed"); }
  }
  const editPreset = (preset: Preset) => setPresetDraft({ ...preset });
  const patch = (values: Partial<Draft>) => setPresetDraft((current) => current ? { ...current, ...values } : current);

  return <div className="mx-auto w-full max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
      <div><p className="mb-1 text-sm text-muted-foreground">{t("cloud.instances.nav.section")}</p><h1 className="text-2xl font-semibold">{t("cloud.instances.admin.title")}</h1><p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("cloud.instances.admin.description")}</p></div>
      <Button variant="outline" onPress={() => void load()} isDisabled={loading} aria-label={t("cloud.common.retry")}><RefreshCw /></Button>
    </div>
    {docker && !docker.reachable && <p role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{t("cloud.instances.errors.docker", { socket: docker.socket })}</p>}
    {message && <p role="status" className="mt-4 text-sm text-muted-foreground">{message}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {loading ? <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p> : <>
      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t("cloud.instances.admin.groups")}</h2><Button size="sm" onPress={() => setGroupDialog({ name: "", type_id: types[0]?.id ?? "", description: "" })} isDisabled={!types.length}><Plus />{t("cloud.instances.admin.newGroup")}</Button></div>
        {groups.length ? <div className="divide-y divide-border border-y border-border">{groups.map((group) => <div key={group.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0"><p className="flex flex-wrap items-center gap-2 font-medium">{group.name}<Badge variant="outline">{group.type_id}</Badge><Badge variant={group.enabled ? "secondary" : "outline"}>{group.enabled ? t("cloud.instances.admin.enabled") : t("cloud.instances.admin.disabled")}</Badge></p><p className="text-xs text-muted-foreground">{group.description || group.slug} · {group.presets} {t("cloud.instances.admin.presets")} · {group.instances} {t("cloud.instances.admin.instances")}</p></div>
          <div className="flex gap-2"><Button size="sm" variant="outline" onPress={() => setGroupDialog({ id: group.id, name: group.name, type_id: group.type_id, description: group.description })}><Pencil /></Button><Button size="sm" variant="ghost" onPress={() => void remove(`/instances/admin/groups/${group.id}`)}><Trash2 /></Button></div>
        </div>)}</div> : <p className="border-y border-border py-4 text-sm text-muted-foreground">{t("cloud.instances.admin.noGroups")}</p>}
        {!types.length && <p className="mt-2 text-xs text-muted-foreground">{t("cloud.instances.admin.noTypes")}</p>}
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t("cloud.instances.admin.presets")}</h2><Button size="sm" onPress={() => setPresetDraft(emptyPreset(groups[0]?.id ?? 0))} isDisabled={!groups.length}><Plus />{t("cloud.instances.admin.newPreset")}</Button></div>
        {presets.length ? <div className="divide-y divide-border border-y border-border">{presets.map((preset) => <div key={preset.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0"><p className="flex flex-wrap items-center gap-2 font-medium">{preset.name}{preset.tagline && <span className="text-xs font-normal text-muted-foreground">{preset.tagline}</span>}<Badge variant="ghost">{preset.group?.name ?? preset.group_id}</Badge><Badge variant={preset.enabled ? "secondary" : "outline"}>{preset.enabled ? t("cloud.instances.admin.enabled") : t("cloud.instances.admin.disabled")}</Badge></p><p className="truncate text-xs text-muted-foreground">{preset.image} · {preset.ports.length} {t("cloud.instances.admin.ports")} · {preset.params.length} {t("cloud.instances.admin.params")} · {preset.specs.length} {t("cloud.instances.admin.specsCount")}</p></div>
          <div className="flex gap-2"><Button size="sm" variant="outline" onPress={() => editPreset(preset)}><Pencil /></Button><Button size="sm" variant="ghost" onPress={() => void remove(`/instances/admin/presets/${preset.id}`)}><Trash2 /></Button></div>
        </div>)}</div> : <p className="border-y border-border py-4 text-sm text-muted-foreground">{t("cloud.instances.admin.noPresets")}</p>}
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t("cloud.instances.admin.specs")}</h2><Button size="sm" onPress={() => setSpecDialog({ name: "", cpu: "1", memory_mb: "1024", disk_gb: "10", price: "10", description: "" })}><Plus />{t("cloud.instances.admin.newSpec")}</Button></div>
        {specs.length ? <div className="divide-y divide-border border-y border-border">{specs.map((spec) => <div key={spec.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0"><p className="flex flex-wrap items-center gap-2 font-medium">{spec.name}<Badge variant={spec.enabled ? "secondary" : "outline"}>{spec.enabled ? t("cloud.instances.admin.enabled") : t("cloud.instances.admin.disabled")}</Badge></p><p className="text-xs text-muted-foreground">{spec.cpu} vCPU · {spec.memory_mb} MB · {spec.disk_gb} GB · {spec.instances} {t("cloud.instances.admin.instances")}</p></div>
          <div className="flex items-center gap-2"><span className="text-sm font-semibold tabular-nums">¥{(spec.price_cents / 100).toFixed(2)}</span><Button size="sm" variant="outline" onPress={() => setSpecDialog({ id: spec.id, name: spec.name, cpu: String(spec.cpu), memory_mb: String(spec.memory_mb), disk_gb: String(spec.disk_gb), price: (spec.price_cents / 100).toFixed(2), description: spec.description })}><Pencil /></Button><Button size="sm" variant="ghost" onPress={() => void remove(`/instances/admin/specs/${spec.id}`)}><Trash2 /></Button></div>
        </div>)}</div> : <p className="border-y border-border py-4 text-sm text-muted-foreground">{t("cloud.instances.admin.noSpecs")}</p>}
      </section>
    </>}

    <Dialog isOpen={Boolean(groupDialog)} onOpenChange={(open) => { if (!open) setGroupDialog(undefined); }}>
      <DialogHeader><DialogTitle>{groupDialog?.id ? t("cloud.instances.admin.editGroup") : t("cloud.instances.admin.newGroup")}</DialogTitle><DialogDescription>{t("cloud.instances.admin.groupHint")}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={(event) => void saveGroup(event)}>
        <div className="space-y-2"><Label htmlFor="group-name">{t("cloud.instances.admin.name")}</Label><Input id="group-name" value={groupDialog?.name ?? ""} onChange={(event) => setGroupDialog((current) => current ? { ...current, name: event.target.value } : current)} required /></div>
        <div className="space-y-2"><Label htmlFor="group-type">{t("cloud.instances.admin.type")}</Label><select id="group-type" className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" value={groupDialog?.type_id ?? ""} onChange={(event) => setGroupDialog((current) => current ? { ...current, type_id: event.target.value } : current)} disabled={Boolean(groupDialog?.id)}>{(groupDialog?.id ? [{ id: groupDialog.type_id, name: groupDialog.type_id }] : types).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></div>
        <div className="space-y-2"><Label htmlFor="group-desc">{t("cloud.instances.admin.descriptionField")}</Label><Input id="group-desc" value={groupDialog?.description ?? ""} onChange={(event) => setGroupDialog((current) => current ? { ...current, description: event.target.value } : current)} /></div>
        <DialogFooter><Button type="button" variant="outline" onPress={() => setGroupDialog(undefined)}>{t("cloud.common.cancel")}</Button><Button type="submit" isDisabled={saving}>{(saving) && <LoaderCircle className="animate-spin" />}{t("cloud.common.save")}</Button></DialogFooter>
      </form>
    </Dialog>

    <Dialog isOpen={Boolean(specDialog)} onOpenChange={(open) => { if (!open) setSpecDialog(undefined); }}>
      <DialogHeader><DialogTitle>{specDialog?.id ? t("cloud.instances.admin.editSpec") : t("cloud.instances.admin.newSpec")}</DialogTitle><DialogDescription>{t("cloud.instances.admin.specHint")}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={(event) => void saveSpec(event)}>
        <div className="space-y-2"><Label htmlFor="spec-name">{t("cloud.instances.admin.name")}</Label><Input id="spec-name" value={specDialog?.name ?? ""} onChange={(event) => setSpecDialog((current) => current ? { ...current, name: event.target.value } : current)} required /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="spec-cpu">{t("cloud.instances.admin.cpu")}</Label><Input id="spec-cpu" inputMode="decimal" value={specDialog?.cpu ?? "1"} onChange={(event) => setSpecDialog((current) => current ? { ...current, cpu: event.target.value } : current)} /></div>
          <div className="space-y-2"><Label htmlFor="spec-mem">{t("cloud.instances.admin.memory")}</Label><Input id="spec-mem" inputMode="numeric" value={specDialog?.memory_mb ?? "1024"} onChange={(event) => setSpecDialog((current) => current ? { ...current, memory_mb: event.target.value } : current)} /></div>
          <div className="space-y-2"><Label htmlFor="spec-disk">{t("cloud.instances.admin.disk")}</Label><Input id="spec-disk" inputMode="numeric" value={specDialog?.disk_gb ?? "10"} onChange={(event) => setSpecDialog((current) => current ? { ...current, disk_gb: event.target.value } : current)} /></div>
          <div className="space-y-2"><Label htmlFor="spec-price">{t("cloud.instances.admin.price")}</Label><Input id="spec-price" inputMode="decimal" value={specDialog?.price ?? "10"} onChange={(event) => setSpecDialog((current) => current ? { ...current, price: event.target.value } : current)} /></div>
        </div>
        <DialogFooter><Button type="button" variant="outline" onPress={() => setSpecDialog(undefined)}>{t("cloud.common.cancel")}</Button><Button type="submit" isDisabled={saving}>{saving && <LoaderCircle className="animate-spin" />}{t("cloud.common.save")}</Button></DialogFooter>
      </form>
    </Dialog>

    <Dialog isOpen={Boolean(presetDraft)} onOpenChange={(open) => { if (!open && !saving) setPresetDraft(undefined); }}>
      <DialogHeader><DialogTitle>{presetDraft?.id ? t("cloud.instances.admin.editPreset") : t("cloud.instances.admin.newPreset")}</DialogTitle><DialogDescription>{t("cloud.instances.admin.presetHint")}</DialogDescription></DialogHeader>
      {presetDraft && <form className="max-h-[70vh] space-y-5 overflow-y-auto pr-1" onSubmit={(event) => void savePreset(event)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="p-name">{t("cloud.instances.admin.name")}</Label><Input id="p-name" value={presetDraft.name} onChange={(event) => patch({ name: event.target.value })} required /></div>
          <div className="space-y-2"><Label htmlFor="p-tagline">{t("cloud.instances.admin.tagline")}</Label><Input id="p-tagline" value={presetDraft.tagline} onChange={(event) => patch({ tagline: event.target.value })} /></div>
          <div className="space-y-2"><Label htmlFor="p-group">{t("cloud.instances.admin.group")}</Label><select id="p-group" className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" value={presetDraft.group_id} onChange={(event) => patch({ group_id: Number(event.target.value) })}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>
          <div className="space-y-2"><Label htmlFor="p-image">{t("cloud.instances.admin.image")}</Label><Input id="p-image" value={presetDraft.image} onChange={(event) => patch({ image: event.target.value })} placeholder="itzg/minecraft-server:java21" required /></div>
        </div>
        <div className="space-y-2"><Label htmlFor="p-command">{t("cloud.instances.admin.command")}</Label><Input id="p-command" value={presetDraft.command} onChange={(event) => patch({ command: event.target.value })} placeholder="(image default)" /></div>
        <div className="space-y-2"><Label htmlFor="p-workdir">{t("cloud.instances.admin.workdir")}</Label><Input id="p-workdir" value={presetDraft.workdir} onChange={(event) => patch({ workdir: event.target.value })} placeholder="/data" /></div>

        <div>
          <div className="mb-2 flex items-center justify-between"><Label>{t("cloud.instances.admin.env")}</Label><Button type="button" size="sm" variant="ghost" onPress={() => patch({ env: { ...presetDraft.env, [`NEW_${Object.keys(presetDraft.env).length + 1}`]: "" } })}><Plus />{t("cloud.instances.admin.add")}</Button></div>
          <div className="space-y-2">{Object.entries(presetDraft.env).map(([key, value]) => <div key={key} className="flex gap-2"><Input value={key} className="w-40 font-mono" aria-label="env key" onChange={(event) => { const next = { ...presetDraft.env }; delete next[key]; next[event.target.value] = value; patch({ env: next }); }} /><Input value={value} className="flex-1 font-mono" aria-label="env value" onChange={(event) => patch({ env: { ...presetDraft.env, [key]: event.target.value } })} /><Button type="button" size="icon-sm" variant="ghost" onPress={() => { const next = { ...presetDraft.env }; delete next[key]; patch({ env: next }); }}><X /></Button></div>)}</div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between"><Label>{t("cloud.instances.admin.ports")}</Label><Button type="button" size="sm" variant="ghost" onPress={() => patch({ ports: [...presetDraft.ports, { name: `port${presetDraft.ports.length + 1}`, container: 8080, protocol: "tcp", host: "auto" }] })}><Plus />{t("cloud.instances.admin.add")}</Button></div>
          <div className="space-y-2">{presetDraft.ports.map((port, index) => <div key={index} className="flex flex-wrap gap-2">
            <Input value={port.name} className="w-28" aria-label="port name" onChange={(event) => patch({ ports: presetDraft.ports.map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry) })} />
            <Input value={String(port.container)} className="w-24" aria-label="container port" inputMode="numeric" onChange={(event) => patch({ ports: presetDraft.ports.map((entry, i) => i === index ? { ...entry, container: Number(event.target.value) } : entry) })} />
            <Input value={String(port.host)} className="w-24" aria-label="host port" onChange={(event) => patch({ ports: presetDraft.ports.map((entry, i) => i === index ? { ...entry, host: event.target.value === "auto" ? "auto" : Number(event.target.value) } : entry) })} />
            <Button type="button" size="sm" variant={port.protocol === "udp" ? "secondary" : "outline"} onPress={() => patch({ ports: presetDraft.ports.map((entry, i) => i === index ? { ...entry, protocol: entry.protocol === "udp" ? "tcp" : "udp" } : entry) })}>{port.protocol}</Button>
            <Button type="button" size="icon-sm" variant="ghost" onPress={() => patch({ ports: presetDraft.ports.filter((_, i) => i !== index) })}><X /></Button>
          </div>)}</div>
          <p className="mt-1 text-xs text-muted-foreground">{t("cloud.instances.admin.hostPortHint")}</p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between"><Label>{t("cloud.instances.admin.mounts")}</Label><Button type="button" size="sm" variant="ghost" onPress={() => patch({ mounts: [...presetDraft.mounts, { source: "server", target: "/data", mode: "rw" }] })}><Plus />{t("cloud.instances.admin.add")}</Button></div>
          <div className="space-y-2">{presetDraft.mounts.map((mount, index) => <div key={index} className="flex flex-wrap gap-2">
            <Input value={mount.source} className="w-36 font-mono" aria-label="mount source" onChange={(event) => patch({ mounts: presetDraft.mounts.map((entry, i) => i === index ? { ...entry, source: event.target.value } : entry) })} />
            <Input value={mount.target} className="flex-1 font-mono" aria-label="mount target" onChange={(event) => patch({ mounts: presetDraft.mounts.map((entry, i) => i === index ? { ...entry, target: event.target.value } : entry) })} />
            <Button type="button" size="sm" variant={mount.mode === "ro" ? "secondary" : "outline"} onPress={() => patch({ mounts: presetDraft.mounts.map((entry, i) => i === index ? { ...entry, mode: entry.mode === "ro" ? "rw" : "ro" } : entry) })}>{mount.mode}</Button>
            <Button type="button" size="icon-sm" variant="ghost" onPress={() => patch({ mounts: presetDraft.mounts.filter((_, i) => i !== index) })}><X /></Button>
          </div>)}</div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between"><Label>{t("cloud.instances.admin.files")}</Label><Button type="button" size="sm" variant="ghost" onPress={() => patch({ files: [...presetDraft.files, { source: "inline", value: "", target: "server/server.properties", overwrite: false }] })}><Plus />{t("cloud.instances.admin.add")}</Button></div>
          <div className="space-y-2">{presetDraft.files.map((file, index) => <div key={index} className="space-y-1 rounded-md border border-border p-2">
            <div className="flex flex-wrap gap-2">
              <select className="h-8 rounded-md border border-border bg-background px-2 text-sm" value={file.source} aria-label="file source" onChange={(event) => patch({ files: presetDraft.files.map((entry, i) => i === index ? { ...entry, source: event.target.value as typeof entry.source } : entry) })}><option value="inline">inline</option><option value="url">url</option><option value="path">path</option></select>
              <Input value={file.target} className="flex-1 font-mono" aria-label="file target" placeholder="server/eula.txt" onChange={(event) => patch({ files: presetDraft.files.map((entry, i) => i === index ? { ...entry, target: event.target.value } : entry) })} />
              <Button type="button" size="sm" variant={file.overwrite ? "secondary" : "outline"} onPress={() => patch({ files: presetDraft.files.map((entry, i) => i === index ? { ...entry, overwrite: !entry.overwrite } : entry) })}>{t("cloud.instances.admin.overwrite")}</Button>
              <Button type="button" size="icon-sm" variant="ghost" onPress={() => patch({ files: presetDraft.files.filter((_, i) => i !== index) })}><X /></Button>
            </div>
            <textarea value={file.value} spellCheck={false} rows={2} className="w-full rounded-md border border-border bg-muted/30 p-2 font-mono text-xs outline-none focus-visible:border-ring" placeholder="eula=true" aria-label="file content" onChange={(event) => patch({ files: presetDraft.files.map((entry, i) => i === index ? { ...entry, value: event.target.value } : entry) })} />
          </div>)}</div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between"><Label>{t("cloud.instances.admin.params")}</Label><Button type="button" size="sm" variant="ghost" onPress={() => patch({ params: [...presetDraft.params, { key: `OPTION_${presetDraft.params.length + 1}`, scope: "purchase", field: { type: "string", title: "" } }] })}><Plus />{t("cloud.instances.admin.add")}</Button></div>
          <p className="mb-2 text-xs text-muted-foreground">{t("cloud.instances.admin.paramsHint")}</p>
          <div className="space-y-2">{presetDraft.params.map((param, index) => <div key={index} className="flex flex-wrap gap-2">
            <Input value={param.key} className="w-40 font-mono" aria-label="param key" onChange={(event) => patch({ params: presetDraft.params.map((entry, i) => i === index ? { ...entry, key: event.target.value } : entry) })} />
            <Input value={param.field.title ?? ""} className="w-36" aria-label="param title" placeholder={t("cloud.instances.admin.paramTitle")} onChange={(event) => patch({ params: presetDraft.params.map((entry, i) => i === index ? { ...entry, field: { ...entry.field, title: event.target.value } } : entry) })} />
            <Input value={param.field.type === "enum" ? String(param.field.title ?? "") : String(param.field.default ?? "")} className="flex-1" aria-label="param default" placeholder={t("cloud.instances.admin.paramDefault")} onChange={(event) => patch({ params: presetDraft.params.map((entry, i) => i === index ? { ...entry, field: { ...entry.field, default: event.target.value } } : entry) })} />
            <select className="h-8 rounded-md border border-border bg-background px-2 text-sm" value={param.field.type} aria-label="param type" onChange={(event) => patch({ params: presetDraft.params.map((entry, i) => i === index ? { ...entry, field: { ...entry.field, type: event.target.value } } : entry) })}><option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option></select>
            <select className="h-8 rounded-md border border-border bg-background px-2 text-sm" value={param.scope} aria-label="param scope" onChange={(event) => patch({ params: presetDraft.params.map((entry, i) => i === index ? { ...entry, scope: event.target.value as typeof entry.scope } : entry) })}><option value="purchase">purchase</option><option value="provision">provision</option></select>
            <Button type="button" size="icon-sm" variant="ghost" onPress={() => patch({ params: presetDraft.params.filter((_, i) => i !== index) })}><X /></Button>
          </div>)}</div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between"><Label>{t("cloud.instances.admin.specsCount")}</Label></div>
          <div className="flex flex-wrap gap-2">{specs.map((spec) => {
            const chosen = presetDraft.specs.includes(spec.id);
            return <Button key={spec.id} type="button" size="sm" variant={chosen ? "secondary" : "outline"} aria-pressed={chosen} onPress={() => patch({ specs: chosen ? presetDraft.specs.filter((id) => id !== spec.id) : [...presetDraft.specs, spec.id] })}>{chosen && <Check />}{spec.name}</Button>;
          })}</div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2"><Label htmlFor="p-health">{t("cloud.instances.admin.health")}</Label><select id="p-health" className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" value={presetDraft.health.kind} onChange={(event) => patch({ health: { ...presetDraft.health, kind: event.target.value as typeof presetDraft.health.kind } })}><option value="none">none</option><option value="tcp">tcp</option><option value="http">http</option><option value="log">log</option></select></div>
          <div className="space-y-2"><Label htmlFor="p-health-target">{t("cloud.instances.admin.healthTarget")}</Label><Input id="p-health-target" value={presetDraft.health.target} onChange={(event) => patch({ health: { ...presetDraft.health, target: event.target.value } })} /></div>
          <div className="space-y-2"><Label htmlFor="p-restart">{t("cloud.instances.admin.restart")}</Label><select id="p-restart" className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" value={presetDraft.restart} onChange={(event) => patch({ restart: event.target.value as typeof presetDraft.restart })}><option value="no">no</option><option value="on-failure">on-failure</option><option value="always">always</option></select></div>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onPress={() => setPresetDraft(undefined)} isDisabled={saving}>{t("cloud.common.cancel")}</Button><Button type="submit" isDisabled={saving || !presetDraft.name || !presetDraft.image}>{saving && <LoaderCircle className="animate-spin" />}{t("cloud.common.save")}</Button></DialogFooter>
      </form>}
    </Dialog>
  </div>;
}
