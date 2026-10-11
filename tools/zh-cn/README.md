# Bruno 简体中文补丁

本 fork 维护官方 Bruno 安装版的可恢复汉化补丁，当前版本由 `upstream-lock.json` 记录。

- 支持 Windows x64、macOS Apple Silicon；独立补丁无需另装 Node.js。
- 校验官方 ZIP 下载摘要、原始 app.asar 与修改文件的 SHA-256。
- 翻译主要导航、菜单、设置和请求编辑器的静态文案。部分动态错误及第三方文本仍可能为英文。
- 不翻译用户名称、请求及响应数据、脚本、协议值，不改变付费授权。
- Windows 备份原始 app.asar；Mac 保留完整原版及官方签名。检测到应用升级或手工修改会拒绝用旧备份覆盖。

## 下载及使用

从 [本 fork 的 Releases](https://github.com/bilbilmyc/bruno/releases) 下载与已安装 Bruno 版本完全匹配的补丁。每次先保存工作并退出 Bruno。

Windows：右键 `bruno-zh-windows.exe`，选择以管理员身份运行，输入 1 安装汉化，2 恢复，3 检查状态。也可在终端使用：

```powershell
.\bruno-zh-windows.exe apply --app "C:\Program Files\Bruno"
.\bruno-zh-windows.exe restore --app "C:\Program Files\Bruno"
```

Mac：仅支持原生 ARM64 版 Bruno，独立工具要求 macOS 13+。在解压目录中执行：

```bash
chmod +x ./bruno-zh-macos-arm64
sudo ./bruno-zh-macos-arm64 apply --app /Applications/Bruno.app
# 恢复完整原版及原始签名
sudo ./bruno-zh-macos-arm64 restore --app /Applications/Bruno.app
```

Mac 中文副本采用本机 ad-hoc 签名，没有官方公证身份。为加载原始 Electron 框架，主程序保留 hardened runtime 和原始权限，并添加 `disable-library-validation` 权限。不会关闭系统 Gatekeeper。CI 的 M 芯片 macOS 启动验证不等同于下载后的 Gatekeeper 公证验收；首次打开仍可能需要在系统「隐私与安全性」中允许。

Mac 首次启动中文副本时，系统可能提示 Bruno 要访问钥匙串中的 `bruno Safe Storage`。确认是你刚打开的 Bruno 后，在 macOS 系统窗口中输入自己的登录密码并选择允许。此提示由重新签名触发；补丁不读取密码、不更改钥匙串权限。没有完成授权时，应用可能停在加载中。恢复原版后使用原始签名。

请保留备份：Windows 位于 `resources/bruno-zh-backup`；Mac 位于应用旁的 `.Bruno.app.bruno-zh-backup`。Mac 预留至少 2 GB 空间。

## 更新

升级官方 Bruno 前先恢复原版，完成升级后再使用对应新补丁。不要直接把旧补丁用于新版。

本 fork 的 `zh-cn` 分支保存维护工具和支持版本清单。[云端维护工作流](https://github.com/bilbilmyc/bruno/actions/workflows/zh-update.yml) 每天北京时间 **10:17** 在 GitHub Actions 检查最新稳定版，不依赖个人电脑或 Codex。GitHub 排队可能使实际运行时间延后。

发现新版后，流程同步上游源码、核对两平台官方 ZIP 的 SHA-256、重新提取静态文案、保留现有词库并补充新译文，在 Windows 和真实 ARM64 Mac 上验证，再发布新修订及校验文件。测试涵盖实际启动、HTTP 数据、保存、原版密文解密、重复汉化及完整恢复。发布前还核对测试提交、ZIP 内的程序哈希和上传后的 GitHub 摘要。

新增译文由 GitHub runner 上的固定版本 [Helsinki OPUS 英中模型](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh)（Apache-2.0）离线生成，无需 API 密钥。模型仅处理新静态界面文案，不是自动修改程序逻辑的编码代理；新译文未经人工逐条校对，可能需要后续润色。插值、协议值、示例等不进入自动翻译，部分文案仍保持英文。每次新增译文记录在 `maintenance/translation-report.json`。

资源结构显著变化、校验失败、翻译保护检查失败或任一平台测试失败都会停止发布，诊断留在 Actions；需要修复后重跑，不能保证任意上游大改都能无人干预完成。不会自动覆盖用户的本机安装。源码同步发现维护范围之外的用户改动也会停止，避免覆盖。

在工作流页面点 **Run workflow**：`check` 立即检查；`rehearse` 完整演练当前最新稳定版但不发布；`rebuild` 重建并发布当前稳定版的新补丁修订。发布失败留下的草稿会在后续检查中重试，已发布版本不会被覆盖。没有新版时，只在每月首次检查记录一次保活提交，避免公开仓库长期无活动导致定时任务自动停用。

如提示锁文件存在：先关闭所有补丁程序，确认没有 `bruno-zh` 进程，再手动删除报错中指定的 `.bruno-zh.lock` 文件。不要删除备份。Mac 的未完成暂存副本会保留为 `interrupted-时间戳.app` 以便检查。

## 开发

使用 Node.js 24、Python 3.13 和 Bun 1.4.2。在此目录执行 `npm ci --ignore-scripts`，运行 `npm test`。修改词库后，用 `node generate-plans.cjs Windows原版app.asar Mac原版app.asar` 重建清单；再 `npm run build:win` 或 `npm run build:mac` 编译独立程序。

`ci/prepare.py` 下载并校验对应平台官方包。`ci/verify.mjs` 在隔离目录运行原版和汉化版、发送本机 HTTP 请求、保存请求、验证数据不变，并验证原版完整恢复。macOS 必须使用 ARM64 runner。测试不接触日常用户配置，但应用启动可能注册 bruno://；本地测试后需恢复原有协议关联，CI 的一次性机器不受此影响。

Mac CI 在一次性 GitHub runner 上为两次启动分别建立临时钥匙串，写入同一随机测试密钥并仅信任对应应用签名，用来模拟用户完成系统授权。还检查原版加密的测试字符串可由中文副本解密。CI 不自动点击钥匙串授权，不放宽真实用户钥匙串权限；用户首次启动授权仍需手动完成。

公开仓库只包含代码、文案和公开构建元数据。个人配置、备份、日志、测试目录和编译缓存不提交。

这是非官方补丁，不由 Bruno 官方维护。上游代码沿用仓库 MIT 许可证。独立程序内嵌 [Bun 运行时](https://github.com/oven-sh/bun/tree/bun-v1.4.2)。
