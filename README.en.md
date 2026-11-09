# pi-workbuddy-plugin

[中文](README.md) | English

A PI extension for using the WorkBuddy **CN** (`www.workbuddy.cn`) in the [pi](https://github.com/earendil-works/pi) environment.

## Features

- Registers the `workbuddy` provider (openai-completions compatible). The model catalog comes from three sources, in order: the live cloud `/v3/config` catalog (same as the desktop CLI), a local cache file, then a built-in fallback. Registration follows the catalog's `agents.cli.models` allowlist (the same "valid IDs" the desktop CLI sees) and deduplicates same-named deployment copies, free tier first.
- Login uses the plugin device flow: `/login workbuddy` or the `/workbuddy` menu opens a browser authorization, then the plugin polls for the token (the CN endpoint long-polls, so timeouts are normal). Credentials live in `~/.pi/agent/.workbuddy-auth.json` (0600) and refresh five minutes before expiry (single-flight).
- Request transforms mirror the desktop CLI: force streaming, `developer`→`system`, strip assistant reasoning replay, normalize `tool_choice`, backfill `reasoning_summary: "auto"`. deepseek-v4.1-flash caps `max_tokens` at 16k so a reasoning loop can't burn credits.
- Context window tiers come from `contextWindow.supportedLengths` in the catalog and default to the highest. `/workbuddy` switches tiers per model; pi's usage display and compaction follow.
- Status line has two modes: compact (initial, balance only in the footer) and full (account, token expiry, credit breakdown, model).
- Credit queries prefer the CN unprefixed `/billing/meter/get-user-resource-summary` and fall back to the legacy international endpoint. A failed query only degrades the display.
- Models with a `supportedEfforts` list map levels by tier; fixed-`effort` models pass through. `onlyReasoning` and `canDisableThinking` decide whether you can turn thinking off.

## Usage

```bash
# Dev load
pi -e ~/work/code/pi-workbuddy-plugin

# Login (or /workbuddy menu)
/login workbuddy

# Settings
/workbuddy            # menu: refresh credits / status line 简|全 / context window tier / free|all / re-login / disconnect
/workbuddy free|all   # switch model scope directly
/workbuddy 简|全       # switch status line directly (compact|full)
/workbuddy logout     # disconnect
```

Persistent install: `pi install ~/work/code/pi-workbuddy-plugin` (or add the directory to the `extensions` array in `~/.pi/agent/settings.json`).

## Environment variables

| Variable | Description |
| --- | --- |
| `WORKBUDDY_BASE_URL` | Server address, default `https://www.workbuddy.cn` |
| `WORKBUDDYAI_PRODUCT_CONFIG` | Override for the product-config cache path |
| `PI_CODING_AGENT_DIR` | pi config directory (credentials/settings), default `~/.pi/agent` |

## Notes

- Free (x0.00) and paid models share one quota. Selecting a paid model via `/model` spends credits.

MIT, see [LICENSE](LICENSE).
