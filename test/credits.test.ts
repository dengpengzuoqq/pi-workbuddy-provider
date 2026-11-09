import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchCredits, parseCredits, parseResourceSummary } from "../extensions/credits.ts";
import type { Http } from "../extensions/auth.ts";

// Fixture written from the real domestic response (observed 2026-11-07):
// string decimal capacities, grouped credits with display names, aggregate TotalCredits.
const SUMMARY_ENVELOPE = {
  code: 0,
  msg: "success",
  data: {
    Packages: [
      { PackageCode: "TCACA_code_007", CycleTotalCapacity: "500", CycleRemainCapacity: "500", CycleUsedCapacity: "0" },
      { PackageCode: "TCACA_code_008", CycleTotalCapacity: "6600", CycleRemainCapacity: "625.25000193", CycleUsedCapacity: "5974.75" },
    ],
    CreditGroups: [
      { Kind: "plan_base", Name: "套餐基础积分", CycleTotalCapacity: "500", CycleRemainCapacity: "500", CycleUsedCapacity: "0" },
      { Kind: "benefit", Name: "平台奖励积分", CycleTotalCapacity: "6600", CycleRemainCapacity: "625.25000193", CycleUsedCapacity: "5974.75" },
    ],
    TotalCredits: "1125.25000193",
    SubscriptionPackageCode: "",
    IsPaidUser: false,
  },
};

function fakeHttp(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }): Http {
  return (async (url: string | URL | Request, init?: RequestInit) => ({
    ok: true,
    status: 200,
    url: String(url),
    json: async () => handler(String(url), init).body,
  })) as unknown as Http;
}

describe("parseResourceSummary", () => {
  it("parses grouped credits with string decimal capacities and prefers TotalCredits", () => {
    const credits = parseResourceSummary(SUMMARY_ENVELOPE);
    assert.equal(credits.total, 1125.25);
    assert.deepEqual(
      credits.packs.map((p) => ({ name: p.name, remain: p.remain, size: p.size })),
      [
        { name: "套餐基础积分", remain: 500, size: 500 },
        { name: "平台奖励积分", remain: 625.25, size: 6600 },
      ],
    );
  });

  it("falls back to Packages and their sum when CreditGroups is absent", () => {
    const credits = parseResourceSummary({
      code: 0,
      data: {
        Packages: [
          { PackageCode: "TCACA_x", CycleTotalCapacity: "1000", CycleRemainCapacity: "700.5" },
          { PackageCode: "TCACA_y", CycleTotalCapacity: "500", CycleRemainCapacity: "499.5" },
        ],
      },
    });
    assert.equal(credits.total, 1200);
    assert.deepEqual(credits.packs.map((p) => p.name), ["TCACA_x", "TCACA_y"]);
  });

  it("tolerates missing fields", () => {
    const credits = parseResourceSummary({ code: 0, data: {} });
    assert.equal(credits.total, 0);
    assert.deepEqual(credits.packs, []);
  });
});

describe("parseCredits", () => {
  it("parses the legacy billing envelope (international fallback shape)", () => {
    const credits = parseCredits({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [{ PackageName: "Bonus", CycleCapacitySize: 250, CycleCapacityRemain: 249 }],
          },
        },
      },
    });
    assert.equal(credits.total, 249);
    assert.equal(credits.packs.length, 1);
  });
});

describe("fetchCredits", () => {
  const cred = {
    accessToken: "a",
    refreshToken: "r",
    expiresAtMs: 0,
    domain: "www.workbuddy.cn",
    uid: "u1",
  };

  it("prefers the unprefixed domestic summary endpoint", async () => {
    let requested = "";
    const http = fakeHttp((url) => {
      requested = url;
      return { body: SUMMARY_ENVELOPE };
    });
    const credits = await fetchCredits(cred, { http, baseUrl: "https://www.workbuddy.cn" });
    assert.equal(requested, "https://www.workbuddy.cn/billing/meter/get-user-resource-summary");
    assert.equal(credits.total, 1125.25);
  });

  it("falls back to the legacy /v2 billing endpoint when summary fails", async () => {
    const urls: string[] = [];
    const http = fakeHttp((url) => {
      urls.push(url);
      if (urls.length === 1) return { status: 404, body: { code: 404 } };
      return {
        body: {
          code: 0,
          data: { Response: { Data: { Accounts: [{ PackageName: "P", CycleCapacityRemain: 42 }] } } },
        },
      };
    });
    const credits = await fetchCredits(cred, { http, baseUrl: "https://www.workbuddy.cn" });
    assert.deepEqual(urls, [
      "https://www.workbuddy.cn/billing/meter/get-user-resource-summary",
      "https://www.workbuddy.cn/v2/billing/meter/get-user-resource",
    ]);
    assert.equal(credits.total, 42);
  });

  it("throws when both endpoints fail", async () => {
    const http = fakeHttp(() => ({ status: 500, body: { code: 500, msg: "boom" } }));
    await assert.rejects(
      () => fetchCredits(cred, { http, baseUrl: "https://www.workbuddy.cn" }),
      /boom|credits/,
    );
  });
});
