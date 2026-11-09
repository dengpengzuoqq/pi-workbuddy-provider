import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPiModels,
  creditsAreFree,
  fetchCloudProductConfig,
  loadProductConfigLive,
  parseProductConfig,
  type Http,
} from "../extensions/models.ts";

// Fixture written from the real domestic cache at ~/.workbuddy/cache/acc-product-config-v3.json
// (values observed 2026-11-07): list-effort model, fixed-effort model, and an
// internal completion model without a context window that must not register.
const CACHE_FIXTURE = JSON.stringify({
  endpoint: "https://www.workbuddy.cn",
  agents: [
    { name: "general-purpose", tools: ["Read"] },
    { name: "cli", tags: ["cli", "default", "model:craft"], models: ["auto", "fast-model", "deepseek-v4-flash", "hy3"] },
  ],
  models: [
    {
      id: "auto",
      name: "Auto",
      maxInputTokens: 168000,
      maxOutputTokens: 32000,
      supportsImages: true,
    },
    {
      id: "hy3-x",
      name: "Hy3",
      credits: "x0.05 credits",
      maxInputTokens: 192000,
      maxOutputTokens: 64000,
      supportsImages: true,
      supportsReasoning: true,
      reasoning: { canDisableThinking: false, defaultEffort: "high", summary: "auto", supportedEfforts: ["low", "high"] },
    },
    {
      id: "hy3",
      name: "Hy3",
      credits: "x0.00 credits",
      maxInputTokens: 192000,
      maxOutputTokens: 64000,
      contextWindow: { defaultLength: 96000, supportedLengths: [96000, 192000, 4000000] },
      supportsImages: true,
      supportsReasoning: true,
      supportsToolCall: true,
      reasoning: { canDisableThinking: false, defaultEffort: "high", summary: "auto", supportedEfforts: ["low", "high"] },
    },
    {
      id: "not-in-agent",
      name: "Ghost",
      credits: "x1.00",
      maxInputTokens: 100000,
      maxOutputTokens: 10000,
    },
    {
      id: "hy3-b",
      name: "Hy3",
      credits: "x0.00 credits",
      maxInputTokens: 192000,
      maxOutputTokens: 64000,
      supportsImages: true,
      supportsReasoning: true,
      reasoning: { canDisableThinking: false, defaultEffort: "high", summary: "auto", supportedEfforts: ["low", "high"] },
    },
    {
      id: "fast-model",
      name: "快速",
      credits: "x0.15 credits",
      maxInputTokens: 300000,
      maxOutputTokens: 48000,
      supportsImages: true,
      supportsReasoning: true,
      supportsToolCall: true,
      onlyReasoning: true,
      reasoning: { effort: "medium", summary: "auto" },
    },
    {
      id: "codewise-completions",
      name: "codewise-completions",
      maxOutputTokens: 256,
    },
    {
      id: "deepseek-v4-flash",
      name: "Deepseek-V4-Flash",
      credits: "x0.06 credits",
      maxInputTokens: 1000000,
      maxOutputTokens: 50000,
      supportsImages: true,
      supportsReasoning: true,
      reasoning: { canDisableThinking: true, defaultEffort: "high", summary: "auto", supportedEfforts: ["low", "high", "max"] },
    },
  ],
});

describe("parseProductConfig", () => {
  it("parses the domestic cache schema into product models", () => {
    const config = parseProductConfig(CACHE_FIXTURE);
    assert.ok(config);
    assert.equal(config.source, "cache");
    const hy3 = config.models.find((m) => m.id === "hy3");
    assert.ok(hy3);
    assert.equal(hy3.name, "Hy3");
    assert.equal(hy3.credits, "x0.00 credits", "credits kept verbatim; display strips the suffix");
    assert.equal(hy3.contextWindow, 192000);
    assert.equal(hy3.maxTokens, 64000);
    assert.equal(hy3.supportsImages, true);
    assert.equal(hy3.canDisableThinking, false);
    assert.deepEqual(hy3.windowOptions, {
      supported: [96000, 192000],
    }, "tiers sorted and capped at maxInputTokens (4M dropped)");
    const fast = config.models.find((m) => m.id === "fast-model");
    assert.equal(fast?.windowOptions, undefined, "no contextWindow object -> no tiers");
    assert.deepEqual(hy3.reasoning, { kind: "list", efforts: ["low", "high"] });
    assert.ok(fast);
    assert.equal(fast.canDisableThinking, false, "onlyReasoning blocks disabling thinking");
    assert.deepEqual(fast.reasoning, { kind: "fixed", effort: "medium" });
  });

  it("returns undefined for garbage", () => {
    assert.equal(parseProductConfig("not json"), undefined);
    assert.equal(parseProductConfig("{}"), undefined);
  });
});

