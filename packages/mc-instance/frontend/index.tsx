import type { DashboardContext } from "@mirelia/dashboard/frontend";
import MinecraftPanel from "./pages/MinecraftPanel";

/**
 * The Minecraft panel lives on the instance's "Type tools" page: server-instances
 * renders the `instance:minecraft` slot there.
 */
export default function apply(ctx: DashboardContext) {
  ctx.slot({ slot: "instance:minecraft", id: "mc-instance-panel", component: MinecraftPanel as never, order: 10 });
}
