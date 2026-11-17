import { Schema, type Context, type Session } from "yumeri";
import type { User } from "@mirelia/user";
import type { ProjectService } from "@mirelia/project";
import type { StoreService } from "@mirelia/store";
import "@mirelia/dashboard";
import "@mirelia/database-core";
import "@mirelia/project";
import "@mirelia/store";
import "@mirelia/user";

export const depend = ["dashboard", "database", "project", "store", "user"];
export const provide = ["instances"];

export type { DockerDriver, DockerContainerSpec, DockerContainerState } from "./docker.js";

/* ------------------------------------------------------------------ *
 * Configuration fields shared by presets, specs and instances.
 * ------------------------------------------------------------------ */

/**
 * A value an administrator (or the buyer) fills in, described as a JSON-Schema subset.
 * The same definition drives environment variables, pre-copied files and purchase-time
 * options, so a preset never needs a bespoke form.
 */
export type ConfigField =
  | { type: "string"; title?: string; description?: string; default?: string; minLength?: number; maxLength?: number; pattern?: string; format?: "password" | "multiline" }
  | { type: "number" | "integer"; title?: string; description?: string; default?: number; minimum?: number; maximum?: number; step?: number }
  | { type: "boolean"; title?: string; description?: string; default?: boolean }
  | { type: "enum"; title?: string; description?: string; default?: string; values: Array<{ value: string; title?: string; description?: string }> }
  | { type: "array"; title?: string; description?: string; items: ConfigField; minItems?: number; maxItems?: number };

export type ConfigValues = Record<string, string | number | boolean>;

/** A named input: the key is what `{{key}}` expands to. */
export interface ConfigParam {
  key: string;
  field: ConfigField;
  /** Scope: `provision` fills environment/files, `purchase` asks the buyer. */
  scope: "provision" | "purchase";
}

/* ------------------------------------------------------------------ *
 * Types: what a plugin can host. Administrators only choose one.
 * ------------------------------------------------------------------ */

export interface InstanceTypeDefinition {
  /** Stable id such as `mc` or `shell`. */
  id: string;
  name: string;
  description?: string;
  pluginId: string;
  /** Emoji or image URL for the type picker. */
  icon?: string;
}

export interface InstanceTypeView extends InstanceTypeDefinition {
  groups: number;
  presets: number;
  instances: number;
}

/* ------------------------------------------------------------------ *
 * Groups: the screen an administrator names, e.g. "MC服务器".
 * ------------------------------------------------------------------ */

export interface InstanceGroup {
  id?: number;
  type_id: string;
  slug: string;
  name: string;
  description: string;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface InstanceGroupView extends InstanceGroup {
  presets: number;
  instances: number;
}

/* ------------------------------------------------------------------ *
 * Presets: one ready-to-run program (Paper, Purpur, Terraria …).
 * ------------------------------------------------------------------ */

export interface PresetPort {
  name: string;
  container: number;
  protocol: "tcp" | "udp";
  /** `auto` picks a free host port in the configured range. */
  host: number | "auto";
}

export interface PresetMount {
  /** Directory inside the instance folder, e.g. `server`. */
  source: string;
  target: string;
  mode: "rw" | "ro";
}

export interface PresetFile {
  source: "inline" | "url" | "path";
  /** Inline content, URL or path relative to the instance folder. */
  value: string;
  /** Destination relative to the instance folder. */
  target: string;
  overwrite: boolean;
}

export interface PresetHealth {
  kind: "none" | "tcp" | "http" | "log";
  /** Port name for tcp/http, or the log pattern for `log`. */
  target: string;
  timeoutSeconds: number;
}

export interface InstancePreset {
  id?: number;
  group_id: number;
  slug: string;
  name: string;
  tagline: string;
  icon: string;
  description: string;
  image: string;
  pull_policy: "missing" | "always" | "never";
  command: string;
  workdir: string;
  env_json: string;
  ports_json: string;
  mounts_json: string;
  files_json: string;
  params_json: string;
  health_json: string;
  stop_signal: string;
  stop_timeout_seconds: number;
  restart: "no" | "on-failure" | "always";
  limits_json: string;
  specs_json: string;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface InstancePresetView extends Omit<InstancePreset, "env_json" | "ports_json" | "mounts_json" | "files_json" | "params_json" | "health_json" | "limits_json" | "specs_json"> {
  env: ConfigValues;
  ports: PresetPort[];
  mounts: PresetMount[];
  files: PresetFile[];
  params: ConfigParam[];
  health: PresetHealth;
  limits: { cpu?: number; memoryMb?: number; diskGb?: number; pids?: number };
  specs: number[];
  group?: InstanceGroup;
}

/* ------------------------------------------------------------------ *
 * Specifications: compute and price only, combinable with any preset.
 * ------------------------------------------------------------------ */

export interface InstanceSpec {
  id?: number;
  name: string;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  price_cents: number;
  enabled: boolean;
  sort_order: number;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface InstanceSpecView extends InstanceSpec {
  instances: number;
}

/* ------------------------------------------------------------------ *
 * Instances.
 * ------------------------------------------------------------------ */

export type InstanceState = "creating" | "running" | "stopped" | "failed" | "removed";

export interface InstanceRow {
  id?: number;
  instance_id: string;
  tenant_id: number;
  project_id: number;
  owner_user_id: number;
  type_id: string;
  group_id: number;
  preset_id: number;
  spec_id: number;
  name: string;
  container_id: string;
  status: InstanceState;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  ports_json: string;
  params_json: string;
  last_error: string;
  order_id: string;
  started_at: string;
  stopped_at: string;
  created_at: string;
  updated_at: string;
}

export interface Instance extends InstanceRow {
  ports: Array<{ name: string; host: number; container: number; protocol: string }>;
  params: ConfigValues;
  projectName?: string;
  preset?: InstancePresetView;
  spec?: InstanceSpec;
}

export interface InstanceEventRow {
  id?: number;
  instance_id: string;
  event_type: string;
  message: string;
  actor_user_id: number;
  created_at: string;
}

/* ------------------------------------------------------------------ *
 * Provisioning request handed to the store purchase handler.
 * ------------------------------------------------------------------ */

export interface InstancePurchase {
  user: User;
  tenantId: number;
  project: { id: number; name: string };
  preset: InstancePreset;
  spec: InstanceSpec;
  /** Values the buyer picked for `scope: "purchase"` params. */
  params: ConfigValues;
  /** Idempotency key of the order line. */
  orderKey: string;
}

/* ------------------------------------------------------------------ *
 * Service.
 * ------------------------------------------------------------------ */

export interface InstanceService {
  /** A plugin announces the type it can host; returns an unsubscribe handle. */
  registerType(definition: InstanceTypeDefinition): () => void;
  listTypes(): Promise<InstanceTypeView[]>;

