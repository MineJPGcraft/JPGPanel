import type { DashboardContext } from "@mirelia/dashboard/frontend";
import PlayersPanel from "./pages/PlayersPanel";
import SettingsPanel from "./pages/SettingsPanel";

/**
 * Both panels render on the instance's "Type tools" page; server-instances renders the
 * `instance:mc` slot for instances whose type is `mc`.
 */
export default function apply(ctx: DashboardContext) {
  ctx.slot({ slot: "instance:mc", id: "mc-players", component: PlayersPanel as never, order: 10 });
  ctx.slot({ slot: "instance:mc", id: "mc-settings", component: SettingsPanel as never, order: 20 });
}
