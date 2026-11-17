import { Link } from "react-router-dom";
import { Badge, Button, LoaderCircle, useI18n } from "@mirelia/dashboard/frontend";
import { FolderKanban, Play, Server, Square } from "lucide-react";
import { useInstance } from "../lib/instance";

/** Identity, image, ports and recent activity of one instance. */
export default function InstanceOverviewPage() {
  const { t, language } = useI18n();
  const { payload, error, busy, power } = useInstance();
  if (error) return <p role="alert" className="mx-auto max-w-5xl p-5 text-sm text-destructive sm:p-8">{error}</p>;
  if (!payload) return <p className="mx-auto flex max-w-5xl items-center gap-2 p-5 text-sm text-muted-foreground sm:p-8"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p>;
  const instance = payload.instance;
  const running = instance.status === "running";
  return <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
      <div className="min-w-0">
        <p className="mb-1 text-sm text-muted-foreground">{instance.preset?.name ?? `#${instance.preset_id}`}{instance.preset?.tagline ? ` · ${instance.preset.tagline}` : ""}</p>
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">{instance.name}<Badge variant={running ? "secondary" : instance.status === "failed" ? "destructive" : "outline"}>{t(`cloud.instances.status.${instance.status}`)}</Badge></h1>
        <p className="mt-1 text-sm text-muted-foreground">{instance.spec?.name ?? `${instance.cpu} vCPU · ${instance.memory_mb} MB`}</p>
      </div>
      {running
        ? <Button variant="outline" isDisabled={busy} onPress={() => void power("stop")}>{busy ? <LoaderCircle className="animate-spin" /> : <Square />}{t("cloud.instances.stop")}</Button>
        : <Button isDisabled={busy} onPress={() => void power("start")}>{busy ? <LoaderCircle className="animate-spin" /> : <Play />}{t("cloud.instances.start")}</Button>}
    </div>
    <div className="mt-6 grid gap-4 md:grid-cols-2">
      <section className="rounded-md border border-border p-4">
        <p className="flex items-center gap-2 text-sm font-semibold"><Server className="size-4 text-muted-foreground" />{t("cloud.instances.detail.overview")}</p>
        <dl className="mt-3 space-y-1.5 text-xs">
          <div className="flex justify-between gap-2"><dt className="text-muted-foreground">ID</dt><dd className="font-mono">{instance.instance_id}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t("cloud.instances.admin.image")}</dt><dd className="truncate font-mono">{instance.preset?.image ?? "—"}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t("cloud.instances.spec")}</dt><dd>{instance.spec?.name ?? "—"}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-muted-foreground">CPU / RAM</dt><dd>{instance.cpu} vCPU · {instance.memory_mb} MB</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t("cloud.instances.created")}</dt><dd>{new Date(instance.created_at).toLocaleString(language)}</dd></div>
        </dl>
        {instance.ports.length > 0 && <div className="mt-3 border-t border-border pt-2 text-xs"><p className="mb-1 text-muted-foreground">{t("cloud.instances.portsTitle")}</p>{instance.ports.map((port) => <p key={port.name} className="flex justify-between gap-2"><span>{port.name} ({port.protocol})</span><span className="font-mono">{port.host} → {port.container}</span></p>)}</div>}
        {instance.last_error && <p className="mt-3 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{instance.last_error}</p>}
      </section>
      <section className="rounded-md border border-border p-4">
        <p className="flex items-center gap-2 text-sm font-semibold"><FolderKanban className="size-4 text-muted-foreground" />{t("cloud.instances.project")}</p>
        <p className="mt-2 text-sm">{instance.projectName ?? `#${instance.project_id}`}</p>
        <Link to={`/projects/${instance.project_id}`} className="mt-1 inline-block text-xs text-muted-foreground hover:underline">{t("cloud.instances.detail.openProject")}</Link>
        <p className="mt-4 text-sm font-semibold">{t("cloud.instances.detail.activity")}</p>
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{payload.events.slice(0, 10).map((event) => <li key={event.id}><span className="text-foreground">{event.event_type}</span> · {event.message}</li>)}</ul>
      </section>
    </div>
  </div>;
}
