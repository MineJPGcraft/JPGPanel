import { useSlot } from "@mirelia/dashboard/frontend";

type InstancePanelProps = { instanceId: string };

/** Components contributed by instance-type plugins through the `instance:<type>` slot. */
export function InstanceTypePanels({ typeId, instanceId }: { typeId: string; instanceId: string }) {
  const panels = useSlot(`instance:${typeId}`);
  if (!panels.length) return null;
  return <>{panels.map(({ id, component: Panel }) => <Panel key={id} {...({ instanceId } as never)} />)}</>;
}

/** File manager and other tools contributed by plugins for every instance. */
export function InstanceFileSlot({ instanceId }: { instanceId: string }) {
  const panels = useSlot("instance:files");
  if (!panels.length) return null;
  return <>{panels.map(({ id, component: Panel }) => <Panel key={id} {...({ instanceId } as never)} />)}</>;
}

export type { InstancePanelProps };

/** Built-in reference panel for the `minecraft` type shipped by mc-instance. */
export { default as MinecraftPanel } from "./pages/MinecraftPanel";