describe("buildPiModels", () => {
  const config = parseProductConfig(CACHE_FIXTURE)!;

  it("registers only chat-class models (with a context window)", () => {
    const models = buildPiModels(config, "all");
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("hy3"));
    assert.ok(ids.includes("fast-model"));
    assert.ok(!ids.includes("codewise-completions"), "completion model has no context window");
  });

  it("registers exactly the cli agent allowlist, in its order", () => {
    const models = buildPiModels(config, "all");
    assert.deepEqual(models.map((m) => m.id), ["auto", "fast-model", "deepseek-v4-flash", "hy3"]);
    assert.ok(!ids_of(models).includes("hy3-b"), "replica not in allowlist is not registered");
    assert.ok(!ids_of(models).includes("not-in-agent"), "catalog-only model without allowlist entry is not registered");
  });

  it("falls back to the full catalog when no cli agent allowlist exists", () => {
    const base = JSON.parse(CACHE_FIXTURE) as Record<string, unknown>;
    delete base.agents;
    const noAgents = parseProductConfig(JSON.stringify(base));
    assert.ok(noAgents);
    const ids = ids_of(buildPiModels(noAgents, "all"));
    assert.ok(ids.includes("not-in-agent"), "without allowlist every chat-class model registers");
    assert.ok(!ids.includes("hy3-b"), "replica dedupe still applies in the fallback");
  });

  it("dedupes same-name replica SKUs, preferring the free one over catalog order", () => {
    const models = buildPiModels(config, "all");
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("hy3"), "free SKU wins even when the paid replica comes first");
    assert.ok(!ids.includes("hy3-b"), "same-name free replica hidden");
    assert.ok(!ids.includes("hy3-x"), "same-name paid replica hidden");
    const hy3Count = models.filter((m) => m.name.startsWith("Hy3")).length;
    assert.equal(hy3Count, 1);
  });

  it("scopes free models by credits", () => {
    const free = buildPiModels(config, "free").map((m) => m.id);
    assert.deepEqual(free, ["hy3"]);
  });

  it("strips the ' credits' suffix from the display name", () => {
    const hy3 = buildPiModels(config, "all").find((m) => m.id === "hy3")!;
    assert.equal(hy3.name, "Hy3 · x0.00");
    const flash = buildPiModels(config, "all").find((m) => m.id === "deepseek-v4-flash")!;
    assert.equal(flash.name, "Deepseek-V4-Flash · x0.06");
  });

  it("caps deepseek-v4.1-flash max tokens to stop reasoning loops", () => {
    const legacy = parseProductConfig(JSON.stringify({
      models: [{
        id: "deepseek-v4.1-flash",
        name: "DeepSeek-V4.1-Flash",
        credits: "x0.11 credits",
        maxInputTokens: 1000000,
        maxOutputTokens: 128000,
        supportsReasoning: true,
      }],
    }))!;
    const flash = buildPiModels(legacy, "all").find((m) => m.id === "deepseek-v4.1-flash")!;
    assert.ok(flash);
    assert.equal(flash.maxTokens, 16384);
    assert.equal(flash.contextWindow, 1000000);
  });

  it("maps list efforts and keeps thinking disabled per canDisableThinking", () => {
    const hy3 = buildPiModels(config, "all").find((m) => m.id === "hy3")!;
    assert.equal(hy3.reasoning, true);
    assert.equal(hy3.thinkingLevelMap.low, "low");
    assert.equal(hy3.thinkingLevelMap.medium, null);
    assert.equal(hy3.thinkingLevelMap.high, "high");
    assert.equal(hy3.thinkingLevelMap.off, null);

    const flash = buildPiModels(config, "all").find((m) => m.id === "deepseek-v4-flash")!;
    assert.equal(flash.thinkingLevelMap.off, "off", "canDisableThinking allows off");
    assert.equal(flash.thinkingLevelMap.xhigh, null);
  });

  it("passes fixed-effort levels straight through", () => {
    const fast = buildPiModels(config, "all").find((m) => m.id === "fast-model")!;
    assert.equal(fast.thinkingLevelMap.off, null, "onlyReasoning forbids off");
    assert.equal(fast.thinkingLevelMap.low, "low");
    assert.equal(fast.thinkingLevelMap.high, "high");
    assert.equal(fast.thinkingLevelMap.max, "max");
  });
});

describe("creditsAreFree", () => {
  it("accepts x0.00 style, bare zero, and the ' credits' suffix format", () => {
    assert.equal(creditsAreFree("x0.00"), true);
    assert.equal(creditsAreFree("0"), true);
    assert.equal(creditsAreFree("x0"), true);
    assert.equal(creditsAreFree("x0.00 credits"), true, "2026-11 refreshed cache format");
    assert.equal(creditsAreFree("0 credits"), true);
    assert.equal(creditsAreFree("x0.15"), false);
    assert.equal(creditsAreFree("x0.16 credits"), false);
    assert.equal(creditsAreFree(undefined), false);
    assert.equal(creditsAreFree(""), false);
  });
});

