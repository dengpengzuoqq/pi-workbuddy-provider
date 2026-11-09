// models.ts — 把 WorkBuddy 产品目录（云端 /v3/config 实时 → 本地缓存文件 → 内置兜底）解析成 pi 模型清单。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { base, chatHeaders, type Cred, type Http } from "./auth.ts";

export type { Http };

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** 推理档位的三种形态：supportedEfforts 列表、固定 effort、无推理配置。 */
export type ReasoningSpec =
  | { kind: "list"; efforts: Effort[] }
  | { kind: "fixed"; effort: string }
  | { kind: "none" };

export type WindowOptions = {
  /** 可选档位，升序、已按 maxInputTokens 截断。 */
  supported: number[];
};

export type ProductModel = {
  id: string;
  name: string;
  credits?: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
  canDisableThinking: boolean;
  reasoning: ReasoningSpec;
  windowOptions?: WindowOptions;
};

export type ProductConfig = {
  source: "cloud" | "cache" | "builtin";
  models: ProductModel[];
  /** 默认 CLI agent（tags 含 cli+default）声明的可选模型白名单——桌面端"有效标识"。 */
  allowedModelIds?: string[];
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens" as const,
};

// ponytail: deepseek-v4.1-flash 推理会循环（OK./Let me write./Go.）烧光 128k max_tokens；16k 止损。
// 上限的唯一权威定义；models 注册与 payload 变换都从这里取。
export const FLASH_MAX_TOKENS = 16_384;

// 国内版内置兜底（缓存不可读时才生效），数值取自 2026-11-07 下午的产品目录快照；
// 服务端目录会轮换，这里只求"没装桌面端时插件仍可用"。
const BUILTIN_MODELS: ProductModel[] = [
  {
    id: "hy3",
    name: "Hy3",
    credits: "x0.00",
    contextWindow: 192_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
    canDisableThinking: false,
    reasoning: { kind: "list", efforts: ["low", "high"] },
  },
  {
    id: "deepseek-v4-flash",
    name: "Deepseek-V4-Flash",
    credits: "x0.06",
    contextWindow: 1_000_000,
    maxTokens: 50_000,
    supportsImages: true,
    supportsReasoning: true,
    canDisableThinking: true,
    reasoning: { kind: "list", efforts: ["low", "high", "max"] },
  },
  {
    id: "glm-5.0-turbo",
    name: "GLM-5.0-Turbo",
    credits: "x0.95",
    contextWindow: 200_000,
    maxTokens: 48_000,
    supportsImages: true,
    supportsReasoning: true,
    canDisableThinking: false,
    reasoning: { kind: "fixed", effort: "medium" },
  },
];

/** pi 的 thinking 档位 → 上游 effort。列表模型按档位过滤；固定 effort 模型直通（与桌面端无钳制语义一致）。 */
export function thinkingLevelMap(spec: ReasoningSpec, canDisable = false) {
  if (spec.kind === "none") {
    return { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } as const;
  }
  if (spec.kind === "fixed") {
    return {
      off: canDisable ? "off" : null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    } as const;
  }
  const efforts = spec.efforts;
  return {
    off: canDisable ? "off" : null,
    minimal: null,
    low: efforts.includes("low") ? "low" : null,
    medium: efforts.includes("medium") ? "medium" : null,
    high: efforts.includes("high") ? "high" : null,
    xhigh: efforts.includes("xhigh") ? "xhigh" : null,
    max: efforts.includes("max") ? "max" : null,
  } as const;
}

/** 计价串两种实测形态："x0.16" 与 "x0.16 credits"（2026-11 目录刷新后带后缀）。 */
export function creditsAreFree(credits: string | undefined): boolean {
  if (credits === undefined) return false;
  return /^x?0(?:\.0+)?(?:\s+credits)?$/iu.test(credits.trim());
}

/** 显示用计价串：去掉 " credits" 后缀。 */
function displayCredits(credits: string | undefined): string {
  return credits?.replace(/\s+credits$/i, "") ?? "x?";
}

function unwrap(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseEffort(value: unknown): Effort | undefined {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value)
    ? value as Effort
    : undefined;
}

