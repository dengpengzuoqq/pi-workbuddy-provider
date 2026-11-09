// transform.ts — WorkBuddy 国内版 chat 请求体变换：对齐桌面端 CLI 的上游契约。
import { FLASH_MAX_TOKENS } from "./models.ts";

/** 桌面端 injectReasoningSummaryIfNeeded 的镜像：effort 存在且未指定 summary 时补 "auto"。 */
function injectReasoningSummary(payload: Record<string, unknown>): void {
  const reasoning = typeof payload.reasoning === "object" && payload.reasoning !== null && !Array.isArray(payload.reasoning)
    ? payload.reasoning as Record<string, unknown>
    : undefined;
  const hasEffort = typeof payload.reasoning_effort === "string"
    || typeof reasoning?.effort === "string";
  if (hasEffort && payload.reasoning_summary === undefined) {
    payload.reasoning_summary = "auto";
  }
}

function stripAssistantReasoning(messages: unknown[]): void {
  for (const item of messages) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const msg = item as Record<string, unknown>;
    if (msg.role !== "assistant") continue;
    delete msg.reasoning;
    delete msg.thinking;
    delete msg.reasoning_content;
    if (!Array.isArray(msg.content)) continue;
    const content = msg.content.filter((part) => {
      if (typeof part !== "object" || part === null) return true;
      const type = (part as { type?: string }).type;
      return type !== "reasoning" && type !== "thinking";
    });
    msg.content = content.length === 0 ? "" : content;
  }
}

function normalizeToolChoice(payload: Record<string, unknown>): void {
  if (!("tool_choice" in payload)) return;
  const choice = payload.tool_choice;
  if (typeof choice === "string") {
    const normalized = choice.trim().toLowerCase();
    if (normalized === "none") {
      delete payload.tool_choice;
      delete payload.tools;
      delete payload.functions;
    } else if (normalized !== "auto" && normalized !== "required") {
      // 未知的旧式字符串（如 "any"）按约定删除；auto/required 原样透传。
      delete payload.tool_choice;
    }
    return;
  }
  if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>;
    const type = typeof wrapped.type === "string" ? wrapped.type.trim().toLowerCase() : "";
    if (type === "none") {
      delete payload.tool_choice;
      delete payload.tools;
      delete payload.functions;
    } else if (type === "auto" || type === "required") {
      payload.tool_choice = type;
    } else if (type === "function") {
      const fn = typeof wrapped.function === "object" && wrapped.function !== null
        ? (wrapped.function as Record<string, unknown>)
        : undefined;
      const name = (typeof fn?.name === "string" ? fn.name : typeof wrapped.name === "string" ? wrapped.name : "").trim();
      if (name !== "") payload.tool_choice = name;
      else delete payload.tool_choice;
    } else {
      delete payload.tool_choice;
    }
    return;
  }
  delete payload.tool_choice;
}

/** 就地变换 pi 组好的 openai-completions payload；只在发给 workbuddy 模型前调用。 */
export function prepareChatPayload(payload: Record<string, unknown>): Record<string, unknown> {
  payload.stream = true;
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (typeof message === "object" && message !== null && !Array.isArray(message)
        && (message as Record<string, unknown>).role === "developer") {
        (message as Record<string, unknown>).role = "system";
      }
    }
    if (messages.length > 0 && (messages[0] as { role?: string } | undefined)?.role !== "system") {
      messages.unshift({ role: "system", content: "You are a helpful assistant." });
    }
    stripAssistantReasoning(messages);
  }
  if (payload.model === "deepseek-v4.1-flash") {
    const current = Number(payload.max_tokens);
    payload.max_tokens = Number.isFinite(current) && current > 0
      ? Math.min(current, FLASH_MAX_TOKENS)
      : FLASH_MAX_TOKENS;
  }
  normalizeToolChoice(payload);
  // ponytail: 从不主动注入 reasoning_effort —— 用户没选档位时请求保持裸形态，
  // "Default" 不能悄悄变成 high。桌面端只在 effort 已存在时补 reasoning_summary。
  injectReasoningSummary(payload);
  return payload;
}
