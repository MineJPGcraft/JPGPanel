import { Schema, type Context, type Session } from "yumeri";
import type { User } from "@mirelia/user";
import type { ProjectService, ProjectProductEntry } from "@mirelia/project";
import type { StoreFieldOption, StoreProductInput, StoreService } from "@mirelia/store";
import "@mirelia/dashboard";
import "@mirelia/database-core";
import "@mirelia/project";
import "@mirelia/store";
import "@mirelia/user";

export const depend = ["dashboard", "database", "project", "store", "user"];
export const provide = ["instances"];

import type { InstanceRuntime } from "./runtime.js";
export type { InstanceRuntime, TerminalLine } from "./runtime.js";

/* ------------------------------------------------------------------ *
 * Public types: what instance-type plugins and the panel agree on.
 * ------------------------------------------------------------------ */

export type InstancePowerState = "running" | "stopped" | "starting" | "stopping" | "failed";
export type InstanceHealth = "unknown" | "healthy" | "unhealthy";

/** A value the buyer picks before an instance of the type is created. */
export interface InstanceOption {
  key: string;
  label: string;
  description?: string;
  type: "select" | "text" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string; description?: string; disabled?: boolean }>;
}

/** The catalogue entry an instance type sells. */
export interface InstanceTypeOffer {
  id: string;
  name: string;
  summary?: string;
  provider?: string;
  /** Recurring price of one instance per period, in minor units. */
  priceCents: number;
  period?: "month" | "year";
  /** Resource sizing quoted on the store listing. */
  spec: { cpu: number; memoryMb: number; diskGb?: number };
  highlights?: string[];
  options?: InstanceOption[];
  popular?: boolean;
  sortOrder?: number;
  repeatable?: boolean;
}

export interface InstanceCreateRequest {
  user: User;
  tenantId: number;
  project: { id: number; name: string };
  /** Values validated against the offer options. */
  selections: Record<string, string | number | boolean>;
  spec: { cpu: number; memoryMb: number; diskGb?: number };
  /** Identifier of this purchase line, stable across retries. */
  orderKey: string;
}

/** What an instance type returns after creating an instance. */
export interface InstanceCreation {
  /** Provider-side identifier, for example the Minecraft resource id. */
  id: string;
  name: string;
  /** Port inside the instance network the panel proxies to. */
  port: number;
  /** Extra facts are stored as JSON and shown on the instance page. */
  attributes?: Record<string, unknown>;
  /** Optional start command hint kept for reference. */
  note?: string;
}

export interface InstanceRuntimeContext {
  /** Request-scoped helpers offered to runtime plugins. */
  status(session: Session, user: User, instance: Instance): void;
}

/**
 * The extension point. A plugin such as `mc-instance` calls
 * `instances.registerType(...)` and hands over the offer plus the lifecycle hooks.
 */
/** Handed to lifecycle hooks so instance types can write files and run install steps. */
export interface InstanceProvisioner {
  /** Supervised console of this instance; survives the panel's request lifecycle. */
  runtime: InstanceRuntime;
  /** Directory the instance type owns, normally `data/<instanceId>`. */
  directory: string;
  /** Update the stored attributes while a long step runs, so progress stays visible. */
  progress(attributes: Record<string, unknown>, message?: string): Promise<void>;
}

export interface InstanceTypeDefinition {
  /** Stable type id, unique per plugin, for example `minecraft`. */
  id: string;
  name: string;
  description?: string;
  pluginId: string;
  offer: InstanceTypeOffer;
  /** Create the backing instance. Must be idempotent for the same `orderKey`. */
  create(request: InstanceCreateRequest, provisioner: InstanceProvisioner): Promise<InstanceCreation>;
  /** Start the instance; the type decides which process runs. */
  start?(instance: Instance, provisioner: InstanceProvisioner): Promise<void>;
  /** Stop the instance process gracefully. */
  stop?(instance: Instance, provisioner: InstanceProvisioner): Promise<void>;
  destroy?(instance: Instance): Promise<void>;
  /** Called after the instance process starts or stops, for example to warm caches. */
  onPower?(instance: Instance, state: InstancePowerState): Promise<void>;
  routes?: Array<{
    method: "GET" | "POST" | "PUT" | "DELETE";
    /** Path relative to /api/instances/:id/type, for example `world`. */
    path: string;
    handle(session: Session, user: User, instance: Instance, body: Record<string, unknown>, query: URLSearchParams): Promise<void>;
  }>;
}

