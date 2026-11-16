import { useEffect, useRef, useState } from "react";
import { Badge, Button, Input, LoaderCircle, api, useI18n } from "@mirelia/dashboard/frontend";
import { Send, Terminal, Trash2 } from "lucide-react";
import { useInstance } from "../lib/instance";

interface ConsoleLine { seq: number; stream: "stdout" | "stderr" | "system"; text: string; at: string }

/** Line-oriented console of the running process: history plus a live stream. */
export default function InstanceConsolePage() {
  const { t } = useI18n();
  const { id, payload, error } = useInstance();
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [command, setCommand] = useState("");
  const [sendError, setSendError] = useState("");
  const cursor = useRef(0);
  const view = useRef<HTMLPreElement>(null);
  const append = (incoming: ConsoleLine[]) => {
    if (!incoming.length) return;
    setLines((current) => [...current.filter((line) => !incoming.some((next) => next.seq === line.seq)), ...incoming].slice(-800));
    cursor.current = Math.max(cursor.current, ...incoming.map((line) => line.seq));
  };
  useEffect(() => {
    if (!id) return;
    let source: EventSource | undefined;
    let active = true;
    const opened = () => {
      if (!active || typeof EventSource === "undefined") return;
      source = new EventSource(`/api/instances/${id}/console/stream?after=${cursor.current}`);
      source.onmessage = (event) => { try { append([JSON.parse(event.data) as ConsoleLine]); } catch { /* ignore */ } };
    };
    void api.get<{ lines: ConsoleLine[] }>(`/instances/${id}/console`).then(({ data }) => { append(data.lines); opened(); }).catch(opened);
    return () => { active = false; source?.close(); };
  }, [id]);
  useEffect(() => { const node = view.current; if (node) node.scrollTop = node.scrollHeight; }, [lines]);
  async function send() {
    if (!id || !command.trim()) return;
    const text = command.trim();
    setCommand(""); setSendError("");
    try { await api.post(`/instances/${id}/terminal`, { command: text }); }
    catch (cause) { setSendError(cause instanceof Error ? cause.message : t("cloud.instances.errors.terminalStopped")); }
  }
  const running = payload?.instance.status === "running";
  const colour = (line: ConsoleLine) => line.stream === "stderr" ? "text-destructive" : line.stream === "system" ? "text-muted-foreground" : "text-foreground";
  return <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <div><h1 className="flex items-center gap-2 text-xl font-semibold"><Terminal className="size-5 text-muted-foreground" />{t("cloud.instances.detail.console")}</h1><p className="text-sm text-muted-foreground">{payload?.instance.name}</p></div>
      <div className="flex items-center gap-2"><Badge variant={running ? "secondary" : "outline"}>{payload ? t(`cloud.instances.status.${payload.instance.status}`) : ""}</Badge><Button size="sm" variant="ghost" onPress={() => setLines([])}><Trash2 />{t("cloud.instances.detail.clear")}</Button></div>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    <pre ref={view} className="mt-4 h-[60vh] overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed" aria-live="polite">
      {lines.length ? lines.map((line) => <div key={line.seq} className={colour(line)}><span className="mr-2 select-none text-muted-foreground/60">{line.stream === "system" ? "·" : line.stream === "stderr" ? "!" : "›"}</span>{line.text}</div>) : <span className="text-muted-foreground">{t("cloud.instances.detail.noLines")}</span>}
    </pre>
    <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <Input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t("cloud.instances.detail.commandPlaceholder")} aria-label={t("cloud.instances.detail.console")} isDisabled={!running} className="font-mono" />
      <Button type="submit" isDisabled={!running || !command.trim()}><Send />{t("cloud.instances.detail.send")}</Button>
    </form>
    {!running && <p className="mt-1 text-xs text-muted-foreground">{t("cloud.instances.detail.stoppedHint")}</p>}
    {sendError && <p role="alert" className="mt-1 text-xs text-destructive">{sendError}</p>}
    {!payload && !error && <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p>}
  </div>;
}
