import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, LinkButton, api, useI18n } from "@mirelia/dashboard/frontend";
import { CircleDot, FolderKanban, LoaderCircle, Play, Server, ShoppingBag, Square, Terminal } from "lucide-react";

export interface InstanceSpec { id: number; name: string; cpu: number; memory_mb: number; disk_gb: number; price_cents: number }
export interface InstanceItem {
  instance_id: string; name: string; type_id: string; project_id: number; projectName?: string; variant_id?: string;
  spec_id: number; status: "running" | "stopped" | "starting" | "stopping" | "failed"; cpu: number; memory_mb: number;
  disk_gb: number; created_at: string; last_error: string; spec?: InstanceSpec;
}
export interface InstanceType { id: string; name: string; description?: string; tagline?: string; pluginId: string; routeCount: number; offer: { options?: Array<{ key: string; label: string }> } }

export function formatMoney(language: string, cents: number) {
  return new Intl.NumberFormat(language === "zh" ? "zh-CN" : language === "ja" ? "ja-JP" : "en-US", { style: "currency", currency: "CNY" }).format(cents / 100);
}

/** Instances belong to projects, so the list is grouped by them. */
export default function InstancesPage() {
  const { t, language } = useI18n();
  const [instances, setInstances] = useState<InstanceItem[]>([]);
  const [types, setTypes] = useState<InstanceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const { data } = await api.get<{ instances: InstanceItem[]; types: InstanceType[] }>("/instances");
      setInstances(data.instances); setTypes(data.types);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.auth")); }
    finally { setLoading(false); }
  }, [t]);
  useEffect(() => { void load(); }, [load]);
  async function power(instance: InstanceItem, action: "start" | "stop") {
    setBusy(instance.instance_id); setError("");
    try { await api.post(`/instances/${instance.instance_id}/power`, { action }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.power")); }
    finally { setBusy(undefined); }
  }
  const typeName = (id: string) => types.find((type) => type.id === id)?.name ?? id;
  const groups = useMemo(() => {
    const map = new Map<number, { name: string; items: InstanceItem[] }>();
    for (const instance of instances) {
      const group = map.get(instance.project_id) ?? { name: instance.projectName ?? `#${instance.project_id}`, items: [] };
      group.items.push(instance);
      map.set(instance.project_id, group);
    }
    return [...map.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [instances]);
  return <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
      <div><p className="mb-1 text-sm text-muted-foreground">{t("cloud.instances.nav.section")}</p><h1 className="text-2xl font-semibold">{t("cloud.instances.title")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("cloud.instances.description")}</p></div>
      <LinkButton variant="outline" href="/store"><ShoppingBag />{t("cloud.instances.browse")}</LinkButton>
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {loading ? <p role="status" className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.instances.loading")}</p>
      : groups.length ? <div className="mt-4 space-y-7">{groups.map(([projectId, group]) => <section key={projectId}>
        <header className="flex items-center gap-2 border-b border-border pb-2">
          <FolderKanban className="size-4 text-muted-foreground" />
          <Link to={`/projects/${projectId}`} className="text-sm font-semibold hover:underline">{group.name}</Link>
          <Badge variant="secondary">{group.items.length}</Badge>
        </header>
        <div className="divide-y divide-border">{group.items.map((instance) => <article key={instance.instance_id} className="flex flex-wrap items-start justify-between gap-4 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-card"><Server className="size-4 text-muted-foreground" /></span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/instances/${instance.instance_id}`} className="font-medium hover:underline">{instance.name}</Link>
                <Badge variant={instance.status === "running" ? "secondary" : instance.status === "failed" ? "destructive" : "outline"}><CircleDot className="size-3" />{t(`cloud.instances.status.${instance.status}`)}</Badge>
                <Badge variant="ghost">{typeName(instance.type_id)}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{instance.spec?.name ?? `${instance.cpu} vCPU · ${instance.memory_mb} MB`} · {instance.cpu} vCPU · {instance.memory_mb} MB{instance.disk_gb ? ` · ${instance.disk_gb} GB` : ""}</p>
              <p className="text-xs text-muted-foreground">{t("cloud.instances.created")} {new Date(instance.created_at).toLocaleString(language)}</p>
              {instance.last_error && <p className="text-xs text-destructive">{t("cloud.instances.detail.lastError")}: {instance.last_error}</p>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {instance.status === "running"
              ? <Button size="sm" variant="outline" isDisabled={busy === instance.instance_id} onPress={() => void power(instance, "stop")}>{busy === instance.instance_id ? <LoaderCircle className="animate-spin" /> : <Square />}{t("cloud.instances.stop")}</Button>
              : <Button size="sm" isDisabled={busy === instance.instance_id || instance.status === "starting"} onPress={() => void power(instance, "start")}>{busy === instance.instance_id ? <LoaderCircle className="animate-spin" /> : <Play />}{t("cloud.instances.start")}</Button>}
            <LinkButton size="sm" variant="ghost" href={`/instances/${instance.instance_id}/console`}><Terminal />{t("cloud.instances.open")}</LinkButton>
          </div>
        </article>)}</div>
      </section>)}</div>
        : <div className="mt-6 flex min-h-48 flex-col items-center justify-center gap-3 border-y border-border text-center"><Server className="size-7 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t("cloud.instances.empty")}</p><LinkButton size="sm" href="/store">{t("cloud.instances.browse")}</LinkButton></div>}
  </div>;
}
