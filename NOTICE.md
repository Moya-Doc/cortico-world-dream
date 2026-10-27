<!-- Owner: package.json, pnpm-lock.yaml, LICENSE, src/index.ts, src/definition.ts, src/qq.ts, src/usage.ts, src/search.ts, src/web-search.ts, src/ego-browser.ts, src/ego-runtime.mjs, src/ego-transport/, webui/client.ts -->

# Sources and licenses / 来源与许可证

This extension started from the [Cortico World extension template](https://github.com/Pal-AI-Lab/Cortico/tree/main/templates/extension/world), licensed under MIT, copyright © 2026 Phantivia. Its full notice is retained in [LICENSE](LICENSE); the new implementation uses the same license.

本扩展从 [Cortico World 扩展模板](https://github.com/Pal-AI-Lab/Cortico/tree/main/templates/extension/world) 开始编写。模板采用 MIT 许可证，版权归 © 2026 Phantivia；完整声明保留在 [LICENSE](LICENSE)，新增实现沿用相同许可证。

## Development dependencies / 开发依赖

Versions below are resolved in `pnpm-lock.yaml`. Installed dependencies retain their own license files and transitive notices.

以下版本来自 `pnpm-lock.yaml`；安装的依赖保留自己的许可证文件和传递依赖声明。

| Dependency | Version | License | Source |
| --- | --- | --- | --- |
| Cortico | 0.2.6 | MIT | [Pal-AI-Lab/Cortico](https://github.com/Pal-AI-Lab/Cortico) |
| TypeScript | 5.9.3 | Apache-2.0 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) |
| Vitest | 2.1.9 | MIT | [vitest-dev/vitest](https://github.com/vitest-dev/vitest) |
| jsdom | 30.1.3 | MIT | [jsdom/jsdom](https://github.com/jsdom/jsdom) |
| esbuild | 0.28.2 | MIT | [evanw/esbuild](https://github.com/evanw/esbuild) |
| tsx | 4.23.15 | MIT | [privatenumber/tsx](https://github.com/privatenumber/tsx) |
| @types/node | 22.20.5 | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) |
| @types/jsdom | 21.1.7 | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/jsdom) |

## External integrations / 外部接口

The QQ adapter in `src/qq.ts` and receipt verification in `src/usage.ts` are independently written against these event and tool contracts. No Final or ProMAX implementation is copied or bundled:

`src/qq.ts` 的 QQ 适配与 `src/usage.ts` 的回执核验根据以下事件和工具契约独立编写，不复制或打包 Final、ProMAX 的实现：

| Contract reference / 契约参考 | Version / 版本 | Source license / 来源许可证 |
| --- | --- | --- |
| [Cortico QQ World](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/src/worlds/qq/world.ts) | Commit `cb9ddbd` | MIT |
| [cortico-world-qq-final](https://github.com/hth768/cortico-world-qq-final/blob/00a1f15e85f71b22590c60e8beeab8a570cb74b7/src/world.ts) | 0.6.33 / `00a1f15` | MIT |
| [cortico-world-qq-promax](https://github.com/Kpect10086/QQ-ProMAX/blob/360e37f5b83c2e0479069dd8886bc029c56ab732/src/world.ts) | 0.2.0 / `360e37f` | AGPL-3.0-or-later |

Public search URL construction and HTML/RSS result parsers in `src/web-search.ts` are adapted from [danhuangpaii/cortico-world-netlingo, `src/search.ts` at commit 38fea2eed308fc3a1f4865312d53a582b98279bf](https://github.com/danhuangpaii/cortico-world-netlingo/blob/38fea2eed308fc3a1f4865312d53a582b98279bf/src/search.ts), under the [MIT License](https://github.com/danhuangpaii/cortico-world-netlingo/blob/38fea2eed308fc3a1f4865312d53a582b98279bf/LICENSE), Copyright (c) 2026 cortico-world-netlingo contributors. The full copyright and license are retained in the `src/web-search.ts` header. This adaptation uses sequential 360, Sogou, Bing RSS and DuckDuckGo requests, with bounded response sizes and timeouts, cancellation, URL validation and per-result source registration. It does not include that project's hotboards, video or Bilibili features.

`src/web-search.ts` 的公开搜索网址拼接及 HTML/RSS 结果解析器改编自 [danhuangpaii/cortico-world-netlingo 提交 38fea2eed308fc3a1f4865312d53a582b98279bf 的 `src/search.ts`](https://github.com/danhuangpaii/cortico-world-netlingo/blob/38fea2eed308fc3a1f4865312d53a582b98279bf/src/search.ts)，采用 [MIT 许可证](https://github.com/danhuangpaii/cortico-world-netlingo/blob/38fea2eed308fc3a1f4865312d53a582b98279bf/LICENSE)，Copyright (c) 2026 cortico-world-netlingo contributors。完整著作权及许可证保留在 `src/web-search.ts` 文件头中。本扩展按 360、搜狗、Bing RSS、DuckDuckGo 的顺序请求，限制响应大小与超时，支持取消、网址验证及逐条来源登记；不包含该项目的热榜、视频或 Bilibili 功能。

The ego browser integration is adapted from [biliye/cortico-world-ego at commit 14ffb9e0ccf97ce5df8c8457ed7e574bbcd930b8](https://github.com/biliye/cortico-world-ego/tree/14ffb9e0ccf97ce5df8c8457ed7e574bbcd930b8), under the MIT License, Copyright (c) 2026 筆離嘢. Adapted files are `src/ego-browser.ts`, `src/ego-runtime.mjs` and `src/ego-transport/{bridge,types,failures,permissions,helper-bridge,helper,helper-launcher}.ts`. The full original copyright and license are retained in [src/ego-transport/LICENSE](src/ego-transport/LICENSE) and the controller/runtime headers. The adaptation covers the CLI script/result-file bridge, browser Space and page operations, control handoff, ordinary-permission helper and launchers. Configuration and expandable diagnostics also follow that project's interaction patterns. This extension adds dream-cycle authorization, source registration, read-only checks of current Space control and its own request validation; it excludes the reference project's video and Bilibili integrations.

ego 浏览器实现改编自 [biliye/cortico-world-ego 的提交 14ffb9e0ccf97ce5df8c8457ed7e574bbcd930b8](https://github.com/biliye/cortico-world-ego/tree/14ffb9e0ccf97ce5df8c8457ed7e574bbcd930b8)，采用 MIT 许可证，Copyright (c) 2026 筆離嘢。改编文件为 `src/ego-browser.ts`、`src/ego-runtime.mjs` 和 `src/ego-transport/{bridge,types,failures,permissions,helper-bridge,helper,helper-launcher}.ts`。完整原著作权和许可证保留在 [src/ego-transport/LICENSE](src/ego-transport/LICENSE) 及控制器/运行时文件头中。改编范围包括 CLI 脚本与结果文件传递、浏览器 Space/页面操作、控制权交接、普通权限辅助进程及启动文件；配置与展开诊断也参考该项目的交互结构。本扩展增加梦境周期权限、来源登记、Space 当前控制权的只读检查及请求验证，不包含参考项目的视频与 Bilibili 集成。

[ego-lite](https://github.com/citrolabs/ego-lite) is separately installed and [MIT-licensed, copyright © 2026 CitroLabs](https://github.com/citrolabs/ego-lite/blob/main/LICENSE). This package uses its documented `ego-browser nodejs`, Space and page APIs; it does not distribute ego-lite or a separate Chromium browser.

[ego-lite](https://github.com/citrolabs/ego-lite) 需要单独安装，采用 [MIT 许可证，版权归 © 2026 CitroLabs](https://github.com/citrolabs/ego-lite/blob/main/LICENSE)。本包使用文档公开的 `ego-browser nodejs`、Space 和页面 API，不分发 ego-lite 或另外的 Chromium 浏览器。

API references / 接口资料：

- [ego-browser API](https://github.com/citrolabs/ego-lite/blob/d392204d1ea1a8027a591ab2b0129c2e11d85f26/package/ego-browser/README.md)
- [ego control and permission-prompt errors / 控制权与权限提示错误](https://github.com/citrolabs/ego-lite/blob/d392204d1ea1a8027a591ab2b0129c2e11d85f26/package/ego-browser/src/ego-errors.ts)
- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [DuckDuckGo HTML search](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript) and [URL parameters](https://duckduckgo.com/duckduckgo-help-pages/settings/params)

Retrieved excerpts retain source titles and URLs in each dream record. Rights in retrieved text and page images remain with their providers/publishers; this package does not assign an open-source license to retrieved content. No third-party character art, audio, model weights or reference images are included.

采集的摘录在每条梦境记录中保留来源标题和网址，采集文字和页面图片的权利归原提供者/发布者；本包不会为采集内容另行指定开源许可证。包内不包含第三方角色美术、音频、模型权重或参考图片。

## Extension icon

`assets/icon.png` is an AI-generated image provided by Moya-Doc.
To the extent the author holds rights in this image, it is made available
under the MIT license included in this package.
This does not grant rights to any third-party characters or trademarks.
