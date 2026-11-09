// ui.ts — WorkBuddy 侧栏卡片的纯渲染：凭据/积分/模型 → 文本行（pi widget 上限 10 行，须压缩在 9 行内）。
import type { Cred } from "./auth.ts";
import { pad2, type Credits } from "./credits.ts";

function fmtExpiry(ms: number): string {
  if (ms <= 0) return "未知";
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export type WidgetInput = {
  cred?: Cred;
  credits?: Credits;
  error?: string;
  scope: "free" | "all";
  models: { name: string }[];
};

const MAX_PACK_LINE = 3;
const MAX_MODEL_NAMES = 3;

/** 积分组名去掉"套餐/平台"前缀，贴近桌面端的简称显示。 */
function shortPackName(name: string): string {
  return name.replace(/^套餐/, "").replace(/^平台/, "");
}

/** 模型注册名带 " · credits" 后缀，展示按主名去重。 */
function displayNames(models: { name: string }[]): string[] {
  const names: string[] = [];
  for (const model of models) {
    const name = model.name.split(" · ")[0] ?? model.name;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function widgetLines(input: WidgetInput): string[] {
  const lines = [`WorkBuddy · 国内版 · ${input.scope === "all" ? "全部模型" : "仅免费模型"}`];
  if (!input.cred) {
    lines.push("未登录。/login workbuddy 或 /workbuddy 菜单连接");
    if (input.error) lines.push(input.error);
    lines.push("设置  /workbuddy");
    return lines;
  }
  lines.push(`账号  ${input.cred.nickname || input.cred.uid || "已登录"}`);
  lines.push(`令牌  ${fmtExpiry(input.cred.expiresAtMs)} 过期（自动续期）`);
  if (input.credits) {
    const packs = input.credits.packs.filter((pack) => pack.remain > 0 || pack.size > 0);
    lines.push(`积分  合计 ${input.credits.total}`);
    if (packs.length > 0) {
      const shown = packs
        .slice(0, MAX_PACK_LINE)
        .map((pack) => `${shortPackName(pack.name)} ${pack.size > 0 ? pack.size : "∞"}/${pack.remain}`);
      const overflow = packs.length - shown.length;
      lines.push(`  ${shown.join(" · ")}${overflow > 0 ? ` +${overflow}` : ""}`);
    }
  } else if (input.error) {
    lines.push(`积分  ${input.error}`);
  }
  const names = displayNames(input.models);
  const shownNames = names.slice(0, MAX_MODEL_NAMES).join(" · ");
  const modelLine = names.length > MAX_MODEL_NAMES
    ? `${shownNames} +${names.length - MAX_MODEL_NAMES}（共 ${input.models.length} 个，/model 查看）`
    : shownNames === "" ? "（无模型）" : `${shownNames}（共 ${input.models.length} 个）`;
  lines.push(`模型  ${modelLine}`);
  lines.push("设置  /workbuddy");
  return lines;
}

/** 底栏 status 文案：积分余额常驻状态行（简版不渲染 widget 行，靠它显示；全版卡片照旧）。 */
export function statusLine(credits: Credits | undefined, cred: Cred | undefined): string | undefined {
  return credits ? `积分 ${credits.total}` : cred ? "WorkBuddy 已登录" : "WorkBuddy 未登录";
}

/** 档位显示：300000 -> "300K"，1000000 -> "1M"。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}
