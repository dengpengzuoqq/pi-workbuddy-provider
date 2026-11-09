// settings.ts — 插件本机设置（模型范围 free|all、状态行 simple|full），存 pi agent 目录。
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Scope = "free" | "all";
export type WidgetMode = "simple" | "full";

export type Settings = { scope: Scope; widget: WidgetMode; contextWindows: Record<string, number> };

function settingsPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(dir, ".workbuddy-settings.json");
}

export function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
      scope?: string;
      widget?: string;
      contextWindows?: Record<string, unknown>;
    };
    const contextWindows: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed.contextWindows ?? {})) {
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) contextWindows[id] = value;
    }
    return {
      scope: parsed.scope === "free" ? "free" : "all",
      // 初始为简版（只显示积分余额）。
      widget: parsed.widget === "full" ? "full" : "simple",
      contextWindows,
    };
  } catch {
    return { scope: "all", widget: "simple", contextWindows: {} };
  }
}

export function saveSettings(settings: Settings): void {
  writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