function parseProductModel(value: unknown): ProductModel | undefined {
  const row = unwrap(value);
  if (!row) return undefined;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (id === "") return undefined;
  const reasoning = unwrap(row.reasoning);
  const onlyReasoning = row.onlyReasoning === true;
  // 与桌面端一致：onlyReasoning 或 canDisableThinking===false 时不能关闭思考。
  const canDisable = !onlyReasoning && reasoning?.canDisableThinking !== false;
  // 目录的 contextWindow 档位对象（如 {defaultLength:300000, supportedLengths:[...]}）；
  // 档位升序去重，并按 maxInputTokens 截断（与桌面端选择器同规则）。
  const rawWindow = unwrap(row.contextWindow);
  const rawLengths = Array.isArray(rawWindow?.supportedLengths) ? rawWindow.supportedLengths : [];
  const physicalWindow = positiveNumber(row.maxInputTokens) ?? positiveNumber(row.maxAllowedSize);
  let windowOptions: WindowOptions | undefined;
  if (rawLengths.length > 0) {
    const supported = [...new Set(rawLengths)]
      .filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0)
      .filter((n) => physicalWindow === undefined || n <= physicalWindow)
      .sort((a, b) => a - b);
    if (supported.length > 0) {
      windowOptions = { supported };
    }
  }
  const rawEfforts = reasoning?.supportedEfforts;
  let spec: ReasoningSpec = { kind: "none" };
  if (Array.isArray(rawEfforts)) {
    const efforts = rawEfforts.map(parseEffort).filter((e): e is Effort => e !== undefined);
    if (efforts.length > 0) spec = { kind: "list", efforts };
  }
  if (spec.kind === "none" && typeof reasoning?.effort === "string" && reasoning.effort !== "") {
    spec = { kind: "fixed", effort: reasoning.effort };
  }
  return {
    id,
    name: typeof row.name === "string" && row.name !== "" ? row.name : id,
    ...(typeof row.credits === "string" && row.credits.trim() !== "" ? { credits: row.credits.trim() } : {}),
    contextWindow: positiveNumber(row.maxInputTokens) ?? positiveNumber(row.maxAllowedSize) ?? 0,
    maxTokens: positiveNumber(row.maxOutputTokens) ?? 0,
    supportsImages: row.supportsImages === true && row.disabledMultimodal !== true,
    supportsReasoning: row.supportsReasoning === true,
    canDisableThinking: canDisable,
    reasoning: spec,
    ...(windowOptions ? { windowOptions } : {}),
  };
}

/** 默认 CLI agent 的模型白名单：桌面端聊天/会话只允许这些 id（hy3-b 等副本不在其中）。 */
function parseAllowedModelIds(document: Record<string, unknown>): string[] | undefined {
  const agents = Array.isArray(document.agents) ? document.agents : [];
  for (const agent of agents) {
    const row = unwrap(agent);
    if (!row) continue;
    const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [];
    const isDefaultCli = row.name === "cli" || (tags.includes("cli") && tags.includes("default"));
    if (!isDefaultCli) continue;
    const models = Array.isArray(row.models)
      ? row.models.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim())
      : [];
    return models.length > 0 ? models : undefined;
  }
  return undefined;
}

export function parseProductConfig(text: string): ProductConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = unwrap(parsed);
  if (!document || !Array.isArray(document.models)) return undefined;
  const models = document.models.map(parseProductModel).filter((m): m is ProductModel => m !== undefined);
  if (models.length === 0) return undefined;
  const allowedModelIds = parseAllowedModelIds(document);
  return { source: "cache", models, ...(allowedModelIds ? { allowedModelIds } : {}) };
}

// 国内版缓存路径优先，其次国际版路径（切 WORKBUDDY_BASE_URL 时兜底）。
function productConfigCandidates(): string[] {
  const candidates: string[] = [];
  const override = process.env.WORKBUDDYAI_PRODUCT_CONFIG?.trim();
  if (override) candidates.push(override);
  const home = homedir();
  candidates.push(join(home, ".workbuddy", "cache", "acc-product-config-v3.json"));
  candidates.push(join(home, ".workbuddy-ai", "cache", "acc-product-config-v3.json"));
  return candidates;
}

export function loadProductConfig(cachePath?: string): ProductConfig {
  const candidates = cachePath ? [cachePath, ...productConfigCandidates()] : productConfigCandidates();
  for (const path of candidates) {
    try {
      const parsed = parseProductConfig(readFileSync(path, "utf8"));
      if (parsed) return parsed;
    } catch { /* 缺失/不可读 → 试下一个 → 内置兜底 */ }
  }
  return { source: "builtin", models: BUILTIN_MODELS };
}

