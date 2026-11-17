import { useCallback, useEffect, useState } from "react";
import { Badge, Button, LoaderCircle, api, useI18n } from "@mirelia/dashboard/frontend";
import { RefreshCw, Users } from "lucide-react";

interface Player { name: string; id?: string }

/**
 * Online players. Reads the container's console (`list`) when the preset exposes a
 * console command; otherwise reports what it could not resolve instead of guessing.
 */
export default function PlayersPanel({ instanceId }: { instanceId: string }) {
  const { t } = useI18n();
  const [players, setPlayers] = useState<Player[]>([]);
  const [capacity, setCapacity] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setUnavailable(false);
    try {
      const { data } = await api.get<{ players: Player[]; max: number }>(`/instances/${instanceId}/type/mc/players`);
      setPlayers(data.players ?? []); setCapacity(data.max);
    } catch { setUnavailable(true); setPlayers([]); }
    finally { setLoading(false); }
  }, [instanceId]);
  useEffect(() => { void load(); }, [load]);
  return <section className="rounded-md border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 text-sm font-semibold"><Users className="size-4 text-muted-foreground" />{t("cloud.mc.players.title")}</p>
      <Button size="sm" variant="ghost" onPress={() => void load()} isDisabled={loading}><RefreshCw />{t("cloud.mc.players.refresh")}</Button>
    </div>
    {loading ? <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p>
      : unavailable ? <p className="mt-3 text-sm text-muted-foreground">{t("cloud.mc.players.unavailable")}</p>
        : <>
          <p className="mt-3 flex items-baseline gap-2"><span className="text-2xl font-semibold tabular-nums">{players.length}</span><span className="text-sm text-muted-foreground">{t("cloud.mc.players.online")}{capacity ? ` / ${capacity}` : ""}</span></p>
          {players.length ? <ul className="mt-3 flex flex-wrap gap-1">{players.map((player) => <li key={player.name}><Badge variant="secondary">{player.name}</Badge></li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">{t("cloud.mc.players.empty")}</p>}
        </>}
  </section>;
}
