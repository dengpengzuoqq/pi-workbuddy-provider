import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareChatPayload } from "../extensions/transform.ts";

describe("prepareChatPayload", () => {
  it("forces streaming and rewrites developer role to system", () => {
    const payload = prepareChatPayload({
      model: "hy3",
      messages: [
        { role: "developer", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
    assert.equal(payload.stream, true);
    const messages = payload.messages as { role: string }[];
    assert.equal(messages[0]!.role, "system");
    assert.equal(messages[1]!.role, "user");
  });

  it("prepends a system message when the first message is not system", () => {
    const payload = prepareChatPayload({ model: "hy3", messages: [{ role: "user", content: "hi" }] });
    const messages = payload.messages as { role: string }[];
    assert.equal(messages[0]!.role, "system");
  });

  it("strips reasoning replay from assistant messages", () => {
    const payload = prepareChatPayload({
      model: "hy3",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "done" },
          ],
          reasoning: "OK.",
          reasoning_content: "Go.",
        },
      ],
    });
    const assistant = (payload.messages as Record<string, unknown>[])[2]!;
    assert.equal(assistant.reasoning, undefined);
    assert.equal(assistant.reasoning_content, undefined);
    const content = assistant.content as { type: string }[];
    assert.deepEqual(content.map((part) => part.type), ["text"]);
  });

  it("normalizes tool_choice: none drops tools, function flattens to name", () => {
    const none = prepareChatPayload({
      model: "hy3",
      tool_choice: { type: "none" },
      tools: [{ type: "function", function: { name: "f" } }],
      messages: [],
    });
    assert.equal(none.tool_choice, undefined);
    assert.equal(none.tools, undefined);

    const fn = prepareChatPayload({
      model: "hy3",
      tool_choice: { type: "function", function: { name: "foo" } },
      messages: [],
    });
    assert.equal(fn.tool_choice, "foo");
  });

  it("deletes unrecognized tool_choice forms per the agreed contract", () => {
    const legacyString = prepareChatPayload({ model: "hy3", tool_choice: "any", messages: [] });
    assert.equal(legacyString.tool_choice, undefined);

    const nameless = prepareChatPayload({
      model: "hy3",
      tool_choice: { type: "function", function: {} },
      messages: [],
    });
    assert.equal(nameless.tool_choice, undefined);

    const garbage = prepareChatPayload({ model: "hy3", tool_choice: 42, messages: [] });
    assert.equal(garbage.tool_choice, undefined);

    const auto = prepareChatPayload({ model: "hy3", tool_choice: "AUTO", messages: [] });
    assert.equal(auto.tool_choice, "AUTO", "auto/required keep their casing");
  });

  it("never injects reasoning_effort but preserves an explicit one", () => {
    const bare = prepareChatPayload({ model: "hy3", messages: [] });
    assert.equal(bare.reasoning_effort, undefined);

    const explicit = prepareChatPayload({ model: "hy3", messages: [], reasoning_effort: "max" });
    assert.equal(explicit.reasoning_effort, "max");
  });

  it("mirrors the desktop CLI: adds reasoning_summary auto when an effort is sent", () => {
    const injected = prepareChatPayload({ model: "hy3", messages: [], reasoning_effort: "high" });
    assert.equal(injected.reasoning_summary, "auto");

    const objectStyle = prepareChatPayload({
      model: "hy3",
      messages: [],
      reasoning: { effort: "medium" },
    });
    assert.equal(objectStyle.reasoning_summary, "auto");

    const kept = prepareChatPayload({
      model: "hy3",
      messages: [],
      reasoning_effort: "high",
      reasoning_summary: "concise",
    });
    assert.equal(kept.reasoning_summary, "concise", "explicit summary wins");

    const noEffort = prepareChatPayload({ model: "hy3", messages: [] });
    assert.equal(noEffort.reasoning_summary, undefined, "Default stays Default");
  });

  it("caps deepseek-v4.1-flash max_tokens in the payload", () => {
    const payload = prepareChatPayload({
      model: "deepseek-v4.1-flash",
      messages: [],
      max_tokens: 128000,
    });
    assert.equal(payload.max_tokens, 16384);
  });
});
