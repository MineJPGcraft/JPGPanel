import type { DashboardContext } from "@mirelia/dashboard/frontend";
import { Boxes, Folder, Server, Settings2, SlidersHorizontal, Terminal, Waypoints } from "lucide-react";
import InstancesPage from "./pages/InstancesPage";
import InstanceOverviewPage from "./pages/InstanceOverviewPage";
import InstanceConsolePage from "./pages/InstanceConsolePage";
import InstanceTerminalPage from "./pages/InstanceTerminalPage";
import InstanceConfigPage from "./pages/InstanceConfigPage";
import InstanceFilesPage from "./pages/InstanceFilesPage";
import InstanceTypePage from "./pages/InstanceTypePage";
import InstanceSpecsPage from "./pages/InstanceSpecsPage";

async function isAdmin() {
  try {
    const response = await fetch("/api/user/me", { credentials: "same-origin" });
    if (!response.ok) return false;
    return (await response.json() as { is_admin?: boolean }).is_admin === true;
  } catch { return false; }
}

export default function apply(ctx: DashboardContext) {
  ctx.section({ id: "instances", basePath: "/instances", labelKey: "cloud.instances.nav.section", backPath: "/", order: 20 });

  // The list is a section of its own; every instance page gets its own sidebar below.
  ctx.navigation({ id: "instances", label: "Instances", labelKey: "cloud.instances.nav.instances", path: "/instances", icon: Server, order: 10, section: "instances" });
  ctx.navigation({ id: "instance-overview", label: "Overview", labelKey: "cloud.instances.nav.overview", path: "/instances/:id", icon: Waypoints, order: 10, section: "instances" });
  ctx.navigation({ id: "instance-console", label: "Console", labelKey: "cloud.instances.nav.console", path: "/instances/:id/console", icon: Terminal, order: 20, section: "instances" });
  ctx.navigation({ id: "instance-terminal", label: "Terminal", labelKey: "cloud.instances.nav.terminal", path: "/instances/:id/terminal", icon: Terminal, order: 30, section: "instances" });
  ctx.navigation({ id: "instance-config", label: "Configuration", labelKey: "cloud.instances.nav.config", path: "/instances/:id/config", icon: Settings2, order: 40, section: "instances" });
  ctx.navigation({ id: "instance-files", label: "Files", labelKey: "cloud.instances.nav.files", path: "/instances/:id/files", icon: Folder, order: 50, section: "instances" });
  ctx.navigation({ id: "instance-tools", label: "Type tools", labelKey: "cloud.instances.nav.tools", path: "/instances/:id/tools", icon: Boxes, order: 60, section: "instances" });
  ctx.navigation({ id: "instances-specs", label: "Specifications", labelKey: "cloud.instances.nav.specs", path: "/admin/instances/specs", icon: SlidersHorizontal, order: 30, section: "admin", visible: isAdmin });

  const detail = ["instance-overview", "instance-console", "instance-terminal", "instance-config", "instance-files", "instance-tools"];
  ctx.sidebar({ path: "/instances", section: "instances", items: ["instances"] });
  ctx.sidebar({ path: "/instances/:id", section: "instances", items: detail });
  ctx.sidebar({ path: "/instances/:id/console", section: "instances", items: detail });
  ctx.sidebar({ path: "/instances/:id/terminal", section: "instances", items: detail });
  ctx.sidebar({ path: "/instances/:id/config", section: "instances", items: detail });
  ctx.sidebar({ path: "/instances/:id/files", section: "instances", items: detail });
  ctx.sidebar({ path: "/instances/:id/tools", section: "instances", items: detail });

  ctx.route({ path: "/instances", component: InstancesPage, shell: "dashboard" });
  ctx.route({ path: "/instances/:id", component: InstanceOverviewPage, shell: "dashboard" });
  ctx.route({ path: "/instances/:id/console", component: InstanceConsolePage, shell: "dashboard" });
  ctx.route({ path: "/instances/:id/terminal", component: InstanceTerminalPage, shell: "dashboard" });
  ctx.route({ path: "/instances/:id/config", component: InstanceConfigPage, shell: "dashboard" });
  ctx.route({ path: "/instances/:id/files", component: InstanceFilesPage, shell: "dashboard" });
  ctx.route({ path: "/instances/:id/tools", component: InstanceTypePage, shell: "dashboard" });
  ctx.route({ path: "/admin/instances/specs", component: InstanceSpecsPage, shell: "dashboard" });
}
