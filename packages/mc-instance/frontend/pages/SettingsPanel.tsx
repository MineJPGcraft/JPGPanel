import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Label, LoaderCircle, api, useI18n } from "@mirelia/dashboard/frontend";
import { Save, Search, Settings2 } from "lucide-react";

interface Property { key: string; value: string }

/**
 * Visual editor for `server.properties`. The instance type exposes the file through the
 * panel's file API, so this component only parses and writes key=value lines.
 */
export default function SettingsPanel({ instanceId }: { instanceId: string }) {
  const { t } = useI18n();
  const [properties, setProperties] = useState<Property[]>([]);
  const [original, setOriginal] = useState<Property[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setProblem("");
    try {
      const { data } = await api.get<{ content: string }>(`/instances/${instanceId}/type/mc/properties`);
      const parsed = parse(data.content ?? "");
      setProperties(parsed); setOriginal(parsed.map((entry) => ({ ...entry })));
    } catch { setProblem(t("cloud.mc.settings.missing")); }
    finally { setLoading(false); }
  }, [instanceId, t]);
  useEffect(() => { void load(); }, [load]);
  const changed = useMemo(() => properties.filter((entry) => original.find((old) => old.key === entry.key)?.value !== entry.value), [properties, original]);
  const visible = properties.filter((entry) => entry.key.toLowerCase().includes(search.trim().toLowerCase()));
  async function save() {
    setSaving(true); setProblem(""); setMessage("");
    try {
      await api.put(`/instances/${instanceId}/type/mc/properties`, { properties });
      setOriginal(properties.map((entry) => ({ ...entry }))); setMessage(t("cloud.mc.settings.saved"));
    } catch { setProblem(t("cloud.mc.settings.missing")); }
    finally { setSaving(false); }
  }
  return <section className="rounded-md border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="flex items-center gap-2 text-sm font-semibold"><Settings2 className="size-4 text-muted-foreground" />{t("cloud.mc.settings.title")}</p><p className="text-xs text-muted-foreground">{t("cloud.mc.settings.description")}</p></div>
      <Button size="sm" isDisabled={saving || !changed.length} onPress={() => void save()}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}{saving ? t("cloud.common.saving") : t("cloud.mc.settings.save")}{changed.length ? ` (${changed.length})` : ""}</Button>
    </div>
    <div className="relative mt-3"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("cloud.mc.settings.search")} aria-label={t("cloud.mc.settings.search")} className="pl-9" /></div>
    {loading ? <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p>
      : problem ? <p className="mt-3 text-sm text-muted-foreground">{problem}</p>
        : <div className="mt-3 max-h-[50vh] space-y-2 overflow-y-auto pr-1">{visible.map((entry) => <div key={entry.key} className="grid gap-1 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-center">
          <Label htmlFor={`prop-${entry.key}`} className="font-mono text-xs text-muted-foreground">{entry.key}</Label>
          <Input id={`prop-${entry.key}`} value={entry.value} className="font-mono" onChange={(event) => setProperties((current) => current.map((item) => item.key === entry.key ? { ...item, value: event.target.value } : item))} />
        </div>)}</div>}
    {message && <p role="status" className="mt-2 text-xs text-muted-foreground">{message}</p>}
  </section>;
}

function parse(content: string): Property[] {
  return content.split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=:\s]+)\s*[=:]\s*(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ key: match[1], value: match[2].replace(/\\:/g, ":").replace(/\\=/g, "=") }));
}
