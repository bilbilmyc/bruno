# Bruno 简体中文维护分支

此 fork 基于 [usebruno/bruno](https://github.com/usebruno/bruno)，维护 Windows x64 与 Mac Apple Silicon 官方安装版的可恢复汉化补丁。

**下载：[Releases](https://github.com/bilbilmyc/bruno/releases)** · **[使用与恢复说明](tools/zh-cn/README.md)** · **[自动测试](https://github.com/bilbilmyc/bruno/actions/workflows/zh-ci.yml)**

**[云端跟进上游](https://github.com/bilbilmyc/bruno/actions/workflows/zh-update.yml)**：每天北京时间 10:17 检查稳定版，适配新静态文案，双平台测试通过后自动发布。不需要电脑一直开着 Codex，也无需配置模型 API 密钥。结构不兼容或测试失败时停发，详情见使用说明。

目前适配版本见 `tools/zh-cn/upstream-lock.json`。只发布已验证的对应版本补丁，保留原始文件和 Mac 原始签名用于恢复。部分动态或第三方文案可能仍为英文。

维护分支为 `zh-cn`；`main` 用于跟踪上游。原有上游工作流保留在 `.github/upstream-workflows`，本 fork 不运行上游的 npm 发布或其他无关工作流。
