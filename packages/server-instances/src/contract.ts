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

/**
 * A configuration field of an instance type, described as a subset of JSON Schema.
 * The panel renders it and writes the result to the instance's config file, so a type
 * can expose exactly the knobs its server software has.
 */
export type InstanceConfigField =
  | { type: "string"; title?: string; description?: string; default?: string; minLength?: number; maxLength?: number; pattern?: string; format?: "password" | "path" | "multiline" }
  | { type: "number" | "integer"; title?: string; description?: string; default?: number; minimum?: number; maximum?: number; step?: number }
  | { type: "boolean"; title?: string; description?: string; default?: boolean }
  | { type: "enum"; title?: string; description?: string; default?: string; values: Array<{ value: string; title?: string; description?: string }> }
  | { type: "array"; title?: string; description?: string; items: InstanceConfigField; minItems?: number; maxItems?: number };

/** A group of fields, for example "Gameplay" or "Network". */
export interface InstanceConfigSection {
  id: string;
  title: string;
  description?: string;
  fields: Record<string, InstanceConfigField>;
}

/** The full configuration description of an instance type. */
export interface InstanceConfigSchema {
  /** Bumped by the type whenever fields change; stored configs are merged on read. */
  version: number;
  sections: InstanceConfigSection[];
}

export type InstanceConfigValues = Record<string, string | number | boolean>;

/** A file an instance type writes or manages, exposed through the file manager. */
export interface InstanceFileTrack {
  /** Path relative to the instance directory. */
  path: string;
  title: string;
  /** Config file tracked by the configuration panel. */
  config?: boolean;
  /** Editable in the file manager. */
  writable?: boolean;
  language?: "json" | "properties" | "yaml" | "toml" | "ini" | "text";
}

/** A remote or bundled download the type can list (server jars, mods, plugins). */
export interface InstanceRemoteFile {
  name: string;
  url: string;
  size?: number;
  description?: string;
  /** Version label shown in the picker. */
  version?: string;
}

export interface InstanceDownloadSource {
  id: string;
  title: string;
  /** Resolve the list of files for this instance; may call the upstream API. */
  list(instance: Instance): Promise<InstanceRemoteFile[]>;
}

/**
 * One installable option of an instance type, for example "Paper 1.21.4" or
 * "Spigot 1.20.1". Variants come from the type plugin; administrators decide which
 * ones to sell and at which price.
 */
export interface InstanceVariant {
  id: string;
  title: string;
  /** Grouping in the picker, for example "plugins" or "modded". */
  group?: string;
  description?: string;
  /** Version label shown under the title. */
  version?: string;
  /** Marks the recommended variant of its group. */
  recommended?: boolean;
  /** Extra install parameters, stored with the instance and passed to the type. */
  parameters?: Record<string, string>;
}

/** How a variant is installed, resolved by the type plugin. */
export interface InstanceInstallSource {
  /** Download URL of the install artifact. */
  url: string;
  /** File name relative to the instance directory; defaults to the type's own choice. */
  target?: string;
  /** Extra facts for the type. */
  meta?: Record<string, unknown>;
}

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
  /** Variant chosen at purchase time, from the plugin's variant list. */
  variant: InstanceVariant;
  /** Values validated against the offer options. */
  selections: Record<string, string | number | boolean>;
  /** Configuration values pre-filled at purchase time (server edition, version, port …). */
  config: InstanceConfigValues;
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
  /** Short label under the type name on the type picker, e.g. "纯净/插件服". */
  tagline?: string;
  /** Emoji or image URL shown on the type card. */
  icon?: string;
  /** Default per-month price of an instance; the administrator overrides it per spec. */
  basePriceCents?: number;
  offer: InstanceTypeOffer;
  /** Installable options this type can create. Empty means a single implicit variant. */
  variants?(context: { instance?: Instance; values?: InstanceConfigValues }): Promise<InstanceVariant[]> | InstanceVariant[];
  /** Resolve where a variant is downloaded from; the panel shows the URL in the install log. */
  resolveInstall?(variant: InstanceVariant, context: { instance?: Instance; values?: InstanceConfigValues }): Promise<InstanceInstallSource | undefined>;
  /** Every knob the panel lets the owner tune; stored per instance. */
  configSchema: InstanceConfigSchema;
  /** Files the panel shows in the file manager, relative to the instance directory. */
  files?: InstanceFileTrack[];
  /** Download sources offered next to the file manager. */
  downloads?: InstanceDownloadSource[];
  /** Called when the owner saves the configuration; the type writes its files. */
  applyConfig?(instance: Instance, values: InstanceConfigValues, provisioner: InstanceProvisioner): Promise<void>;
  /** Human readable summary shown on the instance overview, e.g. edition and version. */
  describe?(instance: Instance, values: InstanceConfigValues): string;
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
    handle(session: Session, user: User, instance: Instance, body: Record<string, unknown>, query: URLSearchParams, provisioner: InstanceProvisioner): Promise<void>;
  }>;
  /**
   * Console commands the panel intercepts instead of forwarding, for example `backup`
   * or `whitelist add`. Return `false` to forward the line to the process.
   */
  commands?: Array<{ name: string; description: string; run(instance: Instance, argument: string, user: User, provisioner: InstanceProvisioner): Promise<string | undefined> }>;
}

export interface InstanceTypeView extends Omit<InstanceTypeDefinition, "create" | "destroy" | "onPower" | "routes" | "applyConfig" | "describe" | "downloads" | "variants" | "resolveInstall"> {
  routeCount: number;
  downloadSources: Array<{ id: string; title: string }>;
  /** Specs the administrator published for this type. */
  specs: InstanceSpecView[];
  /** Variants currently offered by the plugin. */
  variants: InstanceVariant[];
}

/* ------------------------------------------------------------------ *
 * Stored rows.
 * ------------------------------------------------------------------ */

export interface InstanceSpec {
  id?: number;
  slug: string;
  type_id: string;
  /** Variant this spec sells; empty means the type's default variant. */
  variant_id: string;
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
  variant_id?: string;
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
  config_json: string;
  order_id: string;
  last_error: string;
  started_at: string;
  stopped_at: string;
  created_at: string;
  updated_at: string;
}

export interface Instance extends InstanceRow {
  attributes: Record<string, unknown>;
  config: InstanceConfigValues;
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
  /** Variants of a type, as offered by its plugin right now. */
  listVariants(typeId: string): Promise<InstanceVariant[]>;
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
  /** Current configuration merged over the schema defaults. */
  config(instanceId: string): Promise<{ schema: InstanceConfigSchema; values: InstanceConfigValues } | undefined>;
  /** Validate and store configuration, then let the type write its files. */
  saveConfig(instanceId: string, patch: InstanceConfigValues, actor?: User): Promise<InstanceConfigValues>;
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
