import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "@mirelia/dashboard/frontend";

export interface InstancePresetView {
  id: number; name: string; tagline: string; image: string; description: string;
  ports: Array<{ name: string; host: number | "auto"; container: number; protocol: string }>;
  params: Array<{ key: string; scope: "purchase" | "provision"; field: { type: string; title?: string; default?: unknown } }>;
}
export interface InstanceItem {
  instance_id: string; name: string; type_id: string; project_id: number; projectName?: string;
  preset_id: number; spec_id: number; status: string; cpu: number; memory_mb: number; disk_gb: number;
  ports: Array<{ name: string; host: number; container: number; protocol: string }>;
  params: Record<string, string | number | boolean>; created_at: string; last_error: string;
  preset?: InstancePresetView; spec?: { name: string };
}
export interface InstanceEvent { id: number; event_type: string; message: string; created_at: string }
export interface Payload { instance: InstanceItem; preset?: InstancePresetView; events: InstanceEvent[] }

/** Every instance page loads the instance, its preset and recent events. */
export function useInstance() {
  const { id } = useParams();
  const [payload, setPayload] = useState<Payload>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!id) return;
    try { const { data } = await api.get<Payload>(`/instances/${id}`); setPayload(data); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "not found"); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const power = useCallback(async (action: "start" | "stop") => {
    if (!id) return;
    setBusy(true); setError("");
    try { await api.post(`/instances/${id}/power`, { action }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "power failed"); }
    finally { setBusy(false); }
  }, [id, load]);
  return { id, payload, error, busy, load, power, setError };
}
