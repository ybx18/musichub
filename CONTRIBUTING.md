# Contributing to MusicHub

感谢你考虑为 MusicHub 做贡献！🎉

## 行为准则

参与本项目的所有讨论与提交，均需遵守 [Code of Conduct](CODE_OF_CONDUCT.md)。

## 如何贡献

1. **Fork** 本仓库并克隆到本地。
2. 创建特性分支：`git checkout -b feat/your-feature`。
3. 本地运行：`node tools/serve.mjs`，在浏览器中验证你的改动。
4. 提交信息请清晰描述「做了什么 / 为什么」：
   - `feat:` 新功能
   - `fix:` 修复
   - `docs:` 文档
   - `refactor:` 重构
5. **推送** 并发起 Pull Request，在 PR 模板中说明改动与测试方式。

## 开发约定

- 纯前端、零依赖、零构建步骤。`app/` 直接可运行。
- 不引入打包器 / 框架；保持原生 JS（ES5 风格以兼容更多环境）。
- **不要往仓库内置任何音源**。新增音源能力请通过 `Sources.registerProvider` 的机制，
  示例放在 `app/js/sources.config.example.js`。
- 保持 `PROVIDERS` 默认仅含 `custom`，让「无内置音源」成为仓库的明确立场。

## 报告问题

- Bug 请使用 [Bug Report 模板](.github/ISSUE_TEMPLATE/bug_report.md)。
- 新功能建议请使用 [Feature Request 模板](.github/ISSUE_TEMPLATE/feature_request.md)。

## 安全问题

请勿在公开 Issue 中披露安全漏洞。请按 [SECURITY.md](SECURITY.md) 的流程私下报告。
