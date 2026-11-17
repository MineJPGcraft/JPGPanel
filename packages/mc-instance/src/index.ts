import { writeFileSync } from "node:fs";
import path from "node:path";
import { Context, Session } from "yumeri";
import "@mirelia/dashboard";
import "@jpgpanel/server-instances";
import type { InstanceService } from "@jpgpanel/server-instances";

export const depend = ["dashboard", "instances"];
export const provide: string[] = [];

/**
 * Minecraft tooling only. The panel owns containers, files and lifecycle; this plugin
 * contributes two components for instances whose type is `mc`:
 *
 * * players — online players and capacity, read from the container
 * * settings — a form over `server.properties`
 *
 * Nothing here creates instances or installs software: that is a preset.
 */
function propertyFile(instanceId: string) {
  return path.join(process.cwd(), "data", "instances", instanceId, "server", "server.properties");
}

/** Read the `list` answer out of a container's console, e.g. "There are 2 of a max of 20 players". */
export function parsePlayerList(output: string) {
  const summary = output.match(/There are (\d+) of a max of (\d+) players online:?\s*(.*)/i);
  if (!summary) return undefined;
  const names = summary[3].split(/\s*,\s*/).map((name) => name.trim()).filter(Boolean);
  return { count: Number(summary[1]), max: Number(summary[2]), players: names.map((name) => ({ name })) };
}

export async function apply(ctx: Context) {
  ctx.i18n({ cloud: { mc: {
    nav: { players: { zh: "在线人数", en: "Players", ja: "プレイヤー" }, settings: { zh: "服务器设置", en: "Server settings", ja: "サーバー設定" } },
    players: {
      title: { zh: "在线人数", en: "Online players", ja: "オンラインプレイヤー" },
      online: { zh: "在线", en: "Online", ja: "オンライン" },
      capacity: { zh: "容量", en: "Capacity", ja: "定員" },
      list: { zh: "玩家列表", en: "Player list", ja: "プレイヤー一覧" },
      empty: { zh: "当前没有玩家在线", en: "No players online", ja: "オンラインのプレイヤーはいません" },
      unavailable: { zh: "无法读取玩家列表：请确认镜像开启了 RCON 或 Query，并在预设中声明对应端口。", en: "Could not read the player list: make sure the image enables RCON or query and the preset declares its port.", ja: "プレイヤー一覧を取得できません。RCON または query とそのポートをプリセットで設定してください。" },
      refresh: { zh: "刷新", en: "Refresh", ja: "更新" },
    },
    settings: {
      title: { zh: "服务器设置", en: "Server settings", ja: "サーバー設定" },
      description: { zh: "直接编辑 server.properties，保存后重启服务器生效。", en: "Edits server.properties directly. Restart the server to apply.", ja: "server.properties を直接編集します。再起動で反映されます。" },
      save: { zh: "保存设置", en: "Save settings", ja: "設定を保存" },
      saved: { zh: "已保存，重启服务器后生效", en: "Saved. Restart the server to apply.", ja: "保存しました。再起動で反映されます。" },
      missing: { zh: "未找到 server.properties，请确认预设的挂载目录。", en: "server.properties was not found; check the preset mounts.", ja: "server.properties が見つかりません。プリセットのマウントを確認してください。" },
      search: { zh: "搜索设置项", en: "Search settings", ja: "設定を検索" },
    },
  } } });

  const instances = ctx.component.instances as InstanceService;
  const render = (session: Session, status: number, body: Record<string, unknown>) => { session.status = status; session.respond(body, "json"); };

  /** Players online, parsed from the container console response to `list`. */
  ctx.route("/api/instances/:id/type/mc/players").methods("GET").action(async (session, _query, id) => {
    const instance = await instances.authorize(session, id);
    if (!instance) return;
    const output = await instances.sendCommand(id, "list").catch(() => undefined);
    const parsed = output ? parsePlayerList(output) : undefined;
    if (!parsed) { render(session, 503, { error: session.text("cloud.mc.players.unavailable") }); return; }
    session.respond({ players: parsed.players, max: parsed.max, count: parsed.count }, "json");
  });

  ctx.route("/api/instances/:id/type/mc/properties").methods("GET").action(async (session, _query, id) => {
    const instance = await instances.authorize(session, id);
    if (!instance) return;
    const { readFileSync, existsSync } = await import("node:fs");
    const file = propertyFile(id);
    if (!existsSync(file)) { render(session, 404, { error: session.text("cloud.mc.settings.missing") }); return; }
    session.respond({ content: readFileSync(file, "utf8") }, "json");
  });

  ctx.route("/api/instances/:id/type/mc/properties").methods("PUT").action(async (session, _query, id) => {
    const instance = await instances.authorize(session, id);
    if (!instance) return;
    const body = (await session.parseRequestBody()) as { properties?: Array<{ key?: unknown; value?: unknown }> };
    const entries = Array.isArray(body.properties) ? body.properties : [];
    const lines = ["#Minecraft server properties", "#Edited from the panel"];
    for (const entry of entries) {
      const key = String(entry.key ?? "").trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) continue;
      lines.push(`${key}=${String(entry.value ?? "").replace(/\r?\n/g, "").slice(0, 2000)}`);
    }
    writeFileSync(propertyFile(id), `${lines.join("\n")}\n`);
    await instances.recordEvent(id, "configured", `server.properties updated by ${(await ctx.component.user.current(session))?.username ?? "user"}`);
    session.respond({ ok: true }, "json");
  });
}

export default apply;