// /v3/config 实测响应形状（2026-11-07 下午）：干净计价、models 在 data 下。
const CLOUD_ENVELOPE = JSON.stringify({
  code: 0,
  msg: "success",
  data: {
    endpoint: "https://www.workbuddy.cn",
    models: [
      {
        id: "hy4free",
        name: "Hy4",
        credits: "x0.00",
        maxInputTokens: 960000,
        maxOutputTokens: 64000,
        supportsImages: true,
        supportsReasoning: true,
        reasoning: { canDisableThinking: false, defaultEffort: "high", summary: "auto", supportedEfforts: ["high"] },
      },
      { id: "fast-model", name: "快速", credits: "x0.15", maxInputTokens: 300000, maxOutputTokens: 48000 },
    ],
  },
});

function fakeHttpOf(body: unknown, ok = true): Http {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as Http;
}

describe("fetchCloudProductConfig", () => {
  const cred = {
    accessToken: "a",
    refreshToken: "r",
    expiresAtMs: 0,
    domain: "www.workbuddy.cn",
    uid: "u1",
  };

  it("parses the live roster from v3/config", async () => {
    let requested = "";
    const http = (async (url: string | URL) => {
      requested = String(url);
      return { ok: true, status: 200, json: async () => JSON.parse(CLOUD_ENVELOPE) };
    }) as unknown as Http;
    const config = await fetchCloudProductConfig(cred, { http, baseUrl: "https://www.workbuddy.cn" });
    assert.equal(requested, "https://www.workbuddy.cn/v3/config");
    assert.equal(config.source, "cloud");
    const hy4 = buildPiModels(config, "free").find((m) => m.id === "hy4free");
    assert.ok(hy4, "live roster includes hy4free");
    assert.equal(hy4.name, "Hy4 · x0.00");
  });

  it("throws on an error envelope so the caller can fall back", async () => {
    await assert.rejects(
      () => fetchCloudProductConfig(cred, { http: fakeHttpOf({ code: 1, msg: "no" }, false) }),
      /no|v3\/config/,
    );
  });
});

describe("loadProductConfigLive", () => {
  const cred = {
    accessToken: "a",
    refreshToken: "r",
    expiresAtMs: 0,
    domain: "www.workbuddy.cn",
    uid: "u1",
  };
  const cachePath = "/tmp/pi-workbuddy-plugin-test-cache.json";

  it("prefers the cloud roster when a credential exists", async () => {
    const config = await loadProductConfigLive(cred, {
      http: fakeHttpOf(JSON.parse(CLOUD_ENVELOPE)),
      baseUrl: "https://www.workbuddy.cn",
      cachePath,
    });
    assert.equal(config.source, "cloud");
  });

  it("falls back to the cache file when the cloud fetch fails", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(cachePath, CACHE_FIXTURE);
    const config = await loadProductConfigLive(cred, {
      http: fakeHttpOf({ code: 500 }, false),
      baseUrl: "https://www.workbuddy.cn",
      cachePath,
    });
    assert.equal(config.source, "cache");
  });

  it("uses the cache file without a credential and never touches the network", async () => {
    let called = 0;
    const http = (async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => JSON.parse(CLOUD_ENVELOPE) };
    }) as unknown as Http;
    const config = await loadProductConfigLive(undefined, { http, cachePath });
    assert.equal(called, 0);
    assert.equal(config.source, "cache");
  });
});

function ids_of(models: { id: string }[]): string[] {
  return models.map((m) => m.id);
}

describe("buildPiModels context window budget", () => {
  const config = parseProductConfig(CACHE_FIXTURE)!;

  it("defaults to the highest tier", () => {
    const hy3 = buildPiModels(config, "all").find((m) => m.id === "hy3")!;
    assert.equal(hy3.contextWindow, 192000);
  });

  it("clamps to a valid override tier", () => {
    const hy3 = buildPiModels(config, "all", { hy3: 96000 }).find((m) => m.id === "hy3")!;
    assert.equal(hy3.contextWindow, 96000);
  });

  it("ignores an override outside supportedLengths", () => {
    const hy3 = buildPiModels(config, "all", { hy3: 500000 }).find((m) => m.id === "hy3")!;
    assert.equal(hy3.contextWindow, 192000);
  });

  it("uses maxInputTokens for models without tiers", () => {
    const fast = buildPiModels(config, "all").find((m) => m.id === "fast-model")!;
    assert.equal(fast.contextWindow, 300000, "fast-model maxInputTokens = 300000");
  });
});
