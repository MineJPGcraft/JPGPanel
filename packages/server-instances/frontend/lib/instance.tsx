import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "@mirelia/dashboard/frontend";
import type { InstanceItem, InstanceType } from "../pages/InstancesPage";

export interface InstanceEvent { id: number; event_type: string; message: string; created_at: string }
export interface Payload { instance: InstanceItem; type?: InstanceType; events: InstanceEvent[]; endpoints: Array<{ method: string; path: string }> }

/** Every instance page loads the instance and its type from the same endpoint. */
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