export interface InstanceTypeView extends Omit<InstanceTypeDefinition, "create" | "destroy" | "onPower" | "routes"> {
  routeCount: number;
  /** Specs the administrator published for this type. */
  specs: InstanceSpecView[];
}

/* ------------------------------------------------------------------ *
 * Stored rows.
 * ------------------------------------------------------------------ */

export interface InstanceSpec {
  id?: number;
  slug: string;
  type_id: string;
  name: string;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  price_cents: number;
  enabled: boolean;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface InstanceRow {
  id?: number;
  instance_id: string;
  tenant_id: number;
  project_id: number;
  owner_user_id: number;
  spec_id: number;
  type_id: string;
  plugin_id: string;
  name: string;
  provider_ref: string;
  status: InstancePowerState;
  health: InstanceHealth;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  port: number;
  attributes_json: string;
  order_id: string;
  last_error: string;
  started_at: string;
  stopped_at: string;
  created_at: string;
  updated_at: string;
}

export interface Instance extends InstanceRow {
  attributes: Record<string, unknown>;
  spec?: InstanceSpec;
}

export interface InstanceSpecView extends InstanceSpec {
  instances: number;
}

export type InstanceEventType = "created" | "configured" | "start" | "stop" | "destroyed" | "error";

export interface InstanceEventRow {
  id?: number;
  instance_id: string;
  event_type: InstanceEventType;
  message: string;
  actor_user_id: number;
  created_at: string;
}

/* ------------------------------------------------------------------ *
 * Service.
 * ------------------------------------------------------------------ */

export interface InstanceService {
  /** Register an instance type; returns an unsubscribe handle. */
  registerType(definition: InstanceTypeDefinition): () => void;
  listTypes(): InstanceTypeView[];
  findType(typeId: string): InstanceTypeView | undefined;
  /* Specification catalogue (administrator managed). */
  listSpecs(): Promise<InstanceSpecView[]>;
  createSpec(input: Partial<InstanceSpec>): Promise<InstanceSpecView>;
  updateSpec(id: number, input: Partial<InstanceSpec>): Promise<InstanceSpecView>;
  deleteSpec(id: number): Promise<void>;
  /* Lifecycle. */
  createInstanceForOrder(request: InstanceCreateRequest & { specId: number }): Promise<Instance>;
  power(instanceId: string, action: "start" | "stop", actor?: User): Promise<Instance>;
  get(instanceId: string): Promise<Instance | undefined>;
  listForUser(user: User): Promise<Instance[]>;
  /** Resolve an instance the user may access, writing the error response when not. */
  authorize(session: Session, instanceId: string, admin?: boolean): Promise<Instance | undefined>;
  events(instanceId: string, limit?: number): Promise<InstanceEventRow[]>;
  recordEvent(instanceId: string, type: InstanceEventType, message: string, actor?: User): Promise<void>;
}

export interface InstanceConfig {
  publicUrl: string;
  terminalBufferLines: number;
  defaultGraceMs: number;
}

declare module "@yumerijs/types" {
  interface Tables {
    instance_specs: InstanceSpec;
    instances: InstanceRow;
    instance_events: InstanceEventRow;
  }
}
declare module "yumeri" {
  interface Components { instances: InstanceService }
}

export const config: Schema<InstanceConfig> = Schema.object({
  publicUrl: Schema.string("Public base URL used to build instance access addresses").key("instances.publicUrl").default("http://localhost:3001"),
  terminalBufferLines: Schema.number("Console lines kept per instance").key("instances.terminalBufferLines").default(500),
  defaultGraceMs: Schema.number("Grace period before a process is killed").key("instances.defaultGraceMs").default(10000),
});

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
