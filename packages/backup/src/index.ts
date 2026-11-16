import { Context, Logger, Schema } from "yumeri";
import type { InstanceService } from "@jpgpanel/server-instances";
import "@jpgpanel/server-instances";

// file-manager provides the archive helpers, so it must be loaded first.
export const depend = ["file-manager", "instances"];
export const provide: string[] = [];

/**
 * Scheduled backups. The file manager owns the archive format and restore logic; this
 * plugin only decides *when* a backup runs, based on each instance type's
 * `autoBackupHours` setting.
 */
export interface BackupConfig {
  /** How often to look for instances that are due, in minutes. */
  intervalMinutes: number;
  /** Skip instances whose type does not expose an automatic backup setting. */
  onlyConfigured: boolean;
}

export const config: Schema<BackupConfig> = Schema.object({
  intervalMinutes: Schema.number("How often to check for due backups").key("backup.intervalMinutes").default(15),
  onlyConfigured: Schema.boolean("Only back up instances that set autoBackupHours").key("backup.onlyConfigured").default(true),
});

export interface BackupFilesService {
  createBackup(instanceId: string, user?: { id?: number; username?: string }): Promise<{ id: string; name: string; size: number; created_at: string }>;
  backups(instanceId: string): Array<{ id: string; name: string; size: number; created_at: string }>;
  restore(instanceId: string, id: string, user?: { id?: number; username?: string }): Promise<void>;
  keep(): number;
}

const logger = new Logger("backup");

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export async function apply(ctx: Context, pluginConfig: BackupConfig = { intervalMinutes: 15, onlyConfigured: true }) {
  const instances = ctx.component.instances as InstanceService;
  const files = ctx.component.files as BackupFilesService | undefined;
  const db = ctx.component.database;
  const lastRun = new Map<string, number>();

  if (!files) {
    logger.warn("file-manager is not loaded; scheduled backups are disabled");
    return;
  }

  async function dueInstances() {
    const rows = await db.select("instances", {}) as Array<{ instance_id: string; type_id: string; created_at: string }>;
    const due: string[] = [];
    for (const row of rows) {
      const config = await instances.config(row.instance_id).catch(() => undefined);
      const hours = Number(config?.values.autoBackupHours ?? 0);
      if (!Number.isFinite(hours) || hours <= 0) continue;
      const previous = lastRun.get(row.instance_id) ?? 0;
      if (Date.now() - previous >= hours * 3600 * 1000) due.push(row.instance_id);
    }
    return due;
  }

  async function sweep() {
    for (const instanceId of await dueInstances()) {
      lastRun.set(instanceId, Date.now());
      try {
        const backup = await files!.createBackup(instanceId);
        await instances.recordEvent(instanceId, "configured", `automatic backup ${backup.name}`);
      } catch (error) {
        lastRun.delete(instanceId);
        logger.warn(`automatic backup failed for ${instanceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  ctx.setInterval(() => { void sweep(); }, Math.max(1, pluginConfig.intervalMinutes) * 60 * 1000);
  void object;
  void instances;
}

export default apply;
