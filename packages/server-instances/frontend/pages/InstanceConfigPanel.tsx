import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Check, ChevronDown, DropdownMenu, DropdownMenuItem, DropdownMenuTrigger, Input, Label, api, useI18n } from "@mirelia/dashboard/frontend";
import { LoaderCircle, RotateCcw, Save, Search, Settings2 } from "lucide-react";

export type ConfigField =
  | { type: "string"; title?: string; description?: string; default?: string; maxLength?: number; minLength?: number }
  | { type: "number" | "integer"; title?: string; description?: string; default?: number; minimum?: number; maximum?: number; step?: number }
  | { type: "boolean"; title?: string; description?: string; default?: boolean }
  | { type: "enum"; title?: string; description?: string; default?: string; values: Array<{ value: string; title?: string; description?: string }> }
  | { type: "array"; title?: string; description?: string; items: ConfigField };

export interface ConfigSection { id: string; title: string; description?: string; fields: Record<string, ConfigField> }
export interface ConfigSchema { version: number; sections: ConfigSection[] }
export type ConfigValues = Record<string, string | number | boolean>;

interface ConfigPayload { schema: ConfigSchema; values: ConfigValues; summary?: string }

/**
 * Renders any instance type's configuration from its schema and posts the changed keys
 * back. Types do not ship a page for this: the schema drives the whole form.
 */
export default function InstanceConfigPanel({ instanceId, schema: providedSchema, values: providedValues, onSaved }: {
  instanceId: string;
  schema?: ConfigSchema;
  values?: ConfigValues;
  onSaved?: (values: ConfigValues, summary?: string) => void;
}) {
  const { t } = useI18n();
  const [schema, setSchema] = useState<ConfigSchema | undefined>(providedSchema);
  const [values, setValues] = useState<ConfigValues>(providedValues ?? {});
  const [dirty, setDirty] = useState<ConfigValues>({});
  const [active, setActive] = useState<string>();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(!providedSchema);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<ConfigPayload>(`/instances/${instanceId}/config`);
      setSchema(data.schema);
      setValues(data.values);
      setDirty({});
      setActive((current) => current ?? data.schema.sections[0]?.id);
    } catch { setErrors({ _: t("cloud.instances.errors.notFound") }); }
    finally { setLoading(false); }
  }, [instanceId, t]);
  useEffect(() => { if (!providedSchema) void load(); }, [load, providedSchema]);
  useEffect(() => {
    if (providedSchema) { setSchema(providedSchema); setValues(providedValues ?? {}); setActive((current) => current ?? providedSchema.sections[0]?.id); }
  }, [providedSchema, providedValues]);

  const sections = useMemo(() => {
    const list = schema?.sections ?? [];
    if (!search.trim()) return list;
    const query = search.trim().toLowerCase();
    return list.map((section) => ({
      ...section,
      fields: Object.fromEntries(Object.entries(section.fields).filter(([key, field]) => `${key} ${field.title ?? ""}`.toLowerCase().includes(query))),
    })).filter((section) => Object.keys(section.fields).length);
  }, [schema, search]);
  useEffect(() => { if (!active && sections.length) setActive(sections[0].id); }, [sections, active]);

  const current = (key: string, field: ConfigField) => {
    const value = key in dirty ? dirty[key] : values[key];
    if (value !== undefined) return value;
    return "default" in field ? field.default : undefined;
  };
  const update = (key: string, value: string | number | boolean) => {
    setDirty((existing) => ({ ...existing, [key]: value }));
    setErrors(({ [key]: _dropped, ...rest }) => rest);
    setMessage("");
  };
  async function save() {
    setBusy(true); setMessage(""); setErrors({});
    try {
      const { data } = await api.put<{ values: ConfigValues; summary?: string }>(`/instances/${instanceId}/config`, dirty);
      setValues(data.values); setDirty({}); setMessage(t("cloud.instances.config.saved"));
      onSaved?.(data.values, data.summary);
    } catch (cause) {
      const payload = cause as Error & { issues?: Array<{ field: string; message: string }> };
      setErrors((payload.issues ?? []).reduce((all, issue) => ({ ...all, [issue.field]: issue.message }), {} as Record<string, string>));
      setErrors((existing) => Object.keys(existing).length ? existing : { _: payload.message ?? "failed" });
    } finally { setBusy(false); }
  }
  if (loading) return <section className="rounded-md border border-border p-4 text-sm text-muted-foreground"><LoaderCircle className="mr-2 inline size-4 animate-spin" />{t("cloud.common.loading")}</section>;
  if (!schema) return <section className="rounded-md border border-border p-4 text-sm text-destructive">{errors._ ?? ""}</section>;
  const activeSection = sections.find((section) => section.id === active) ?? sections[0];
  const changed = Object.keys(dirty).length;
  return <section className="rounded-md border border-border">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
      <div><p className="flex items-center gap-2 text-sm font-semibold"><Settings2 className="size-4 text-muted-foreground" />{t("cloud.instances.config.title")}</p><p className="text-xs text-muted-foreground">{t("cloud.instances.config.description")}</p></div>
      <div className="flex items-center gap-2">
        {changed > 0 && <Button size="sm" variant="ghost" onPress={() => { setDirty({}); setMessage(""); }}><RotateCcw />{t("cloud.common.cancel")}</Button>}
        <Button size="sm" isDisabled={busy || !changed} onPress={() => void save()}>{busy ? <LoaderCircle className="animate-spin" /> : <Save />}{busy ? t("cloud.common.saving") : t("cloud.instances.config.save")}{changed ? ` (${changed})` : ""}</Button>
      </div>
    </header>
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
      <div className="relative min-w-48 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("cloud.instances.config.search")} aria-label={t("cloud.instances.config.search")} className="pl-9" />
      </div>
      <div className="flex flex-wrap gap-1">{sections.map((section) => <Button key={section.id} size="sm" variant={section.id === activeSection?.id ? "secondary" : "ghost"} onPress={() => setActive(section.id)}>{section.title}</Button>)}</div>
    </div>
    <div className="grid gap-4 p-4 sm:grid-cols-2">
      {activeSection && Object.entries(activeSection.fields).map(([key, field]) => <div key={key} className="space-y-1">
        <div className="flex items-center justify-between gap-2"><Label htmlFor={`cfg-${key}`}>{field.title ?? key}</Label>{key in dirty && <Badge variant="secondary">{t("cloud.instances.config.changed")}</Badge>}</div>
        <FieldInput id={`cfg-${key}`} field={field} value={current(key, field)} onChange={(value) => update(key, value)} />
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
        {errors[key] && <p className="text-xs text-destructive">{errors[key]}</p>}
      </div>)}
      {!activeSection && <p className="text-sm text-muted-foreground">{t("cloud.instances.config.search")}</p>}
    </div>
    {message && <p role="status" className="px-4 pb-3 text-xs text-muted-foreground">{message}</p>}
    {errors._ && <p role="alert" className="px-4 pb-3 text-xs text-destructive">{errors._}</p>}
  </section>;
}

