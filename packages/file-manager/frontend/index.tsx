import type { DashboardContext } from "@mirelia/dashboard/frontend";
import FileManagerPanel from "./pages/FileManagerPanel";

/**
 * The file manager only contributes a panel: server-instances renders the
 * `instance:files` slot on every instance page, whatever its type.
 */
export default function apply(ctx: DashboardContext) {
  // server-instances renders the `instance:files` slot on its Files page (and nowhere else).
  ctx.slot({ slot: "instance:files", id: "file-manager-panel", component: FileManagerPanel as never, order: 30 });
}
