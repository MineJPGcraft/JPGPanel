import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, LoaderCircle, api, useI18n } from "@mirelia/dashboard/frontend";
import { RefreshCw, Terminal } from "lucide-react";
import { useInstance } from "../lib/instance";

/** Container logs, streamed while the server runs. */
export default function InstanceConsolePage() {
  const { t } = useI18n();
  const { payload, error } = useInstance();
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const view = useRef<HTMLPreElement>(null);
  const load = useCallback(async () => {
    if (!payload) return;
    setLoading(true);
    try { const { data } = await api.get<{ logs: string }>(`/instances/${payload.instance.instance_id}/logs?tail=500`); setLogs(data.logs); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }, [payload]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!payload) return;
    const source = new EventSource(`/api/instances/${payload.instance.instance_id}/logs/stream`);
    source.onmessage = (event) => {
      try { const { data } = JSON.parse(event.data) as { data: string }; setLogs((current) => (current + data).slice(-200_000)); } catch { /* ignore */ }
    };
    return () => source.close();
  }, [payload]);
  useEffect(() => { const node = view.current; if (node) node.scrollTop = node.scrollHeight; }, [logs]);
  return <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <div><h1 className="flex items-center gap-2 text-xl font-semibold"><Terminal className="size-5 text-muted-foreground" />{t("cloud.instances.detail.console")}</h1><p className="text-sm text-muted-foreground">{payload?.instance.name}</p></div>
      <div className="flex items-center gap-2"><Badge variant={payload?.instance.status === "running" ? "secondary" : "outline"}>{payload ? t(`cloud.instances.status.${payload.instance.status}`) : ""}</Badge><Button size="sm" variant="ghost" onPress={() => void load()}><RefreshCw />{t("cloud.common.retry")}</Button></div>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    <pre ref={view} className="mt-4 h-[60vh] overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed" aria-live="polite">
      {loading && !logs ? <span className="text-muted-foreground">{t("cloud.common.loading")}</span> : logs || <span className="text-muted-foreground">{t("cloud.instances.detail.noLines")}</span>}
    </pre>
    {!payload && !error && <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p>}
  </div>;
}