function FieldInput({ id, field, value, onChange }: { id: string; field: ConfigField; value: unknown; onChange: (value: string | number | boolean) => void }) {
  if (field.type === "boolean") return <label className="flex items-center gap-2 text-sm"><input id={id} type="checkbox" className="size-4 accent-foreground" checked={value === true} onChange={(event) => onChange(event.target.checked)} />{field.title ?? id}</label>;
  if (field.type === "enum") return <DropdownMenuTrigger><Button variant="outline" className="w-full justify-between" aria-label={field.title}>{field.values.find((choice) => choice.value === value)?.title ?? String(value ?? "")}<ChevronDown /></Button>
    <DropdownMenu>{field.values.map((choice) => <DropdownMenuItem key={choice.value} onAction={() => onChange(choice.value)}>{choice.title ?? choice.value}{choice.description && <span className="ml-2 text-xs text-muted-foreground">{choice.description}</span>}{choice.value === value && <Check className="ml-auto size-4" />}</DropdownMenuItem>)}</DropdownMenu></DropdownMenuTrigger>;
  if (field.type === "number" || field.type === "integer") return <Input id={id} inputMode="numeric" value={String(value ?? "")} onChange={(event) => onChange(Number(event.target.value))} />;
  return <Input id={id} value={String(value ?? "")} maxLength={"maxLength" in field ? field.maxLength : undefined} onChange={(event) => onChange(event.target.value)} />;
}
