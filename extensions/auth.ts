// auth.ts — WorkBuddy 国内版凭据：设备授权登录、own 存储、到期自动刷新（single-flight）。
import { chmod, unlink, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";

export type Http = typeof fetch;

const DEFAULT_BASE = "https://www.workbuddy.cn";
// 桌面端真实 UA（2026-11 观测）；上游可能校验客户端形态。
const CLIENT_UA = "WorkBuddy/5.6.2 WorkBuddy/5.6.2 CLI/2.147.0";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export type Cred = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
};

export type AuthOptions = {
  dir?: string;
  baseUrl?: string;
  http?: Http;
  /** 测试注入；登录轮询间隔。 */
  pollIntervalMs?: number;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function base(baseUrl?: string): string {
  return baseUrl ?? process.env.WORKBUDDY_BASE_URL?.trim() ?? DEFAULT_BASE;
}

function agentDir(dir?: string): string {
  return dir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function ownPath(dir?: string): string {
  return join(agentDir(dir), ".workbuddy-auth.json");
}

export function parseOwn(text: string): Cred | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const document = parsed as Record<string, unknown>;
  if (document.version !== 1 || typeof document.credential !== "object" || document.credential === null) {
    return undefined;
  }
  const stored = document.credential as Record<string, unknown>;
  const accessToken = typeof stored.accessToken === "string" ? stored.accessToken : "";
  if (accessToken === "") return undefined;
  const enterpriseId = optionalString(stored.enterpriseId);
  const nickname = optionalString(stored.nickname);
  return {
    accessToken,
    refreshToken: typeof stored.refreshToken === "string" ? stored.refreshToken : "",
    expiresAtMs: typeof stored.expiresAtMs === "number" ? stored.expiresAtMs : 0,
    domain: optionalString(stored.domain) ?? "",
    uid: optionalString(stored.uid) ?? "",
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const padded = part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** 国内端点时间字段口径混乱：expiresIn 可能是相对秒、相对毫秒或绝对毫秒，expiresAt 是绝对秒/毫秒。 */
function expiryFromTokenData(data: Record<string, unknown>, now: number): number {
  const expiresIn = data.expiresIn;
  if (typeof expiresIn === "number" && expiresIn > 0) {
    if (expiresIn > 1e12) return expiresIn;
    if (expiresIn > 1e9) return now + expiresIn;
    return now + expiresIn * 1000;
  }
  const expiresAt = data.expiresAt;
  if (typeof expiresAt === "number" && expiresAt > 0) {
    return expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
  }
  return 0;
}

export function credFromPluginToken(
  data: Record<string, unknown>,
  accessToken: string,
  now = Date.now(),
): Cred {
  const jwt = jwtPayload(accessToken);
  const uid = optionalString(data.uid)
    ?? optionalString(jwt.uid)
    ?? optionalString(jwt.sub)
    ?? optionalString(jwt.email)
    ?? "";
  const enterpriseId = optionalString(data.enterpriseId) ?? optionalString(data.enterprise_id);
  const nickname = optionalString(data.nickname)
    ?? optionalString(jwt.nickname)
    ?? optionalString(jwt.preferred_username)
    ?? optionalString(jwt.email)
    ?? optionalString(jwt.name);
  return {
    accessToken,
    refreshToken: optionalString(data.refreshToken) ?? "",
    expiresAtMs: expiryFromTokenData(data, now),
    domain: optionalString(data.domain) ?? DEFAULT_BASE.replace("https://", ""),
    uid,
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

function unwrap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clientHeaders(): Record<string, string> {
  const origin = base();
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": CLIENT_UA,
    "X-Requested-With": "XMLHttpRequest",
    "X-Product": "SaaS",
  };
}

export function chatHeaders(cred: Cred): Record<string, string> {
  return {
    ...clientHeaders(),
    Authorization: `Bearer ${cred.accessToken}`,
    ...(cred.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": cred.uid }),
    ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : { "X-No-Enterprise-Id": "1" }),
    ...(cred.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": cred.domain }),
  };
}

/** 设备授权回调的窄类型：pi 传入的完整 OAuthLoginCallbacks 结构兼容它。 */
export type LoginCallbacks = {
  onAuth: (info: { url: string }) => void;
  onProgress?: (message: string) => void;
};

/** 一套可注入（目录/HTTP/轮询间隔）的凭据生命周期；index.ts 用默认依赖的实例。 */
export function createAuth(options: AuthOptions = {}) {
  const http = options.http ?? fetch;
  const origin = base(options.baseUrl);
  const dir = options.dir;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  let inflight: Promise<Cred> | undefined;

  async function readOwn(): Promise<Cred | undefined> {
    try {
      return parseOwn(await readFile(ownPath(dir), "utf8"));
    } catch {
      return undefined;
    }
  }

  async function saveOwn(cred: Cred): Promise<void> {
    await writeFile(ownPath(dir), JSON.stringify({ version: 1, credential: cred }), { mode: 0o600 });
    // mode 只在创建时生效；已存在的宽松文件每次写回时收紧。
    await chmod(ownPath(dir), 0o600).catch(() => undefined);
  }

  async function refreshAccess(cred: Cred): Promise<Cred> {
    const response = await http(`${origin}/v2/plugin/auth/token/refresh`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        Origin: origin,
        Referer: `${origin}/`,
        "User-Agent": CLIENT_UA,
        "X-Refresh-Token": cred.refreshToken,
        "X-Auth-Refresh-Source": "workbuddy",
        ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = unwrap(await response.json());
    const data = unwrap(envelope.data);
    const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
    if (!response.ok || envelope.code !== 0 || accessToken === "") {
      throw new Error(envelope.msg === "string" && envelope.msg ? envelope.msg : "workbuddy token refresh failed; /login workbuddy 重新授权");
    }
    return {
      ...cred,
      accessToken,
      refreshToken: optionalString(data.refreshToken) ?? cred.refreshToken,
      expiresAtMs: expiryFromTokenData(data, Date.now()) || cred.expiresAtMs,
      domain: optionalString(data.domain) ?? cred.domain,
    };
  }

  async function startPluginLogin(): Promise<{ state: string; authUrl: string }> {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const response = await http(`${origin}/v2/plugin/auth/state?platform=CLI&nonce=${nonce}`, {
      method: "POST",
      headers: { ...clientHeaders(), "X-No-Authorization": "true", "X-No-User-Id": "1", "X-No-Enterprise-Id": "1", "X-No-Department-Info": "1" },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = unwrap(await response.json());
    const data = unwrap(envelope.data);
    const state = optionalString(data.state) ?? "";
    const authUrl = optionalString(data.authUrl) ?? "";
    if (!response.ok || envelope.code !== 0 || state === "" || authUrl === "") {
      throw new Error(optionalString(envelope.msg) ?? "workbuddy login start failed");
    }
    return { state, authUrl };
  }

  async function pollPluginToken(state: string): Promise<Cred> {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let envelope: Record<string, unknown>;
      try {
        const response = await http(`${origin}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
          headers: { ...clientHeaders(), "X-No-Authorization": "true", "X-No-User-Id": "1", "X-No-Enterprise-Id": "1", "X-No-Department-Info": "1" },
          signal: AbortSignal.timeout(30_000),
        });
        envelope = unwrap(await response.json());
      } catch {
        // 国内端点是长轮询：授权完成前请求会被服务端挂住直到本地超时中断。
        // 视为暂时无结果，继续轮询直至整体截止；确切的失败信封走下方判定。
        if (Date.now() + pollIntervalMs >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }
      if (envelope.code === 11217) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }
      const data = unwrap(envelope.data);
      const accessToken = optionalString(data.accessToken) ?? "";
      if (envelope.code !== 0 || accessToken === "") {
        throw new Error(optionalString(envelope.msg) ?? "workbuddy login failed");
      }
      return credFromPluginToken(data, accessToken);
    }
    throw new Error("workbuddy login timed out");
  }

  return {
    current: readOwn,

    /** 到期前 5 分钟内自动刷新；并发调用共享一次刷新。 */
    async resolve(): Promise<Cred> {
      const cred = await readOwn();
      if (!cred) {
        throw new Error("workbuddy: 未登录。运行 /login workbuddy 或 /workbuddy 菜单连接");
      }
      if (cred.expiresAtMs > 0 && Date.now() + REFRESH_MARGIN_MS < cred.expiresAtMs) return cred;
      if (cred.refreshToken === "") {
        if (cred.expiresAtMs > Date.now() + 30_000) return cred;
        throw new Error("workbuddy: access token 已过期；运行 /login workbuddy 重新授权");
      }
      inflight ??= (async () => {
        try {
          const next = await refreshAccess(cred);
          await saveOwn(next);
          return next;
        } catch (error) {
          if (cred.expiresAtMs > Date.now() + 30_000) return cred;
          throw error;
        }
      })().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },

    /** 设备授权登录：拿 authUrl 弹给用户，轮询换取并落盘凭据。 */
    async login(callbacks: LoginCallbacks): Promise<OAuthCredentials> {
      callbacks.onProgress?.("正在打开 WorkBuddy 登录页…");
      const { state, authUrl } = await startPluginLogin();
      callbacks.onAuth({ url: authUrl });
      callbacks.onProgress?.("请在浏览器完成登录，完成后自动继续");
      const cred = await pollPluginToken(state);
      await saveOwn(cred);
      return { access: cred.accessToken, refresh: cred.refreshToken, expires: cred.expiresAtMs };
    },

    async refreshOAuth(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      const prev = await readOwn();
      const next = await refreshAccess({
        accessToken: credentials.access,
        refreshToken: credentials.refresh,
        expiresAtMs: credentials.expires ?? 0,
        domain: prev?.domain ?? "",
        uid: prev?.uid ?? "",
        ...(prev?.enterpriseId ? { enterpriseId: prev.enterpriseId } : {}),
        ...(prev?.nickname ? { nickname: prev.nickname } : {}),
      });
      await saveOwn(next);
      return { access: next.accessToken, refresh: next.refreshToken, expires: next.expiresAtMs };
    },

    async logout(): Promise<void> {
      inflight = undefined;
      await unlink(ownPath(dir)).catch(() => undefined);
    },
  };
}
