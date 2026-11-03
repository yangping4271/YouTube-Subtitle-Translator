# 项目开发约定

这是一个 Manifest V3 Chrome 扩展，用于获取 YouTube 字幕、翻译并显示双语字幕，以及复制或下载字幕。

## 项目入口与文档

- `src/core/`：不依赖浏览器的字幕、断句和翻译逻辑。
- `src/extension/`：Chrome API、YouTube 页面交互和后台任务。
- `public/extension/`：manifest、popup、样式和图标等静态文件。
- `tests/`：Vitest 单元测试与离线集成测试。
- `dist/extension/`：可重建的扩展产物，也是 Chrome MCP 加载的目录。
- `PRIVACY.md`：Chrome Web Store 隐私政策源文件，不要作为普通冗余文档删除。
- `docs/assets/`：Chrome Web Store 商店素材。
- `.mcp.json`：本项目的 Chrome DevTools MCP server 配置。
- `.agents/skills/reuse-chrome-devtools/SKILL.md`：本项目专用的真实 Chrome 测试 Skill。涉及浏览器或扩展行为时必须先读取并遵守；不要复制到全局 Skill 目录。

## 开发原则

- 默认以最少代码完成需求；优先删除死代码、重复状态和薄封装，不为未来假设添加抽象。
- 保持 `core` 与浏览器逻辑分离，不要把 Chrome API 或 DOM 依赖引入 `src/core/`。
- popup 通过 `config.js` 使用统一配置，不要复制配置规范化、API URL 或并发限制逻辑。
- 不要重新引入无效的全局 bundle 名、重复 content script 或仅供控制台调用的调试接口。
- 静态页面不要依赖远程字体或其他非必要远程资源。
- 配置使用 `chrome.storage.local`，不依赖 `.env`；使用命名导出、`import type` 和 `unknown`，错误处理复用 `utils/error-handler.ts`。
- GitHub 操作优先使用 `gh`。
- 修改已有文件时保留用户未提交的无关改动。

## 不能破坏的行为

- 只翻译英文源字幕。字幕轨只接受 `en` 或 `en-*`，没有英文轨时必须给出明确提示，不能回退到其他语言。
- 字幕获取按 caption track、player fallback、transcript panel 的既有策略工作；失败诊断不能阻塞成功结果。
- 保留字幕原文中的真实重复、顺序和时间；只能清理明确的重复记录、空白及非语音标注。
- SRV3 词级字幕必须保持原词序和时间，不能信任会改写原文的模型输出。
- 翻译会话必须保持有序最终结果、并发上限、取消传播、partial publication 和跨 Service Worker 恢复语义。
- API 配置继续支持 OpenAI、OpenRouter、DeepSeek、OpenCode Go 和 OpenAI-compatible endpoint；空 API Key 可用于不需要鉴权的兼容服务。
- OpenAI、OpenRouter 和 DeepSeek 内置供应商使用固定 host permission；自定义 API 使用运行时 optional host permission。修改权限后同时检查 manifest、popup 授权流程和打包结果。

## 测试

默认使用 Bun：

```sh
bun run typecheck
bun run test
bun run test:subtitle-fixture
```

- 单元测试验证可观察行为和关键边界，不要添加只检查旧函数名、旧字符串或旧 DOM 不存在的 cleanup 测试。
- 竞态、取消、恢复、并发和字幕时间对齐 case 属于高价值回归测试，精简时不要仅因文件较长而删除。
- 测试 fixture 必须提交到 `tests/fixtures/`，或者通过显式参数传入；测试不能隐式依赖 `tmp/`、`log/`、`.env` 或开发者本机密钥。
- 真实浏览器端到端验证使用 Chrome DevTools MCP，不保留依赖本地密钥的手工 E2E 脚本或测试页面。
- 可选信息缺失、兼容性降级、重试中间态和成功兜底不得输出 `warn`/`error`；只有导致当前操作或翻译任务最终失败的错误才使用错误日志和用户提示。

## Chrome MCP 验证

- 遵守项目内 `reuse-chrome-devtools` Skill，具体连接和回归步骤以该文件为准。
- 首次连接前说明用途并取得明确同意，同范围复用单一持久连接；完整回归须另获明确同意。
- 使用刚生成的 `bun run build:prod` 产物；未获同意只做本地检查，交付注明“未执行真实浏览器回归”。

## 临时文件与清理

- `dist/`、`coverage/`、`tmp/`、`log/`、`.env*` 和 `youtube-subtitle-v*.zip` 都不是源码。
- 临时 fixture 和日志放在已忽略目录，功能与测试不能依赖其长期存在。
- 历史发布 zip 不在项目根目录长期保留；需要发布时从当前源码重新构建。
- `node_modules/` 可通过 lockfile 恢复，但日常开发保留以运行构建和测试。

## 发布打包

- 商店发布只能使用 `bun run build:prod`，不能使用会生成 sourcemap 的 `bun run build`。
- 发布前删除已有目标 zip，从当前 `dist/extension/` 重新压缩。
- zip 根目录必须直接包含 `manifest.json`，不能多包一层目录。
- 交付前必须检查最终 zip，而不只是检查 `dist/extension/`：

```sh
unzip -l <zip>
unzip -p <zip> manifest.json
```

- 确认 zip 中没有 `*.map`，manifest 版本正确，权限符合预期且没有无效权限字符串。
- 过去曾因使用开发构建而把 sourcemap 打入发布包，也曾出现无效权限字符串 `"permissions"`；这两项必须作为硬检查。
