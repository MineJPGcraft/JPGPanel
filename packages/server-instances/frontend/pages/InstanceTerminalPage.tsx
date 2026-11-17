import { useEffect, useRef, useState } from "react";
import { Button, LoaderCircle, api, useI18n } from "@mirelia/dashboard/frontend";
import { PlugZap, Terminal, X } from "lucide-react";
import { useInstance } from "../lib/instance";

/**
 * Interactive terminal into the container (`docker exec` over a pty). Keystrokes post to
 * the API; raw tty output streams back, so full-screen programs work.
 */
export default function InstanceTerminalPage() {
  const { t } = useI18n();
  const { id, payload, error } = useInstance();
  const [terminalId, setTerminalId] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const [output, setOutput] = useState("");
  const [problem, setProblem] = useState("");
  const [input, setInput] = useState("");
  const view = useRef<HTMLPreElement>(null);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);

  useEffect(() => { setOutput(""); setProblem(""); }, [terminalId]);
  useEffect(() => {
    if (!terminalId) return;
    const source = new EventSource(`/api/instances/${id}/terminal/output`);
    source.onmessage = (event) => {
      try { const { data } = JSON.parse(event.data) as { data: string }; setOutput((current) => (current + data).slice(-200_000)); } catch { /* ignore */ }
    };
    return () => source.close();
  }, [terminalId, id]);
  useEffect(() => { const node = view.current; if (node) node.scrollTop = node.scrollHeight; }, [output]);
  async function connect() {
    if (!id) return;
    setConnecting(true); setProblem("");
    try { const { data } = await api.post<{ terminalId: string }>(`/instances/${id}/terminal`, {}); setTerminalId(data.terminalId); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : t("cloud.instances.errors.console")); }
    finally { setConnecting(false); }
  }
  async function send(data: string) {
    if (!id || !terminalId || !data) return;
    try { await api.post(`/instances/${id}/terminal/input`, { terminalId, data }); }
    catch { setProblem(t("cloud.instances.errors.terminalStopped")); }
  }
  async function disconnect() {
    if (!id || !terminalId) return;
    await api.post(`/instances/${id}/terminal/close`, { terminalId }).catch(() => undefined);
    setTerminalId(undefined);
  }
  async function submit(line: string) {
    if (!line) { await send("\r"); return; }
    history.current = [...history.current.slice(-49), line];
    historyIndex.current = -1;
    await send(`${line}\r`);
  }
  const connected = Boolean(terminalId);
  const running = payload?.instance.status === "running";
  return <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <div><h1 className="flex items-center gap-2 text-xl font-semibold"><Terminal className="size-5 text-muted-foreground" />{t("cloud.instances.detail.terminal")}</h1><p className="text-sm text-muted-foreground">{payload?.instance.name} · {t("cloud.instances.detail.terminalHint")}</p></div>
      {connected
        ? <Button size="sm" variant="outline" onPress={() => void disconnect()}><X />{t("cloud.instances.detail.disconnect")}</Button>
        : <Button size="sm" onPress={() => void connect()} isDisabled={connecting || !running}>{connecting ? <LoaderCircle className="animate-spin" /> : <PlugZap />}{connecting ? t("cloud.instances.detail.connecting") : t("cloud.instances.detail.connect")}</Button>}
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {problem && <p role="alert" className="mt-3 text-sm text-destructive">{problem}</p>}
    {!running && payload && <p className="mt-3 text-xs text-muted-foreground">{t("cloud.instances.detail.stoppedHint")}</p>}
    <pre ref={view} className="mt-4 h-[60vh] overflow-auto rounded-md border border-border bg-black/90 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-emerald-100" aria-live="polite">
      {connected ? (output || t("cloud.common.loading")) : <span className="text-muted-foreground">{t("cloud.instances.detail.terminalIdle")}</span>}
    </pre>
    <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); const line = input; setInput(""); void submit(line); }}>
      <input value={input} onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") { event.preventDefault(); const index = Math.max(0, (historyIndex.current < 0 ? history.current.length : historyIndex.current) - 1); historyIndex.current = index; setInput(history.current[index] ?? ""); }
          if (event.key === "ArrowDown") { event.preventDefault(); const next = historyIndex.current < 0 ? -1 : historyIndex.current + 1; historyIndex.current = next >= history.current.length ? -1 : next; setInput(next < 0 ? "" : history.current[next] ?? ""); }
          if (event.key === "Tab") { event.preventDefault(); void send("\t"); }
          if (event.key === "c" && event.ctrlKey) { event.preventDefault(); void send("\u0003"); }
          if (event.key === "l" && event.ctrlKey) { event.preventDefault(); void send("\f"); }
        }}
        disabled={!connected} autoComplete="off" spellCheck={false}
        placeholder={connected ? "ls -la" : t("cloud.instances.detail.terminalIdle")} aria-label={t("cloud.instances.detail.terminal")}
        className="h-9 flex-1 rounded-md border border-border bg-background px-3 font-mono text-sm outline-none focus-visible:border-ring disabled:opacity-50" />
      <Button type="submit" isDisabled={!connected}>{t("cloud.instances.detail.send")}</Button>
    </form>
    <p className="mt-1 text-xs text-muted-foreground">{t("cloud.instances.detail.terminalKeys")}</p>
  </div>;
}
