# pi-workbuddy-plugin

中文 | [English](README.en.md)

A PI extension for using the WorkBuddy **CN**（`www.workbuddy.cn`）in the [pi](https://github.com/earendil-works/pi) environment.

## 功能

- 注册 `workbuddy` provider（openai-completions 兼容）。模型清单三级来源：云端 `/v3/config` 实时目录（与桌面端同源）→ 本地缓存文件 → 内置兜底；按目录 `agents.cli.models` 白名单注册（与桌面端同一"有效标识"），同名部署副本去重，免费档优先。
- 登录走插件设备授权：`/login workbuddy` 或 `/workbuddy` 菜单 → 浏览器授权 → 自动轮询取 token，国内端点长轮询容错。凭据存 `~/.pi/agent/.workbuddy-auth.json`（0600），到期前 5 分钟自动刷新（single-flight）。
- 请求变换对齐桌面端 CLI：强制流式、`developer`→`system`、剥离 assistant reasoning 回放、`tool_choice` 归一化、补齐 `reasoning_summary: "auto"`；deepseek-v4.1-flash 的 `max_tokens` 封顶 16k，防止推理循环烧积分。
- 上下文窗口档位取自目录 `contextWindow.supportedLengths`，默认最高档；`/workbuddy` 可按模型切档，pi 的用量显示与 compaction 随之更新。
- 状态行两档：简（初始档，余额只在底栏状态行）、全（完整卡片：账号、令牌过期、积分明细、模型）。
- 积分查询优先国内无前缀的 `/billing/meter/get-user-resource-summary`，失败回落国际版老接口；查询失败只降级显示。
- 推理档位：`supportedEfforts` 列表模型按档位映射；固定 `effort` 的模型档位直通；`onlyReasoning` 与 `canDisableThinking` 决定能否关闭思考。

## 使用

```bash
# 开发加载
pi -e ~/work/code/pi-workbuddy-plugin

# 登录（或 /workbuddy 菜单）
/login workbuddy

# 设置
/workbuddy            # 菜单：刷新积分 / 状态行简|全 / 上下文窗口选档 / free|all / 重登 / 断开
/workbuddy free|all   # 直接切换模型范围
/workbuddy 简|全      # 直接切换状态行
/workbuddy logout     # 断开登录
```

常驻加载：`pi install ~/work/code/pi-workbuddy-plugin`（或把目录加入 `~/.pi/agent/settings.json` 的 `extensions` 数组）。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `WORKBUDDY_BASE_URL` | 服务端地址，默认 `https://www.workbuddy.cn` |
| `WORKBUDDYAI_PRODUCT_CONFIG` | 产品配置缓存路径覆盖 |
| `PI_CODING_AGENT_DIR` | pi 配置目录（凭据/设置存放处），默认 `~/.pi/agent` |

## 说明

- 免费（x0.00）与付费模型共用配额，`/model` 选付费模型会扣积分。

MIT，详见 [LICENSE](LICENSE)。
