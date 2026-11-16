import { Boxes, LoaderCircle, useI18n } from "@mirelia/dashboard/frontend";
import { useInstance } from "../lib/instance";
import { InstanceTypePanels } from "../panels";

/** Type-specific tools: what the plugin contributes for this instance type. */
export default function InstanceTypePage() {
  const { t } = useI18n();
  const { payload, error } = useInstance();
  if (error) return <p role="alert" className="mx-auto max-w-5xl p-5 text-sm text-destructive sm:p-8">{error}</p>;
  if (!payload) return <p className="mx-auto flex max-w-5xl items-center gap-2 p-5 text-sm text-muted-foreground sm:p-8"><LoaderCircle className="size-4 animate-spin" />{t("cloud.common.loading")}</p>;
  return <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
    <div className="border-b border-border pb-4">
      <h1 className="flex items-center gap-2 text-xl font-semibold"><Boxes className="size-5 text-muted-foreground" />{payload.type?.name ?? payload.instance.type_id}</h1>
      <p className="text-sm text-muted-foreground">{payload.instance.name} · {t("cloud.instances.detail.typeTools")}</p>
    </div>
    <div className="mt-4"><InstanceTypePanels typeId={payload.type?.id ?? ""} instanceId={payload.instance.instance_id} /></div>
  </div>;
}
