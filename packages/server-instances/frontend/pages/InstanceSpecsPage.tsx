import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Input, Label, api, useI18n } from "@mirelia/dashboard/frontend";
import { Check, ChevronDown, Cpu, LoaderCircle, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import type { InstanceType } from "./InstancesPage";
import { formatMoney } from "./InstancesPage";

interface SpecRow { id: number; slug: string; type_id: string; name: string; cpu: number; memory_mb: number; disk_gb: number; price_cents: number; enabled: boolean; description: string; instances: number }
interface FormState { id?: number; type_id: string; name: string; cpu: string; memory_mb: string; disk_gb: string; price: string; description: string; enabled: boolean }

const emptyForm = (typeId = ""): FormState => ({ type_id: typeId, name: "", cpu: "1", memory_mb: "1024", disk_gb: "10", price: "10", description: "", enabled: true });

export default function InstanceSpecsPage() {
  const { t, language } = useI18n();
  const [specs, setSpecs] = useState<SpecRow[]>([]);
  const [types, setTypes] = useState<InstanceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<number>();
  const load = useCallback(async () => {
    setError("");
    try { const { data } = await api.get<{ specs: SpecRow[]; types: InstanceType[] }>("/instances/admin/specs"); setSpecs(data.specs); setTypes(data.types); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.spec")); }
    finally { setLoading(false); }
  }, [t]);
  useEffect(() => { void load(); }, [load]);
  const typeName = (id: string) => types.find((type) => type.id === id)?.name ?? id;
  function edit(spec?: SpecRow) {
    setForm(spec ? { id: spec.id, type_id: spec.type_id, name: spec.name, cpu: String(spec.cpu), memory_mb: String(spec.memory_mb), disk_gb: String(spec.disk_gb), price: (spec.price_cents / 100).toFixed(2), description: spec.description, enabled: spec.enabled } : emptyForm(types[0]?.id ?? ""));
    setError(""); setMessage(""); setOpen(true);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError("");
    const payload = {
      type_id: form.type_id,
      name: form.name,
      cpu: Number(form.cpu),
      memory_mb: Number(form.memory_mb),
      disk_gb: Number(form.disk_gb),
      price_cents: Math.round(Number(form.price) * 100),
      description: form.description,
      enabled: form.enabled,
    };
    try {
      if (form.id) await api.put(`/instances/admin/specs/${form.id}`, payload);
      else await api.post("/instances/admin/specs", payload);
      setOpen(false); setMessage(t("cloud.instances.admin.saved"));
      setSpecs((await api.get<{ specs: SpecRow[] }>("/instances/admin/specs")).data.specs);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.spec")); }
    finally { setSaving(false); }
  }
  async function toggle(spec: SpecRow) {
    setBusy(spec.id);
    try { await api.put(`/instances/admin/specs/${spec.id}`, { enabled: !spec.enabled }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.spec")); }
    finally { setBusy(undefined); }
  }
  async function remove(spec: SpecRow) {
    setBusy(spec.id);
    try { await api.delete(`/instances/admin/specs/${spec.id}`); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.specInUse")); }
    finally { setBusy(undefined); }
  }
  const selectedType = types.find((type) => type.id === form.type_id);
  return <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
      <div><p className="mb-1 text-sm text-muted-foreground">{t("cloud.instances.nav.section")}</p><h1 className="text-2xl font-semibold">{t("cloud.instances.admin.title")}</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("cloud.instances.admin.description")}</p></div>
      <div className="flex gap-2"><Button variant="outline" onPress={() => void load()} isDisabled={loading} aria-label={t("cloud.common.retry")}><RefreshCw /></Button><Button onPress={() => edit()} isDisabled={!types.length}><Plus />{t("cloud.instances.admin.newSpec")}</Button></div>
    </div>
    {message && <p role="status" className="mt-4 text-sm text-muted-foreground">{message}</p>}
    {error && !open && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {!types.length && !loading && <p className="mt-4 text-sm text-muted-foreground">{t("cloud.instances.admin.noTypes")}</p>}
    {loading ? <p role="status" className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p>
      : specs.length ? <div className="mt-2 divide-y divide-border border-y border-border">{specs.map((spec) => <article key={spec.id} className="flex flex-wrap items-start justify-between gap-4 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-card"><Server className="size-4 text-muted-foreground" /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h2 className="font-medium">{spec.name}</h2><Badge variant="ghost">{typeName(spec.type_id)}</Badge><Badge variant={spec.enabled ? "secondary" : "outline"}>{spec.enabled ? t("cloud.instances.admin.enabled") : t("cloud.instances.admin.disabled")}</Badge></div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><Cpu className="size-3" />{spec.cpu} vCPU</span><span>{spec.memory_mb} MB</span>{spec.disk_gb ? <span>{spec.disk_gb} GB</span> : null}<span>{spec.instances} {t("cloud.instances.admin.instances")}</span></p>
            {spec.description && <p className="text-xs text-muted-foreground">{spec.description}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-semibold tabular-nums">{formatMoney(language, spec.price_cents)}<span className="ml-1 text-xs font-normal text-muted-foreground">{t("cloud.store.perMonth")}</span></span>
          <Button size="sm" variant="ghost" isDisabled={busy === spec.id} onPress={() => void toggle(spec)}>{spec.enabled ? t("cloud.instances.admin.disabled") : t("cloud.instances.admin.enabled")}</Button>
          <Button size="sm" variant="outline" onPress={() => edit(spec)}><Pencil /></Button>
          <Button size="sm" variant="ghost" isDisabled={busy === spec.id || spec.instances > 0} onPress={() => void remove(spec)}><Trash2 /></Button>
        </div>
      </article>)}</div>
        : <div className="mt-6 flex min-h-40 flex-col items-center justify-center gap-3 border-y border-border text-center"><Server className="size-7 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t("cloud.instances.admin.empty")}</p></div>}
    <Dialog isOpen={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
      <DialogHeader><DialogTitle>{form.id ? t("cloud.instances.admin.editSpec") : t("cloud.instances.admin.newSpec")}</DialogTitle><DialogDescription>{selectedType?.name}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={(event) => void save(event)}>
        <div className="space-y-2"><Label>{t("cloud.instances.admin.type")}</Label>
          <DropdownMenuTrigger>
            <Button type="button" variant="outline" className="w-full justify-between" isDisabled={Boolean(form.id)}>{typeName(form.type_id) || t("cloud.instances.admin.type")}<ChevronDown /></Button>
            <DropdownMenu><DropdownMenuLabel>{t("cloud.instances.admin.type")}</DropdownMenuLabel>{types.map((type) => <DropdownMenuItem key={type.id} onAction={() => setForm((current) => ({ ...current, type_id: type.id }))}>{type.name}{type.id === form.type_id && <Check className="ml-auto size-4" />}</DropdownMenuItem>)}</DropdownMenu>
          </DropdownMenuTrigger>
        </div>
        <div className="space-y-2"><Label htmlFor="spec-name">{t("cloud.instances.admin.name")}</Label><Input id="spec-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2"><Label htmlFor="spec-cpu">{t("cloud.instances.admin.cpu")}</Label><Input id="spec-cpu" inputMode="numeric" value={form.cpu} onChange={(event) => setForm({ ...form, cpu: event.target.value })} required /></div>
          <div className="space-y-2"><Label htmlFor="spec-memory">{t("cloud.instances.admin.memory")}</Label><Input id="spec-memory" inputMode="numeric" value={form.memory_mb} onChange={(event) => setForm({ ...form, memory_mb: event.target.value })} required /></div>
          <div className="space-y-2"><Label htmlFor="spec-disk">{t("cloud.instances.admin.disk")}</Label><Input id="spec-disk" inputMode="numeric" value={form.disk_gb} onChange={(event) => setForm({ ...form, disk_gb: event.target.value })} /></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="spec-price">{t("cloud.instances.admin.price")}</Label><Input id="spec-price" inputMode="decimal" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} required /></div>
          <div className="space-y-2"><Label htmlFor="spec-description">{t("cloud.instances.admin.descriptionField")}</Label><Input id="spec-description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-foreground" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />{t("cloud.instances.admin.enabled")}</label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onPress={() => setOpen(false)} isDisabled={saving}>{t("cloud.common.cancel")}</Button><Button type="submit" isDisabled={saving || !form.type_id || !form.name} >{saving && <LoaderCircle className="animate-spin" />}{saving ? t("cloud.common.saving") : t("cloud.common.save")}</Button></DialogFooter>
      </form>
    </Dialog>
  </div>;
}
