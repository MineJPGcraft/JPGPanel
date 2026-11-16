import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Input, Label, api, useI18n } from "@mirelia/dashboard/frontend";
import { CheckCircle2, FileCog, LoaderCircle, Save, ShieldCheck, TriangleAlert } from "lucide-react";

interface MinecraftConfig {
  serverType: "vanilla" | "paper" | "fabric";
  version: string;
  memoryMb: number;
  port: number;
  motd: string;
  maxPlayers: number;
  onlineMode: boolean;
  difficulty: "peaceful" | "easy" | "normal" | "hard";
  viewDistance: number;
  pvp: boolean;
  enforceWhitelist: boolean;
}

/** Extra panel shown on the instance page by the Minecraft instance type. */
export default function MinecraftPanel({ instanceId }: { instanceId: string }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<MinecraftConfig>();
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "eula" | "reinstall">();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const { data } = await api.get<{ config: MinecraftConfig; eulaAccepted: boolean }>(`/instances/${instanceId}/type/config`);
      setConfig(data.config); setEulaAccepted(data.eulaAccepted);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.common.loading")); }
    finally { setLoading(false); }
  }, [instanceId, t]);
  useEffect(() => { void load(); }, [load]);
  const update = (patch: Partial<MinecraftConfig>) => setConfig((current) => current ? { ...current, ...patch } : current);
  async function save() {
    if (!config) return;
    setBusy("save"); setError(""); setMessage("");
    try {
      const { data } = await api.put<{ config: MinecraftConfig }>(`/instances/${instanceId}/type/config`, {
        server_type: config.serverType, version: config.version, memory_mb: config.memoryMb, motd: config.motd,
        max_players: config.maxPlayers, online_mode: config.onlineMode, difficulty: config.difficulty,
        view_distance: config.viewDistance, pvp: config.pvp, enforce_whitelist: config.enforceWhitelist,
      });
      setConfig(data.config); setMessage(t("cloud.mc.saved"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.action")); }
    finally { setBusy(undefined); }
  }
  async function acceptEula() {
    setBusy("eula"); setError("");
    try {
      await api.post(`/instances/${instanceId}/type/eula`, { accept: true });
      setEulaAccepted(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.action")); }
    finally { setBusy(undefined); }
  }
  async function reinstall() {
    setBusy("reinstall"); setError(""); setMessage("");
    try { await api.post(`/instances/${instanceId}/type/reinstall`, {}); setMessage(t("cloud.mc.reinstall")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("cloud.instances.errors.power")); }
    finally { setBusy(undefined); }
  }
  if (loading) return <section className="rounded-md border border-border p-4 text-sm text-muted-foreground"><LoaderCircle className="mr-2 inline size-4 animate-spin" />{t("cloud.common.loading")}</section>;
  if (!config) return <section className="rounded-md border border-border p-4 text-sm text-destructive">{error}</section>;
  return <div className="space-y-4">
    <section className={`rounded-md border p-4 ${eulaAccepted ? "border-border" : "border-destructive/40"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-semibold">{eulaAccepted ? <ShieldCheck className="size-4 text-muted-foreground" /> : <TriangleAlert className="size-4 text-destructive" />}{t("cloud.mc.eulaTitle")}{eulaAccepted && <Badge variant="secondary"><CheckCircle2 className="size-3" />{t("cloud.mc.eulaAccepted")}</Badge>}</p>
          <p className="text-xs text-muted-foreground">{eulaAccepted ? t("cloud.mc.eulaHint") : t("cloud.mc.eulaRequired")}</p>
        </div>
        <div className="flex items-center gap-2">
          <a className="text-xs underline underline-offset-4" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">{t("cloud.mc.eulaLink")}</a>
          {!eulaAccepted && <Button size="sm" isDisabled={Boolean(busy)} onPress={() => void acceptEula()}>{busy === "eula" ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}{t("cloud.mc.eulaAccept")}</Button>}
        </div>
      </div>
    </section>
    <section className="rounded-md border border-border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div><p className="flex items-center gap-2 text-sm font-semibold"><FileCog className="size-4 text-muted-foreground" />{t("cloud.mc.quickConfig")}</p><p className="text-xs text-muted-foreground">{t("cloud.mc.quickConfigHint")}</p></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" isDisabled={Boolean(busy)} onPress={() => void reinstall()}>{busy === "reinstall" ? <LoaderCircle className="animate-spin" /> : null}{t("cloud.mc.reinstall")}</Button><Button size="sm" isDisabled={Boolean(busy)} onPress={() => void save()}>{busy === "save" ? <LoaderCircle className="animate-spin" /> : <Save />}{busy === "save" ? t("cloud.mc.saving") : t("cloud.mc.save")}</Button></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2"><Label>{t("cloud.mc.software")}</Label><div className="flex flex-wrap gap-2">{(["paper", "vanilla", "fabric"] as const).map((software) => <Button key={software} type="button" size="sm" variant={config.serverType === software ? "secondary" : "outline"} aria-pressed={config.serverType === software} onPress={() => update({ serverType: software })}>{software}</Button>)}</div></div>
        <div className="space-y-2"><Label htmlFor="mc-version">{t("cloud.mc.version")}</Label><Input id="mc-version" value={config.version} onChange={(event) => update({ version: event.target.value })} /></div>
        <div className="space-y-2 sm:col-span-2"><Label htmlFor="mc-motd">{t("cloud.mc.motd")}</Label><Input id="mc-motd" maxLength={59} value={config.motd} onChange={(event) => update({ motd: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="mc-max">{t("cloud.mc.maxPlayers")}</Label><Input id="mc-max" inputMode="numeric" value={String(config.maxPlayers)} onChange={(event) => update({ maxPlayers: Number(event.target.value) })} /></div>
        <div className="space-y-2"><Label htmlFor="mc-memory">{t("cloud.mc.memory")}</Label><Input id="mc-memory" inputMode="numeric" value={String(config.memoryMb)} onChange={(event) => update({ memoryMb: Number(event.target.value) })} /></div>
        <div className="space-y-2"><Label htmlFor="mc-view">{t("cloud.mc.viewDistance")}</Label><Input id="mc-view" inputMode="numeric" value={String(config.viewDistance)} onChange={(event) => update({ viewDistance: Number(event.target.value) })} /></div>
        <div className="space-y-2"><Label>{t("cloud.mc.difficulty")}</Label><div className="flex flex-wrap gap-2">{(["peaceful", "easy", "normal", "hard"] as const).map((difficulty) => <Button key={difficulty} type="button" size="sm" variant={config.difficulty === difficulty ? "secondary" : "outline"} aria-pressed={config.difficulty === difficulty} onPress={() => update({ difficulty })}>{t(`cloud.mc.difficulties.${difficulty}`)}</Button>)}</div></div>
      </div>
      <div className="mt-3 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-foreground" checked={config.onlineMode} onChange={(event) => update({ onlineMode: event.target.checked })} />{t("cloud.mc.onlineMode")}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-foreground" checked={config.pvp} onChange={(event) => update({ pvp: event.target.checked })} />{t("cloud.mc.pvp")}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-foreground" checked={config.enforceWhitelist} onChange={(event) => update({ enforceWhitelist: event.target.checked })} />{t("cloud.mc.whitelist")}</label>
      </div>
      {message && <p role="status" className="mt-2 text-xs text-muted-foreground">{message}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  </div>;
}
