import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusLine, widgetLines } from "../extensions/ui.ts";
import type { Cred } from "../extensions/auth.ts";

const CRED: Cred = {
  accessToken: "a",
  refreshToken: "r",
  expiresAtMs: Date.UTC(2027, 0, 2, 3, 4, 5),
  domain: "www.workbuddy.cn",
  uid: "u1",
  nickname: "张三",
};

describe("widgetLines", () => {
  it("shows a login hint when signed out", () => {
    const lines = widgetLines({ scope: "all", models: [] });
    assert.ok(lines.some((l) => l.includes("/login workbuddy")));
    assert.ok(lines.some((l) => l.includes("全部模型")));
  });

  it("stays within pi's 10-line widget budget", () => {
    const lines = widgetLines({
      cred: CRED,
      credits: {
        total: 1124.45,
        packs: [
          { name: "套餐基础积分", remain: 500, size: 500 },
          { name: "套餐赠送积分", remain: 0, size: 0 },
          { name: "购买积分", remain: 0, size: 0 },
          { name: "平台奖励积分", remain: 624.45, size: 6600 },
        ],
      },
      scope: "free",
      models: Array.from({ length: 46 }, (_, i) => ({ name: `M${i} · x0.1` })),
    });
    assert.ok(lines.length <= 9, `widget must fit pi's 10-line limit, got ${lines.length}`);
  });

  it("compacts credits: total/remain order, skips empty packs, drops bars", () => {
    const lines = widgetLines({
      cred: CRED,
      credits: {
        total: 1124.45,
        packs: [
          { name: "套餐基础积分", remain: 500, size: 500 },
          { name: "套餐赠送积分", remain: 0, size: 0 },
          { name: "购买积分", remain: 0, size: 0 },
          { name: "平台奖励积分", remain: 624.45, size: 6600 },
        ],
      },
      scope: "all",
      models: [],
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("1124.45"));
    assert.ok(joined.includes("基础积分 500/500"), "套餐 prefix stripped, size/remain order");
    assert.ok(joined.includes("奖励积分 6600/624.45"), "size before remain");
    assert.ok(!joined.includes("赠送积分"), "zero packs are skipped");
    assert.ok(!joined.includes("购买积分"), "zero packs are skipped");
    assert.ok(!joined.includes("█"), "no bar lines");
  });

  it("caps the model line: dedupes display names, shows first few plus count", () => {
    const lines = widgetLines({
      cred: CRED,
      scope: "all",
      models: [
        { name: "Hy3 · x0.00" },
        { name: "Hy3 · x0.00" },
        { name: "Hy4 · x0.00" },
        { name: "GLM-5.3 · x0.69" },
        { name: "Kimi-K3 · x1.62" },
      ],
    });
    const modelLine = lines.find((l) => l.startsWith("模型"))!;
    assert.ok(modelLine.includes("Hy3"));
    assert.ok(modelLine.includes("Hy4"));
    assert.ok(modelLine.includes("5"), "total count shown");
    assert.ok(!modelLine.includes("Kimi"), "beyond the first few only the count remains");
  });

  it("shows account, token expiry and credits when signed in", () => {
    const lines = widgetLines({
      cred: CRED,
      credits: { total: 1200, packs: [{ name: "p_std", remain: 700, size: 1000 }] },
      scope: "all",
      models: [{ name: "Hy3 · x0.00" }],
    });
    assert.ok(lines.some((l) => l.includes("张三")));
    assert.ok(lines.some((l) => l.includes("2027/1/2")));
    assert.ok(lines.some((l) => l.includes("合计 1200")));
    assert.ok(lines.some((l) => l.includes("p_std 1000/700")));
  });

  it("degrades to account status when credits are unavailable", () => {
    const lines = widgetLines({ cred: CRED, error: "credits 404", scope: "all", models: [] });
    assert.ok(lines.some((l) => l.includes("张三")));
    assert.ok(lines.some((l) => l.includes("credits 404")));
  });
});

describe("statusLine", () => {
  const CRED2: Cred = { ...CRED };

  it("always carries the balance on the status row (simple mode has no widget line)", () => {
    assert.equal(statusLine({ total: 1124.45, packs: [] }, CRED2), "积分 1124.45");
    assert.equal(statusLine(undefined, CRED2), "WorkBuddy 已登录");
    assert.equal(statusLine(undefined, undefined), "WorkBuddy 未登录");
  });
});
