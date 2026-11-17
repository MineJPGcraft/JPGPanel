import { useSlot } from "@mirelia/dashboard/frontend";

type InstancePanelProps = { instanceId: string };

function SlotPanels({ slot, instanceId }: { slot: string; instanceId: string }) {
  const panels = useSlot(slot);
  if (!panels.length) return null;
  return <>{panels.map(({ id, component: Panel }) => <Panel key={id} {...({ instanceId } as never)} />)}</>;
}

/** Panels an instance type contributes (e.g. the Minecraft player list). */
export function InstanceTypePanels({ typeId, instanceId }: { typeId: string; instanceId: string }) {
  return <SlotPanels slot={`instance:${typeId}`} instanceId={instanceId} />;
}

/** Tools contributed for every instance, such as the file manager. */
export function InstanceFileSlot({ instanceId }: { instanceId: string }) {
  return <SlotPanels slot="instance:files" instanceId={instanceId} />;
}

export type { InstancePanelProps };
