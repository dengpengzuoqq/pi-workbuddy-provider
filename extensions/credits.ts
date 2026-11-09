// credits.ts — 积分查询（尽力而为）：优先国内无前缀 summary 接口，回落国际版老接口。
import { base, chatHeaders, type Cred, type Http } from "./auth.ts";

export type Pack = { name: string; remain: number; size: number };
export type Credits = { total: number; packs: Pack[] };

export type FetchCreditsOptions = {
  http?: Http;
  baseUrl?: string;
};

function unwrap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 容量字段是字符串小数（"625.25000193"），兼容 number；非法值记 0。 */
function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 国内 summary 接口（`/billing/meter/get-user-resource-summary`）的回包解析。 */
export function parseResourceSummary(envelope: unknown): Credits {
  const data = unwrap(unwrap(envelope).data);
  const groups = Array.isArray(data.CreditGroups) ? data.CreditGroups : [];
  const rawPacks = groups.length > 0
    ? groups
    : Array.isArray(data.Packages) ? data.Packages : [];
  const packs: Pack[] = [];
  let sum = 0;
  for (const item of rawPacks) {
    const pack = unwrap(item);
    const size = toCount(pack.CycleTotalCapacity);
    const remain = round2(Math.max(0, toCount(pack.CycleRemainCapacity)));
    sum += remain;
    const name = typeof pack.Name === "string" && pack.Name !== ""
      ? pack.Name
      : typeof pack.PackageCode === "string" && pack.PackageCode !== "" ? pack.PackageCode : "(unnamed)";
    packs.push({ name, remain, size });
  }
  const total = toCount(data.TotalCredits);
  return { total: round2(total > 0 ? total : sum), packs };
}

/** 国际版老接口（`/v2/billing/meter/get-user-resource`）的回包解析，作回落。 */
export function parseCredits(envelope: unknown): Credits {
  const data = unwrap(unwrap(envelope).data);
  const response = unwrap(data.Response);
  const inner = unwrap(response.Data);
  const raw = Array.isArray(inner.Accounts) ? inner.Accounts : [];
  const packs: Pack[] = [];
  let total = 0;
  for (const item of raw) {
    const account = unwrap(item);
    const num = (key: string): number => (typeof account[key] === "number" ? account[key] as number : 0);
    const size = num("CycleCapacitySize");
    const cycleRemain = num("CycleCapacityRemain");
    const cycleUsed = num("CycleCapacityUsed");
    let remain = size > 0 || cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : num("CapacityRemain");
    if (remain < 0) remain = 0;
    total += remain;
    packs.push({
      name: typeof account.PackageName === "string" ? account.PackageName : "(unnamed)",
      remain,
      size: size > 0 ? size : num("CapacitySize"),
    });
  }
  return { total, packs };
}

function fmtStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

async function postJson(
  http: Http,
  url: string,
  cred: Cred,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; envelope: Record<string, unknown> }> {
  const response = await http(url, {
    method: "POST",
    headers: {
      ...chatHeaders(cred),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { ok: response.ok, status: response.status, envelope: unwrap(await response.json()) };
}

/** summary 不通（404/错误信封）时回落老接口；两者都失败才抛错（侧栏据此降级）。 */
export async function fetchCredits(cred: Cred, options: FetchCreditsOptions = {}): Promise<Credits> {
  const http = options.http ?? fetch;
  const origin = options.baseUrl ?? base();
  const errors: string[] = [];

  try {
    const { ok, status, envelope } = await postJson(http, `${origin}/billing/meter/get-user-resource-summary`, cred, {});
    if (ok && envelope.code === 0) return parseResourceSummary(envelope);
    errors.push(`summary ${ok ? envelope.code : status}`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const now = new Date();
    const { ok, status, envelope } = await postJson(http, `${origin}/v2/billing/meter/get-user-resource`, cred, {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmtStamp(now),
      // 老接口要求包结束时间窗口；上界给 ~101 年（365*101 天），覆盖所有在售/存量包。
      PackageEndTimeRangeEnd: fmtStamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    });
    const msg = unwrap(envelope).msg;
    if (ok && envelope.code === 0) return parseCredits(envelope);
    errors.push(`legacy ${ok ? envelope.code : status}${typeof msg === "string" ? ` ${msg}` : ""}`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  throw new Error(`credits ${errors.join("; ")}`);
}