  listGroups(typeId?: string): Promise<InstanceGroupView[]>;
  createGroup(input: Partial<InstanceGroup>): Promise<InstanceGroupView>;
  updateGroup(id: number, input: Partial<InstanceGroup>): Promise<InstanceGroupView>;
  deleteGroup(id: number): Promise<void>;

  listPresets(groupId?: number): Promise<InstancePresetView[]>;
  findPreset(id: number): Promise<InstancePresetView | undefined>;
  createPreset(input: Partial<InstancePreset>): Promise<InstancePresetView>;
  updatePreset(id: number, input: Partial<InstancePreset>): Promise<InstancePresetView>;
  deletePreset(id: number): Promise<void>;

  listSpecs(): Promise<InstanceSpecView[]>;
  createSpec(input: Partial<InstanceSpec>): Promise<InstanceSpecView>;
  updateSpec(id: number, input: Partial<InstanceSpec>): Promise<InstanceSpecView>;
  deleteSpec(id: number): Promise<void>;

  get(instanceId: string): Promise<Instance | undefined>;
  listForUser(user: User): Promise<Instance[]>;
  listForProject(projectId: number): Promise<Instance[]>;
  authorize(session: Session, instanceId: string): Promise<Instance | undefined>;
  start(instanceId: string, actor?: User): Promise<Instance>;
  stop(instanceId: string, actor?: User): Promise<Instance>;
  remove(instanceId: string, actor?: User, deleteData?: boolean): Promise<void>;
  events(instanceId: string, limit?: number): Promise<InstanceEventRow[]>;
  recordEvent(instanceId: string, type: string, message: string, actor?: User): Promise<void>;
  /** Write a line to the container's stdin and read the console back. */
  sendCommand(instanceId: string, command: string): Promise<string | undefined>;
  /** Resolve the preset of an instance plus its resolved parameters. */
  environment(instanceId: string): Promise<{ preset: InstancePresetView; values: ConfigValues } | undefined>;
}

export interface InstanceConfig {
  dockerSocket: string;
  dataDir: string;
  portRangeStart: number;
  portRangeEnd: number;
  healthTimeoutSeconds: number;
  pullOnCreate: boolean;
}

declare module "@yumerijs/types" {
  interface Tables {
    instance_groups: InstanceGroup;
    instance_presets: InstancePreset;
    instance_specs: InstanceSpec;
    instances: InstanceRow;
    instance_events: InstanceEventRow;
  }
}
declare module "yumeri" {
  interface Components { instances: InstanceService }
}

export const config: Schema<InstanceConfig> = Schema.object({
  dockerSocket: Schema.string("Docker socket path").key("instances.dockerSocket").default("/var/run/docker.sock"),
  dataDir: Schema.string("Directory holding one folder per instance").key("instances.dataDir").default("./data/instances"),
  portRangeStart: Schema.number("First host port handed out automatically").key("instances.portRangeStart").default(30000),
  portRangeEnd: Schema.number("Last host port handed out automatically").key("instances.portRangeEnd").default(30999),
  healthTimeoutSeconds: Schema.number("How long to wait for a container to become healthy").key("instances.healthTimeoutSeconds").default(180),
  pullOnCreate: Schema.boolean("Pull images when the container is created").key("instances.pullOnCreate").default(true),
});