/** 桌面端聊天目录的权威来源：带用户凭据拉 /v3/config，返回的就是当前账号可见的模型（含 hy4 等 SKU 轮换）。 */
export async function fetchCloudProductConfig(
  cred: Cred,
  opts: { http?: Http; baseUrl?: string } = {},
): Promise<ProductConfig> {
  const http = opts.http ?? fetch;
  const origin = opts.baseUrl ?? base();
  const response = await http(`${origin}/v3/config`, {
    headers: { ...chatHeaders(cred), "X-Request-Id": crypto.randomUUID().replaceAll("-", "") },
    signal: AbortSignal.timeout(10_000),
  });
  const envelope = unwrap(await response.json()) ?? {};
  const data = unwrap(envelope.data) ?? {};
  if (!response.ok || envelope.code !== 0) {
    throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : `v3/config ${response.status}`);
  }
  const parsed = parseProductConfig(JSON.stringify(data));
  if (!parsed) throw new Error("v3/config response has no models");
  return { ...parsed, source: "cloud" as const };
}

export type LoadConfigOptions = {
  http?: Http;
  baseUrl?: string;
  /** 测试注入；正常路径用产品配置缓存候选列表。 */
  cachePath?: string;
};

/** 目录加载链：已登录 → 云端实时；云端失败或未登录 → 本地缓存文件；都不可用 → 内置兜底。 */
export async function loadProductConfigLive(
  cred: Cred | undefined,
  opts: LoadConfigOptions = {},
): Promise<ProductConfig> {
  if (cred) {
    try {
      return await fetchCloudProductConfig(cred, opts);
    } catch { /* 云端失败 → 文件兜底 */ }
  }
  return loadProductConfig(opts.cachePath);
}

// 内置清单里的免费模型（与 credits: "x0.00" 单一来源，避免两处维护）。
export const FREE_IDS: readonly string[] = BUILTIN_MODELS
  .filter((model) => creditsAreFree(model.credits))
  .map((model) => model.id);

export function freeModelIds(config: ProductConfig): readonly string[] {
  if (config.source === "builtin") return FREE_IDS;
  const free = config.models.filter((m) => creditsAreFree(m.credits)).map((m) => m.id);
  return free.length > 0 ? free : FREE_IDS;
}

export function buildPiModels(
  config: ProductConfig,
  scope: "free" | "all",
  contextWindows: Record<string, number> = {},
) {
  // 云端/缓存可读时以其为准；仅内置兜底（无桌面端且无云端）时用内置清单。
  const byId = new Map<string, ProductModel>();
  for (const model of (config.source === "builtin" ? BUILTIN_MODELS : config.models)) {
    byId.set(model.id, model);
  }
  // 白名单（agents.cli.models）决定"哪些模型可选"及其顺序；缺失时回退全量目录。
  const selected = config.allowedModelIds
    ? config.allowedModelIds.map((id) => byId.get(id)).filter((m): m is ProductModel => m !== undefined)
    : [...byId.values()];
  const free = new Set(freeModelIds(config));
  const rows = selected.filter((model) => scope === "all" || free.has(model.id));
  // 与桌面端选择器一致：同名家族（hy3/hy3-b/hy3-c、hy4free/hy4std 等部署副本）只保留
  // 一个 SKU——优先免费档，否则目录首个。目录没有"有效标识"字段，去重即该规则。
  const byName = new Map<string, ProductModel>();
  for (const row of rows) {
    const existing = byName.get(row.name);
    if (existing === undefined || (creditsAreFree(row.credits) && !creditsAreFree(existing.credits))) {
      byName.set(row.name, row);
    }
  }
  const deduped = [...byName.values()];
  return deduped.flatMap((row) => {
    // 无上下文窗口或无输出上限的是内部/补全/图像/视频模型，chat 流里无法工作。
    if (row.contextWindow <= 0 || row.maxTokens <= 0) return [];
    // 生效预算：用户覆盖（须在档位内）→ 最高档（用户决定）→ 物理上限。
    const budget = row.windowOptions
      ? (contextWindows[row.id] !== undefined && row.windowOptions.supported.includes(contextWindows[row.id]!)
          ? contextWindows[row.id]!
          : row.windowOptions.supported[row.windowOptions.supported.length - 1]!)
      : row.contextWindow;
    const spec: ReasoningSpec = row.supportsReasoning ? row.reasoning : { kind: "none" };
    return [{
      id: row.id,
      name: `${row.name} · ${displayCredits(row.credits)}`,
      reasoning: row.supportsReasoning,
      thinkingLevelMap: thinkingLevelMap(spec, row.canDisableThinking),
      input: (row.supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: budget,
      maxTokens: row.id === "deepseek-v4.1-flash" ? Math.min(row.maxTokens, FLASH_MAX_TOKENS) : row.maxTokens,
      compat: COMPAT,
    }];
  });
}
