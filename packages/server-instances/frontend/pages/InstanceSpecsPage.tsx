import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Input, Label, api, useI18n } from "@mirelia/dashboard/frontend";
import { Boxes, Check, ChevronDown, Cpu, LoaderCircle, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { formatMoney } from "./InstancesPage";

interface Variant { id: string; title: string; group?: string; version?: string; description?: string; recommended?: boolean }
interface SpecRow { id: number; slug: string; type_id: string; variant_id: string; name: string; cpu: number; memory_mb: number; disk_gb: number; price_cents: number; enabled: boolean; description: string; instances: number }
interface TypeRow { id: string; name: string; tagline?: string; icon?: string; description?: string; basePriceCents?: number; variants: Variant[]; specs: Array<{ id: number }>; instances: number }
interface FormState { id?: number; type_id: string; variant_id: string; name: string; cpu: string; memory_mb: string; disk_gb: string; price: string; description: string; enabled: boolean }

const emptyForm = (typeId = "", variantId = ""): FormState => ({ type_id: typeId, variant_id: variantId, name: "", cpu: "1", memory_mb: "1024", disk_gb: "10", price: "10", description: "", enabled: true });

/** Two-step flow: pick an instance type (Minecraft Java, Shell …), then a variant of it. */
export default function InstanceSpecsPage() {
  const { t, language } = useI18n();
  const [specs, setSpecs] = useState<SpecRow[]>([]);
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [step, setStep] = useState<"type" | "variant" | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<number>();
  const load = useCallback(async () => {
    setError("");
    try {
      const { data } = await api.get<{ specs: SpecRow[]; types: TypeRow[] }>("/instances/admin/specs");
      setSpecs(data.specs); setTypes(data.types);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.spec")); }
    finally { setLoading(false); }
  }, [t]);
  useEffect(() => { void load(); }, [load]);
  const typeOf = (id: string) => types.find((type) => type.id === id);
  const variantOf = (typeId: string, variantId: string) => typeOf(typeId)?.variants.find((variant) => variant.id === variantId);
  const groupedVariants = useMemo(() => {
    const selected = typeOf(form.type_id);
    const groups = new Map<string, Variant[]>();
    for (const variant of selected?.variants ?? []) {
      const key = variant.group ?? "";
      groups.set(key, [...(groups.get(key) ?? []), variant]);
    }
    return [...groups.entries()];
  }, [form.type_id, types]);
  const specsOfType = (typeId: string) => specs.filter((spec) => spec.type_id === typeId);

  function pickType(type: TypeRow) { setStep("variant"); setForm(emptyForm(type.id, "")); setError(""); }
  function pickVariant(variant: Variant) {
    setForm((current) => ({
      ...current, variant_id: variant.id, enabled: true,
      name: [typeOf(current.type_id)?.name, variant.title, variant.version].filter(Boolean).join(" "),
      price: ((typeOf(current.type_id)?.basePriceCents ?? 1000) / 100).toFixed(2),
    }));
    setStep(null); setMessage(""); setError("");
  }
  function edit(spec: SpecRow) {
    setForm({ id: spec.id, type_id: spec.type_id, variant_id: spec.variant_id, name: spec.name, cpu: String(spec.cpu), memory_mb: String(spec.memory_mb), disk_gb: String(spec.disk_gb), price: (spec.price_cents / 100).toFixed(2), description: spec.description, enabled: spec.enabled });
    setStep(null); setError(""); setMessage("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError("");
    const payload = {
      type_id: form.type_id, variant_id: form.variant_id, name: form.name,
      cpu: Number(form.cpu), memory_mb: Number(form.memory_mb), disk_gb: Number(form.disk_gb),
      price_cents: Math.round(Number(form.price) * 100), description: form.description, enabled: form.enabled,
    };
    try {
      if (form.id) await api.put(`/instances/admin/specs/${form.id}`, payload);
      else await api.post("/instances/admin/specs", payload);
      setMessage(t("cloud.instances.admin.saved"));
      setForm(emptyForm());
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
  const selectedType = typeOf(form.type_id);
  const selectedVariant = variantOf(form.type_id, form.variant_id);
  return <div className="mx-auto w-full max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
      <div><p className="mb-1 text-sm text-muted-foreground">{t("cloud.instances.nav.section")}</p><h1 className="text-2xl font-semibold">{t("cloud.instances.admin.title")}</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("cloud.instances.admin.description")}</p></div>
      <div className="flex gap-2"><Button variant="outline" onPress={() => void load()} isDisabled={loading} aria-label={t("cloud.common.retry")}><RefreshCw /></Button><Button onPress={() => { setForm(emptyForm()); setStep("type"); }} isDisabled={!types.length}><Plus />{t("cloud.instances.admin.newSpec")}</Button></div>
    </div>
    {message && <p role="status" className="mt-4 text-sm text-muted-foreground">{message}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {loading ? <p role="status" className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p>
      : <div className="mt-6 space-y-8">{[...types].sort((a, b) => a.name.localeCompare(b.name)).map((type) => <section key={type.id}>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2">
          <div className="flex items-center gap-2"><span className="grid size-9 place-items-center rounded-md border border-border bg-card"><Boxes className="size-4 text-muted-foreground" /></span><div><p className="flex flex-wrap items-center gap-2 font-medium">{type.name}{type.tagline && <Badge variant="ghost">{type.tagline}</Badge>}<Badge variant="outline">{type.id}</Badge></p><p className="text-xs text-muted-foreground">{type.description ?? `${type.variants.length} ${t("cloud.instances.admin.variants")} · ${type.instances} ${t("cloud.instances.admin.instances")}`}</p></div></div>
          <Button size="sm" variant="outline" onPress={() => { setForm(emptyForm(type.id, "")); setStep("variant"); }}><Plus />{t("cloud.instances.admin.newSpec")}</Button>
        </header>
        {specsOfType(type.id).length ? <div className="divide-y divide-border">{specsOfType(type.id).map((spec) => <article key={spec.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{spec.name}{spec.variant_id && <Badge variant="ghost">{variantOf(spec.type_id, spec.variant_id)?.title ?? spec.variant_id}</Badge>}{spec.variant_id && variantOf(spec.type_id, spec.variant_id)?.version && <span className="text-xs text-muted-foreground">{variantOf(spec.type_id, spec.variant_id)?.version}</span>}<Badge variant={spec.enabled ? "secondary" : "outline"}>{spec.enabled ? t("cloud.instances.admin.enabled") : t("cloud.instances.admin.disabled")}</Badge></p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><Cpu className="size-3" />{spec.cpu} vCPU</span><span>{spec.memory_mb} MB</span>{spec.disk_gb ? <span>{spec.disk_gb} GB</span> : null}<span>{spec.instances} {t("cloud.instances.admin.instances")}</span>{spec.description && <span>{spec.description}</span>}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold tabular-nums">{formatMoney(language, spec.price_cents)}<span className="ml-1 text-xs font-normal text-muted-foreground">{t("cloud.store.perMonth")}</span></span>
            <Button size="sm" variant="ghost" isDisabled={busy === spec.id} onPress={() => void toggle(spec)}>{spec.enabled ? t("cloud.instances.admin.disabled") : t("cloud.instances.admin.enabled")}</Button>
            <Button size="sm" variant="outline" aria-label={t("cloud.instances.admin.editSpec")} onPress={() => edit(spec)}><Pencil /></Button>
            <Button size="sm" variant="ghost" isDisabled={busy === spec.id || spec.instances > 0} onPress={() => void remove(spec)}><Trash2 /></Button>
          </div>
        </article>)}</div>
          : <p className="py-4 text-sm text-muted-foreground">{t("cloud.instances.admin.empty")}</p>}
      </section>)}</div>}
    <Dialog isOpen={Boolean(step)} onOpenChange={(open) => { if (!open) setStep(null); }}>
      {step === "type" ? <>
        <DialogHeader><DialogTitle>{t("cloud.instances.admin.pickType")}</DialogTitle><DialogDescription>{t("cloud.instances.admin.pickTypeHint")}</DialogDescription></DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2">
          {types.map((type) => <button key={type.id} type="button" onClick={() => pickType(type)} className="flex items-center gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-card"><Server className="size-4 text-muted-foreground" /></span>
            <span className="min-w-0"><span className="block text-sm font-medium">{type.name}</span><span className="block truncate text-xs text-muted-foreground">{type.tagline ?? `${type.variants.length} ${t("cloud.instances.admin.variants")}`}</span></span>
          </button>)}
        </div>
        <DialogFooter><Button variant="outline" onPress={() => setStep(null)}>{t("cloud.common.cancel")}</Button></DialogFooter>
      </> : <>
        <DialogHeader><DialogTitle>{selectedType?.name}</DialogTitle><DialogDescription>{t("cloud.instances.admin.pickVariantHint")}</DialogDescription></DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {groupedVariants.map(([group, variants]) => <div key={group} className="space-y-1">
            {group && <p className="text-xs font-medium uppercase text-muted-foreground">{group}</p>}
            {variants.map((variant) => <button key={variant.id} type="button" onClick={() => pickVariant(variant)} className="flex w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted">
              <span className="min-w-0"><span className="block truncate font-medium">{variant.title}{variant.recommended && <Badge variant="secondary" className="ml-2">{t("cloud.instances.admin.recommended")}</Badge>}</span>{variant.description && <span className="block truncate text-xs text-muted-foreground">{variant.description}</span>}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{variant.version ?? ""}</span>
            </button>)}
          </div>)}
          {!groupedVariants.length && <p className="text-sm text-muted-foreground">{t("cloud.instances.admin.noVariants")}</p>}
        </div>
        <DialogFooter><Button variant="outline" onPress={() => setStep("type")}>{t("cloud.common.cancel")}</Button></DialogFooter>
      </>}
    </Dialog>
    <Dialog isOpen={Boolean(form.type_id && form.variant_id)} onOpenChange={(open) => { if (!open && !saving) setForm(emptyForm()); }}>
      <DialogHeader><DialogTitle>{form.id ? t("cloud.instances.admin.editSpec") : t("cloud.instances.admin.newSpec")}</DialogTitle><DialogDescription>{selectedType?.name} · {selectedVariant?.title}{selectedVariant?.version ? ` ${selectedVariant.version}` : ""}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={(event) => void save(event)}>
        {form.id && <div className="space-y-2"><Label>{t("cloud.instances.admin.type")}</Label>
          <DropdownMenuTrigger><Button type="button" variant="outline" className="w-full justify-between">{selectedType?.name ?? t("cloud.instances.admin.type")}<ChevronDown /></Button>
            <DropdownMenu><DropdownMenuLabel>{t("cloud.instances.admin.variant")}</DropdownMenuLabel>{groupedVariants.flatMap(([, variants]) => variants).map((variant) => <DropdownMenuItem key={variant.id} onAction={() => setForm((current) => ({ ...current, variant_id: variant.id }))}>{variant.title}{variant.version ? ` ${variant.version}` : ""}{variant.id === form.variant_id && <Check className="ml-auto size-4" />}</DropdownMenuItem>)}</DropdownMenu>
          </DropdownMenuTrigger></div>}
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
        <DialogFooter><Button type="button" variant="outline" onPress={() => setForm(emptyForm())} isDisabled={saving}>{t("cloud.common.cancel")}</Button><Button type="submit" isDisabled={saving || !form.type_id || !form.variant_id || !form.name}>{saving && <LoaderCircle className="animate-spin" />}{saving ? t("cloud.common.saving") : t("cloud.common.save")}</Button></DialogFooter>
      </form>
    </Dialog>
  </div>;
}
