// index.ts — 扩展入口：注册 workbuddy provider、鉴权/载荷钩子、/workbuddy 命令与侧栏卡片。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { base, chatHeaders, createAuth, type Cred } from "./auth.ts";
import { fetchCredits, type Credits } from "./credits.ts";
import { buildPiModels, loadProductConfigLive } from "./models.ts";
import { loadSettings, saveSettings, type Scope, type WidgetMode } from "./settings.ts";
import { prepareChatPayload } from "./transform.ts";
import { statusLine, widgetLines, formatTokens } from "./ui.ts";

const PROVIDER = "workbuddy";
const MARKER = "X-Pi-WorkBuddy";

type Ui = ExtensionContext["ui"];

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asObject(payload: unknown): Record<string, unknown> | undefined {
  const value = typeof payload === "string" ? tryParseJson(payload) : payload;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function hasMarker(headers: Record<string, string | null>): boolean {
  return headers[MARKER] === "1" || headers[MARKER.toLowerCase()] === "1";
}

/** 侧栏卡片只属于正在跑 workbuddy 模型的会话；命令刷新时 force。 */
function showsCard(provider: unknown, force = false): boolean {
  return force || provider === PROVIDER;
}

export default async function (pi: ExtensionAPI) {
  const auth = createAuth();
  const initial = loadSettings();
  let scope = initial.scope;
  let widget = initial.widget;
  let contextWindows = initial.contextWindows;
  // 启动即拉云端实时目录（未登录或失败自动落到本地缓存/内置兜底）。
  let cred: Cred | undefined;
  try {
    cred = await auth.current();
  } catch { /* 未登录 */ }
  let config = await loadProductConfigLive(cred);
  let models = buildPiModels(config, scope);
  let ids = new Set(models.map((model) => model.id));
  /** 本会话最近一次卡片内容，切模型时先画缓存再后台刷新。 */
  let card: string[] | undefined;

  function apply(next?: Scope) {
    if (next) scope = next;
    pi.registerProvider(PROVIDER, {
      name: "WorkBuddy",
      baseUrl: `${base()}/v2`,
      api: "openai-completions",
      headers: { [MARKER]: "1" },
      oauth: {
        name: "WorkBuddy",
        login: (callbacks) => auth.login(callbacks),
        refreshToken: (credentials) => auth.refreshOAuth(credentials),
        getApiKey: (credentials: OAuthCredentials) => credentials.access,
      },
      models: rebuild(),
      async refreshModels() {
        const settings = loadSettings();
        scope = settings.scope;
        widget = settings.widget;
        contextWindows = settings.contextWindows;
        try {
          cred = (await auth.current()) ?? cred;
          config = await loadProductConfigLive(cred);
        } catch { /* 云端失败保留现有目录 */ }
        return rebuild();
      },
    });
  }

  function rebuild() {
    models = buildPiModels(config, scope, contextWindows);
    ids = new Set(models.map((model) => model.id));
    return models;
  }

  function persist(): void {
    saveSettings({ scope, widget, contextWindows });
  }

  /** 画侧栏卡片并返回所画行（隐藏时 undefined）。积分尽力而为，失败只降级显示。 */
  async function paint(
    ctx: { ui: Ui; model?: { provider?: string } },
    options: { notify?: boolean; force?: boolean } = {},
  ): Promise<string[] | undefined> {
    const { notify = false, force = false } = options;
    if (!showsCard(ctx.model?.provider, force)) {
      ctx.ui.setWidget("workbuddy", undefined);
      ctx.ui.setStatus("workbuddy", undefined);
      return undefined;
    }
    let cred: Cred | undefined;
    let credits: Credits | undefined;
    let error: string | undefined;
    try {
      cred = await auth.resolve();
      credits = await fetchCredits(cred);
    } catch (caught) {
      cred = await auth.current();
      error = caught instanceof Error ? caught.message : String(caught);
    }
    // 简：不渲染 widget 行，积分余额只在底栏状态行；全：完整卡片 + 底栏。
    const lines = widget === "full" ? widgetLines({ cred, credits, error, scope, models }) : undefined;
    ctx.ui.setWidget("workbuddy", lines);
    ctx.ui.setStatus("workbuddy", statusLine(credits, cred));
    if (notify) {
      ctx.ui.notify(
        error && !credits ? `WorkBuddy：${error}` : `WorkBuddy 已刷新${credits ? ` · 积分 ${credits.total}` : ""}`,
        error && !credits ? "warning" : "info",
      );
    }
    return lines;
  }

  apply();

  pi.on("before_provider_headers", async (event) => {
    if (!hasMarker(event.headers)) return;
    const cred = await auth.resolve();
    event.headers[MARKER] = null;
    event.headers[MARKER.toLowerCase()] = null;
    for (const [key, value] of Object.entries(chatHeaders(cred))) event.headers[key] = value;
  });

  pi.on("before_provider_request", (event) => {
    // 该钩子不带 provider 信息，按模型 id 判定，避免改写其他 provider 的请求。
    const payload = asObject(event.payload);
    if (!payload || typeof payload.model !== "string" || !ids.has(payload.model)) return;
    return prepareChatPayload(payload);
  });

  pi.on("session_start", (_event, ctx) => {
    // 不阻塞会话启动；卡片是可选信息。
    void paint(ctx).then((lines) => { card = lines; }).catch(() => undefined);
  });

  pi.on("model_select", (_event, ctx) => {
    // setModel 会等待本处理器，绝不能在此等网络：先画缓存，后台刷新。
    if (!showsCard(ctx.model?.provider)) {
      card = undefined;
      ctx.ui.setWidget("workbuddy", undefined);
      ctx.ui.setStatus("workbuddy", undefined);
      return;
    }
    if (card) ctx.ui.setWidget("workbuddy", card);
    void paint(ctx).then((lines) => { card = lines; }).catch(() => undefined);
  });

  pi.registerCommand("workbuddy", {
    description: "WorkBuddy 设置：刷新积分、状态行简/全、免费/全部模型、断开登录",
    handler: async (args, ctx) => {
      const cmd = String(args ?? "").trim().toLowerCase();
      const setWidgetMode = (mode: WidgetMode) => {
        widget = mode;
        persist();
      };
      if (cmd === "free" || cmd === "all") {
        scope = cmd;
        persist();
        apply(cmd);
        await paint(ctx, { notify: true, force: true });
        return;
      }
      if (cmd === "full" || cmd === "全") {
        setWidgetMode("full");
        await paint(ctx, { notify: true, force: true });
        return;
      }
      if (cmd === "simple" || cmd === "compact" || cmd === "简") {
        setWidgetMode("simple");
        await paint(ctx, { notify: true, force: true });
        return;
      }
      if (cmd === "logout" || cmd === "disconnect") {
        await auth.logout();
        await paint(ctx, { notify: true, force: true });
        return;
      }
      const pick = await ctx.ui.select("WorkBuddy 设置", [
        "刷新积分与账号",
        widget === "simple" ? "状态行：切换为全（完整卡片）" : "状态行：切换为简（只显示积分）",
        "上下文窗口（按模型选档）",
        scope === "free" ? "列出全部模型（含付费）" : "只列出免费模型",
        "重新登录（浏览器授权）",
        "断开登录",
      ]);
      if (pick === undefined) return;
      if (pick.startsWith("刷新积分")) {
        // paint 会重新拉积分，无需额外动作。
      } else if (pick.startsWith("状态行")) {
        setWidgetMode(widget === "simple" ? "full" : "simple");
      } else if (pick.startsWith("上下文窗口")) {
        const modelPick = await ctx.ui.select(
          "上下文窗口：选择模型",
          models.map((m) => `${m.id}（当前 ${formatTokens(m.contextWindow)}）`),
        );
        if (modelPick !== undefined) {
          const id = modelPick.split("（")[0]?.trim() ?? "";
          const tiers = config.models.find((m) => m.id === id)?.windowOptions?.supported;
          if (!tiers || tiers.length < 2) {
            ctx.ui.notify(`${id} 无档位选项，固定按物理上限`, "info");
          } else {
            const labels = tiers.map((t) => formatTokens(t));
            const tierPick = await ctx.ui.select(`上下文窗口：${id}`, labels);
            const value = tierPick === undefined ? undefined : tiers[labels.indexOf(tierPick)];
            if (value !== undefined) {
              contextWindows = { ...contextWindows, [id]: value };
              persist();
              apply();
            }
          }
        }
      } else if (pick.startsWith("列出全部")) {
        scope = "all";
        persist();
        apply("all");
      } else if (pick.startsWith("只列出")) {
        scope = "free";
        persist();
        apply("free");
      } else if (pick.startsWith("重新登录")) {
        await auth.logout();
        await auth.login({ onAuth: ({ url }) => void ctx.ui.notify(`请在浏览器打开授权页：${url}`, "info") });
      } else if (pick === "断开登录") {
        await auth.logout();
      }
      await paint(ctx, { notify: true, force: true });
    },
  });
}
