import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  chatHeaders,
  createAuth,
  credFromPluginToken,
  parseOwn,
  type Cred,
  type Http,
} from "../extensions/auth.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "wb-auth-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fake fetch returning queued JSON envelopes; records calls for single-flight checks. */
function fakeHttp(responses: Array<{ status?: number; body: unknown }>): { http: Http; calls: number } {
  let calls = 0;
  const http = (async () => ({
    ok: true,
    status: 200,
    json: async () => {
      const next = responses[Math.min(calls, responses.length - 1)]!;
      calls += 1;
      return next.body;
    },
  })) as unknown as Http;
  return {
    http,
    get calls() {
      return calls;
    },
  };
}

const FRESH: Cred = {
  accessToken: "a",
  refreshToken: "r",
  expiresAtMs: Date.now() + 60 * 60 * 1000,
  domain: "www.workbuddy.cn",
  uid: "u1",
};

afterEach(() => {
  delete process.env.WORKBUDDY_BASE_URL;
});

describe("parseOwn", () => {
  it("parses the own-store envelope", () => {
    const cred = parseOwn(JSON.stringify({
      version: 1,
      credential: { accessToken: "a", refreshToken: "r", expiresAtMs: 123, domain: "d", uid: "u", nickname: "n" },
    }));
    assert.ok(cred);
    assert.equal(cred.accessToken, "a");
    assert.equal(cred.nickname, "n");
  });

  it("rejects unknown versions and empty tokens", () => {
    assert.equal(parseOwn(JSON.stringify({ version: 2, credential: { accessToken: "a" } })), undefined);
    assert.equal(parseOwn(JSON.stringify({ version: 1, credential: { refreshToken: "r" } })), undefined);
    assert.equal(parseOwn("not json"), undefined);
  });
});

describe("credFromPluginToken", () => {
  it("derives identity from data fields, falling back to JWT claims", () => {
    const jwt = Buffer.from(JSON.stringify({ sub: "u9", email: "a@b.c" })).toString("base64url");
    const cred = credFromPluginToken(
      { refreshToken: "r", expiresIn: 10, domain: "www.workbuddy.cn" },
      `x.${jwt}.y`,
      1000,
    );
    assert.equal(cred.uid, "u9");
    assert.equal(cred.nickname, "a@b.c");
    assert.equal(cred.expiresAtMs, 11000);
    assert.equal(cred.domain, "www.workbuddy.cn");
  });

  it("prefers the JWT nickname claim over email for display", () => {
    const jwt = Buffer.from(JSON.stringify({
      sub: "u9",
      email: "a@b.c",
      nickname: "张三",
      preferred_username: "zhangsan",
    })).toString("base64url");
    const cred = credFromPluginToken({ refreshToken: "r", expiresIn: 10 }, `x.${jwt}.y`, 1000);
    assert.equal(cred.nickname, "张三");
  });

  it("defaults the domain to the domestic endpoint", () => {
    const cred = credFromPluginToken({ refreshToken: "r", expiresIn: 5 }, "tok", 0);
    assert.equal(cred.domain, "www.workbuddy.cn");
  });

  it("normalizes expiry: domestic expiresIn is an absolute epoch-ms timestamp", () => {
    const absoluteMs = Date.UTC(2026, 11, 7, 0, 0, 0);
    const cred = credFromPluginToken({ refreshToken: "r", expiresIn: absoluteMs }, "tok", 1000);
    assert.equal(cred.expiresAtMs, absoluteMs);
  });

  it("normalizes expiry: relative seconds and absolute expiresAt both work", () => {
    const relativeSeconds = credFromPluginToken({ refreshToken: "r", expiresIn: 30 }, "tok", 1000);
    assert.equal(relativeSeconds.expiresAtMs, 31000);
    const absoluteSeconds = credFromPluginToken({ refreshToken: "r", expiresAt: 5000 }, "tok", 1000);
    assert.equal(absoluteSeconds.expiresAtMs, 5_000_000);
  });
});

