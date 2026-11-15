import type { DashboardContext } from "@mirelia/dashboard/frontend";
import { Server, SlidersHorizontal } from "lucide-react";
import InstancesPage from "./pages/InstancesPage";
import InstanceDetailPage from "./pages/InstanceDetailPage";
import InstanceSpecsPage from "./pages/InstanceSpecsPage";

async function isAdmin() {
  try {
    const response = await fetch("/api/user/me", { credentials: "same-origin" });
    if (!response.ok) return false;
    return (await response.json() as { is_admin?: boolean }).is_admin === true;
  } catch { return false; }
}

export default function apply(ctx: DashboardContext) {
  const section = { section: "instances" };
  ctx.navigation({ id: "instances", label: "Instances", labelKey: "cloud.instances.nav.instances", path: "/instances", icon: Server, order: 30, ...section });
  ctx.navigation({ id: "instances-specs", label: "Specifications", labelKey: "cloud.instances.nav.specs", path: "/admin/instances/specs", icon: SlidersHorizontal, order: 30, section: "admin", paths: ["/admin/instances/specs"], visible: isAdmin });
  ctx.route({ path: "/instances", component: InstancesPage, shell: "dashboard" });
  ctx.route({ path: "/instances/:id", component: InstanceDetailPage, shell: "dashboard" });
  ctx.route({ path: "/admin/instances/specs", component: InstanceSpecsPage, shell: "dashboard" });
}
