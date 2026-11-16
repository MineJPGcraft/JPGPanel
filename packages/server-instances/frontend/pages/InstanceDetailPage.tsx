import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Input, LinkButton, api, useI18n } from "@mirelia/dashboard/frontend";
import { ArrowLeft, CircleDot, LoaderCircle, Play, Send, Server, Square, Terminal, Trash2 } from "lucide-react";
import type { InstanceItem, InstanceType } from "./InstancesPage";
import { InstanceFileSlot, InstanceTypePanels, MinecraftPanel } from "../panels";
import InstanceConfigPanel from "./InstanceConfigPanel";

interface ConsoleLine { seq: number; stream: "stdout" | "stderr" | "system"; text: string; at: string }
interface EventRow { id: number; event_type: string; message: string; created_at: string }
interface Payload { instance: InstanceItem; type?: InstanceType; events: EventRow[]; endpoints: Array<{ method: string; path: string }> }

export default function InstanceDetailPage() {
  const { t, language } = useI18n();
  const { id } = useParams();
  const [payload, setPayload] = useState<Payload>();
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cursor = useRef(0);
  const consoleRef = useRef<HTMLPreElement>(null);
  const load = useCallback(async () => {
    if (!id) return;
    try { const { data } = await api.get<Payload>(`/instances/${id}`); setPayload(data); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.notFound")); }
  }, [id, t]);
  useEffect(() => { void load(); }, [load]);

  const append = (incoming: ConsoleLine[]) => {
    if (!incoming.length) return;
    setLines((current) => [...current.filter((line) => !incoming.some((next) => next.seq === line.seq)), ...incoming].slice(-800));
    cursor.current = Math.max(cursor.current, ...incoming.map((line) => line.seq));
  };

  /** Console history first, then a server-sent event stream for live output. */
  useEffect(() => {
    if (!id) return;
    let source: EventSource | undefined;
    let active = true;
    const opened = () => {
      if (!active || typeof EventSource === "undefined") return;
      source = new EventSource(`/api/instances/${id}/console/stream?after=${cursor.current}`);
      source.onmessage = (event) => {
        try { append([JSON.parse(event.data) as ConsoleLine]); } catch { /* ignore malformed frames */ }
      };
    };
    void api.get<{ lines: ConsoleLine[]; running: boolean }>(`/instances/${id}/console`).then(({ data }) => { append(data.lines); opened(); }).catch(opened);
    return () => { active = false; source?.close(); };
  }, [id]);

  useEffect(() => {
    const node = consoleRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  async function send() {
    if (!id || !command.trim()) return;
    const text = command.trim();
    setCommand(""); setError("");
    try { await api.post(`/instances/${id}/terminal`, { command: text }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.terminalStopped")); }
  }
  async function power(action: "start" | "stop") {
    if (!id) return;
    setBusy(true); setError("");
    try { await api.post(`/instances/${id}/power`, { action }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.power")); }
    finally { setBusy(false); }
  }
  const instance = payload?.instance;
  const lineColor = useMemo(() => (line: ConsoleLine) => line.stream === "stderr" ? "text-destructive" : line.stream === "system" ? "text-muted-foreground" : "text-foreground", []);
  return <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
      <div className="min-w-0">
        <Link to="/instances" className="mb-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-3.5" />{t("cloud.instances.detail.back")}</Link>
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">{instance?.name ?? t("cloud.common.loading")}{instance && <Badge variant={instance.status === "running" ? "secondary" : instance.status === "failed" ? "destructive" : "outline"}><CircleDot className="size-3" />{t(`cloud.instances.status.${instance.status}`)}</Badge>}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{payload?.type?.name ?? instance?.type_id} · {instance?.spec?.name ?? ""}</p>
      </div>
      <div className="flex gap-2">
        {instance?.status === "running"
          ? <Button variant="outline" isDisabled={busy} onPress={() => void power("stop")}>{busy ? <LoaderCircle className="animate-spin" /> : <Square />}{t("cloud.instances.stop")}</Button>
          : <Button isDisabled={busy || !instance} onPress={() => void power("start")}>{busy ? <LoaderCircle className="animate-spin" /> : <Play />}{t("cloud.instances.start")}</Button>}
      </div>
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {!payload ? <p role="status" className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p> : <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      {payload.type && <InstanceConfigPanel instanceId={payload.instance.instance_id} schema={payload.type.configSchema} values={payload.instance.config} />}
      {payload.type?.id === "minecraft" && <MinecraftPanel instanceId={payload.instance.instance_id} />}
      <InstanceTypePanels typeId={payload.type?.id ?? ""} instanceId={payload.instance.instance_id} />
      <InstanceFileSlot instanceId={payload.instance.instance_id} />
      <section className="min-w-0">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Terminal className="size-4 text-muted-foreground" />{t("cloud.instances.detail.console")}</h2>
          <Button size="sm" variant="ghost" onPress={() => { setLines([]); }}><Trash2 />{t("cloud.instances.detail.clear")}</Button>
        </div>
        <pre ref={consoleRef} className="h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed" aria-live="polite">
          {lines.length ? lines.map((line) => <div key={line.seq} className={lineColor(line)}><span className="mr-2 select-none text-muted-foreground/60">{line.stream === "system" ? "·" : line.stream === "stderr" ? "!" : "›"}</span>{line.text}</div>) : <span className="text-muted-foreground">{t("cloud.instances.detail.noLines")}</span>}
        </pre>
        <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <Input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t("cloud.instances.detail.commandPlaceholder")} aria-label={t("cloud.instances.detail.console")} isDisabled={instance?.status !== "running"} className="font-mono" />
          <Button type="submit" isDisabled={instance?.status !== "running" || !command.trim()}><Send />{t("cloud.instances.detail.send")}</Button>
        </form>
        {instance?.status !== "running" && <p className="mt-1 text-xs text-muted-foreground">{t("cloud.instances.detail.stoppedHint")}</p>}
      </section>
      <aside className="space-y-5 text-sm">
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="flex items-center gap-2 font-medium"><Server className="size-4 text-muted-foreground" />{t("cloud.instances.detail.overview")}</p>
          <dl className="space-y-1 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">ID</dt><dd className="font-mono">{instance?.instance_id}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t("cloud.instances.type")}</dt><dd>{payload.type?.name ?? instance?.type_id}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t("cloud.instances.spec")}</dt><dd>{instance?.spec?.name ?? "—"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">CPU / RAM</dt><dd>{instance?.cpu} vCPU · {instance?.memory_mb} MB</dd></div>
            {instance?.port ? <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t("cloud.instances.detail.connect")}</dt><dd className="font-mono">:{instance.port}</dd></div> : null}
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t("cloud.instances.created")}</dt><dd>{instance ? new Date(instance.created_at).toLocaleString(language) : ""}</dd></div>
          </dl>
          {instance?.last_error && <p className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{instance.last_error}</p>}
        </div>
        {payload.endpoints.length > 0 && <div className="space-y-1 rounded-md border border-border p-3 text-xs">
          <p className="font-medium">{payload.type?.name}</p>
          {payload.endpoints.map((endpoint) => <p key={`${endpoint.method}${endpoint.path}`} className="font-mono text-muted-foreground">{endpoint.method} {endpoint.path}</p>)}
        </div>}
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="font-medium">{t("cloud.instances.detail.activity")}</p>
          <ul className="space-y-1 text-xs text-muted-foreground">{payload.events.length ? payload.events.slice(0, 12).map((event) => <li key={event.id}><span className="text-foreground">{event.event_type}</span> · {event.message}<br /><time>{new Date(event.created_at).toLocaleString(language)}</time></li>) : <li>—</li>}</ul>
        </div>
      </aside>
    </div>}
  </div>;
}