describe("createAuth resolve", () => {
  it("returns the stored credential without network when fresh", async () => {
    await withTempDir(async (dir) => {
      const fake = fakeHttp([{ body: { code: 1 } }]);
      const auth = createAuth({ dir, http: fake.http, pollIntervalMs: 1 });
      await writeFile(
        join(dir, ".workbuddy-auth.json"),
        JSON.stringify({ version: 1, credential: FRESH }),
      );
      const cred = await auth.resolve();
      assert.equal(cred.accessToken, "a");
      assert.equal(fake.calls, 0);
    });
  });

  it("refreshes when within the margin, single-flight, and saves the result", async () => {
    await withTempDir(async (dir) => {
      const expiring = { ...FRESH, expiresAtMs: Date.now() + 60 * 1000 };
      const fake = fakeHttp([{
        body: { code: 0, data: { accessToken: "a2", refreshToken: "r2", expiresIn: 3600, domain: "www.workbuddy.cn" } },
      }]);
      const auth = createAuth({ dir, http: fake.http, pollIntervalMs: 1 });
      await writeFile(
        join(dir, ".workbuddy-auth.json"),
        JSON.stringify({ version: 1, credential: expiring }),
      );
      const [c1, c2] = await Promise.all([auth.resolve(), auth.resolve()]);
      assert.equal(c1.accessToken, "a2");
      assert.equal(c2.accessToken, "a2");
      assert.equal(fake.calls, 1, "concurrent resolves share one refresh");
      const stored = parseOwn(await readFile(join(dir, ".workbuddy-auth.json"), "utf8"));
      assert.equal(stored?.refreshToken, "r2");
    });
  });

  it("keeps the old credential when refresh fails but the token is still valid", async () => {
    await withTempDir(async (dir) => {
      const stillValid = { ...FRESH, expiresAtMs: Date.now() + 60 * 1000 };
      const failing = (async () => ({ ok: false, status: 500, json: async () => ({ code: 1, msg: "boom" }) })) as unknown as Http;
      const auth = createAuth({ dir, http: failing, pollIntervalMs: 1 });
      await writeFile(
        join(dir, ".workbuddy-auth.json"),
        JSON.stringify({ version: 1, credential: stillValid }),
      );
      const cred = await auth.resolve();
      assert.equal(cred.accessToken, "a");
    });
  });

  it("throws a login hint when no credential exists", async () => {
    await withTempDir(async (dir) => {
      const auth = createAuth({ dir, http: fakeHttp([]).http, pollIntervalMs: 1 });
      await assert.rejects(() => auth.resolve(), /\/login workbuddy/);
    });
  });
});

describe("createAuth login", () => {
  it("keeps polling when the token endpoint long-polls past the request timeout", async () => {
    await withTempDir(async (dir) => {
      let calls = 0;
      const longPolling: Http = (async () => {
        calls += 1;
        if (calls === 1) {
          return { ok: true, status: 200, json: async () => ({ code: 0, data: { state: "s1", authUrl: "https://www.workbuddy.cn/login?state=s1" } }) };
        }
        if (calls === 2) {
          // 模拟服务端长轮询超过客户端请求超时：fetch 以 TimeoutError 中断。
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        if (calls === 3) return { ok: true, status: 200, json: async () => ({ code: 11217 }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 0, data: { accessToken: "at", refreshToken: "rt", expiresIn: 60, uid: "u1" } }),
        };
      }) as unknown as Http;
      const auth = createAuth({ dir, http: longPolling, pollIntervalMs: 1 });
      const oauth = await auth.login({ onAuth: () => undefined });
      assert.equal(oauth.access, "at");
      assert.ok(calls >= 4);
    });
  });

  it("starts the device flow, calls onAuth, polls, and stores the credential", async () => {
    await withTempDir(async (dir) => {
      const fake = fakeHttp([
        { body: { code: 0, data: { state: "s1", authUrl: "https://www.workbuddy.cn/login?state=s1" } } },
        { body: { code: 11217 } },
        {
          body: {
            code: 0,
            data: { accessToken: "at", refreshToken: "rt", expiresIn: 60, uid: "u1", nickname: "nick" },
          },
        },
      ]);
      const auth = createAuth({ dir, http: fake.http, pollIntervalMs: 1 });
      const urls: string[] = [];
      const oauth = await auth.login({ onAuth: (u) => urls.push(u.url) });
      assert.equal(oauth.access, "at");
      assert.ok(urls[0]);
      assert.equal(urls[0], "https://www.workbuddy.cn/login?state=s1");
      assert.ok(fake.calls >= 3, "polled until the token arrived");
      const stored = parseOwn(await readFile(join(dir, ".workbuddy-auth.json"), "utf8"));
      assert.equal(stored?.uid, "u1");
      await auth.logout();
      await assert.rejects(() => readFile(join(dir, ".workbuddy-auth.json"), "utf8"));
    });
  });
});

describe("chatHeaders", () => {
  it("carries bearer auth, user id, product and desktop-shaped UA", () => {
    const headers = chatHeaders(FRESH);
    assert.equal(headers.Authorization, "Bearer a");
    assert.equal(headers["X-User-Id"], "u1");
    assert.equal(headers["X-Product"], "SaaS");
    assert.match(headers["User-Agent"] ?? "", /CLI\//);
    const anonymous = chatHeaders({ ...FRESH, uid: "", domain: "" });
    assert.equal(anonymous["X-No-User-Id"], "1");
    assert.equal(anonymous["X-No-Department-Info"], "1");
  });
});
