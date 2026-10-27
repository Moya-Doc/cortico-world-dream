<!-- Owner: src/world.ts, src/collection.ts, src/config.ts, src/model-text.ts, src/search.ts, src/web-search.ts, src/ego-browser.ts, src/ego-runtime.mjs, src/ego-transport/, src/archive.ts, src/usage.ts, webui/client.ts, webui/style.css, package.json -->

## 0.12.1

- Retain ordinary dreams for 30 real days and at most 100 records. Check on startup, every minute, on archive tool reads and on append; remove their sources, shares and usage receipts together without refunding collection quotas or deleting designated topics.
- Add score, tier and promotion time in the existing archive. Old records migrate to ordinary dreams with score zero; the retention policy applies on upgrade. Deep dreams are exempt from automatic cleanup and remain manually deletable.
- Add `dream_mark_used` after `dream_read` prepares a current-topic reference. Verify official QQ sent-message records or accepted desktop utterances; deduplicate each reply per dream. Reading, generation, automatic dream sharing and console output do not score. Topic relevance remains Coo's judgment, and chat bodies are not copied into the archive.
- Add the deep-dream threshold (default 3); strictly exceeding it promotes a record permanently. Expose score/tier in queries and reads and show a persistent deep-dream title badge. Merge new scoring rules into any custom environment prompt.
- 普通梦境按现实时间保留 30 天、最多 100 份；启动时、每分钟、档案工具读取前和新增时检查。清理同时移除其来源、分享及计分去重项，不返还采集额度，不删除指定素材。
- 在原档案增加分数、分类和晋升时间；旧记录兼容为普通梦境、0 分，升级后执行保留规则。深层梦境免于自动清理，仍可手动删除。
- 新增 `dream_mark_used`，先由 `dream_read` 为当前话题准备凭证，再核对官方 QQ 发送记录或桌宠已接受发言；同一回复对同一梦境只加一次。读取、生成、自动梦话及控制台输出不计分；相关性由 Coo 判断，不将聊天正文写入档案。
- 新增深层梦境阈值，默认 3，严格超过后永久晋升。检索和读取返回分数及分类，标题旁持续显示深层标签。自定义环境提示词需合并新增计分规则。

## 0.12.0

- Group collection choices into built-in methods and World extensions while retaining a single numbered priority order. Add optional official WebSearch, called by Coo; existing selections stay unchanged.
- Hand off public queries to Coo to check and call `web_search`, then register actual results through `dream_web_search_result`. Bind each report to its active cycle and request; share existing URL deduplication and source quotas. Preserve model-reported provenance in dream sources. Missing tools, failures and empty results advance to the next selected method.
- Keep provider selection and credentials in the official World. Dream does not discover or invoke other Worlds' tools; connection tests cannot verify this method. Merge the new instructions into any custom dream environment prompt before use.
- 采集方式分为「内置」与「World 扩展」，保留统一的编号优先级。新增可选的「官方 WebSearch（由 Coo 调用）」，已有选择保持不变。
- 将公开查询交给 Coo 检查并调用 `web_search`，再通过 `dream_web_search_result` 登记真实返回的素材。报告绑定当前梦境及请求，共用网址去重和来源额度；档案保留由模型转录的来源标记。工具不可用、失败或无结果时，继续下一种已选方式。
- 提供商选择和密钥保留在官方 World。梦境不自动发现或调用其他 World 的工具，连接测试不验证此方式；使用前需将新规则合并到已保存的自定义梦境提示词。

## 0.11.1

- Supply original message cursors through `dream.message_ref` so Coo can invoke Dream tools for natural-language requests. Bind the original wording and QQ platform message ID to the cursor, deliver user wording as external content, and recheck permissions and expiry at tool invocation.
- Keep literal commands automatic and deduplicate references across polling and delivery retries. Old messages are not reissued after restart; message references do not enter dream archives or Memory.
- Allow a local request that automatically woke Coo to supply a new sleep duration, unless a newer interaction or state change supersedes it. Retrying the applied request does not extend sleep.
- 通过 `dream.message_ref` 提供原消息内部编号，使 Coo 能为自然语言请求调用梦境工具。原话与 QQ 平台消息号绑定到内部编号，用户原话作为外部内容投递，工具调用时重新校验权限和时效。
- 固定格式命令仍自动处理；重复轮询和投递重试不会重复提供引用。重启后不补发旧消息引用，引用不写入梦境档案或 Memory。
- 本地请求自动唤醒 Coo 后，仍可用同一条请求设置新的睡眠时长；较新的交互或状态操作会使该例外失效，重试已执行的请求不延长睡眠。

## 0.11.0

- Move QQ command permissions and sharing controls to the dedicated QQ dream sharing panel. Read enabled group/private candidates through QQ’s public roster panel; support custom IDs, per-row editing and removal, and immediate saves without interrupting dreams.
- Add private dream recipients. Recommend one group or private recipient per record; Coo decides whether to share through the existing QQ draft/confirmation tools after waking or completing a daydream.
- Preserve existing `qqUsers`, `dreamTalkGroups` and group notification state. The new `dreamTalkPrivates` setting defaults to empty. QQ settings are no longer shown in the generic Configuration panel.
- 新增「QQ梦话」栏目，迁入 QQ 指令权限和梦话设置。通过 QQ 公开名单面板读取已启用的群号和私聊号码，支持自定义号码、逐行修改和删除，即时保存且不中断梦境。
- 增加私聊梦话接收人；每条记录仅随机推荐一个群或一位用户，醒来或白日梦结束后由 Coo 决定是否通过现有 QQ 草稿与确认工具分享。
- 保留原有 `qqUsers`、`dreamTalkGroups` 和群分享提示状态，新增 `dreamTalkPrivates` 默认为空。QQ 设置从通用「配置」页移除。

## 0.10.0

- Provide `{{dream.index}}` as a JSON index of up to 10 most recently saved dreams, newest first, containing only id, deployment-local date and existing title. Generate it from the archive when the environment prefix is rebuilt or the prompt is previewed, without another index file or Memory write.
- Direct Coo to treat index titles as fictional archive data and use `dream_read` for details or `dream_query` for other records. Custom environment prompt overrides need the new variable and its reading rules added manually. Saving and deletion affect the next generated index; existing session content is not retracted or refreshed on each model request.

- 新增 `{{dream.index}}`，以 JSON 提供最近保存的最多 10 条梦境，新记录在前，只包含 id、部署本地日期及已有标题。重建环境前缀或预览提示词时从档案生成，不另存索引文件，不写入 Memory。
- 提示 Coo 将索引标题作为虚构档案数据，使用 `dream_read` 获取详情、`dream_query` 查询其他记录。已保存的自定义环境提示词需要手动加入新变量及读取规则。保存或删除影响下次生成的索引，不撤回已有会话内容，也不在每次模型请求时刷新。

## 0.9.0

- Remove the dream text window, its configuration controls, OBS connection and Electron runtime dependency. Saved `overlayEnabled`, `overlayUrl` and `overlayElectronFile` values are ignored; deployed files and dream archives remain in place.
- Keep **Test collection connection** on **Material collection settings** and remove it from **Sleep and dreams**.
- Show current-dream and daily source usage as thin bars with a colored used portion, gray remaining portion and numeric counts. A lowered limit never hides the actual usage or produces a negative remainder.

- 移除梦境文字窗、对应配置入口、OBS 连接及 Electron 运行时依赖。忽略已保存的 `overlayEnabled`、`overlayUrl` 和 `overlayElectronFile` 值，保留部署文件及梦境档案。
- 「测试采集连接」保留在「素材采集配置」，从「睡眠与梦境」中移除。
- 本次与今日采集用量改用细进度条，彩色表示已采集、灰色表示余量，同时显示数量。调低上限后仍显示实际用量，余量不会成为负数。

## 0.8.1

- Remove manual handoff and resume controls from the settings panel. Show ego connection progress, availability, error codes and reasons outside the expandable settings; refresh immediately after failed actions and identify missing error codes as an unknown cause. Keep `dream_ego_handoff` for Coo to abandon ego collection and continue through the selected backend order.
- Restore local browser availability only after a read-only check confirms agent control of the same Space. Do not claim or take over a user-controlled Space or replay an uncertain action. Preserve `lastUnknownOutcome` in saved state, connection status, `dream_status.browser` and collection receipts; restoring availability does not return an active dream to an earlier backend.
- Retain the Space id when the initial connection finds an agent Space delegated to the user. Resolve missing ids only by a unique configured name, verify saved identities, and reject names owned by the user without taking control.
- Upgrade the ordinary-permission helper to protocol 3 for initial Space identity discovery and binding. Existing helper users must stop the old process, prepare a new launcher and restart it. Protocol 2 helpers are incompatible; direct connections require no helper.

- 移除配置面板的手动交接和恢复控制按钮。ego 连接进度、可用状态、错误码及原因显示在展开配置外，操作失败后立即刷新，缺少错误码时明确说明原因未知。保留 `dream_ego_handoff`，供 Coo 放弃 ego 采集并按已选后端顺序继续。
- 只读检查确认同一 Space 已处于 agent 控制后，才恢复本地浏览可用状态，不认领或接管用户控制的 Space，也不重放结果未知的动作。`lastUnknownOutcome` 保留在持久状态、连接状态、`dream_status.browser` 和采集回执中；恢复可用不会让当前梦境返回之前的后端。
- 首次连接发现 agent Space 已交给用户控制时，保留其 id；没有 id 时只按唯一配置名称查找，并验证已保存的身份。属于用户的同名 Space 直接报告冲突，不接管控制权。
- 普通权限辅助进程升级为协议 3，支持首次发现和绑定 Space 身份。已有辅助进程需要停止旧进程、重新生成启动脚本并启动；协议 2 不兼容，直连方式无需辅助进程。

## 0.8.0

- Select ego, Tavily and web search with checkboxes and priority controls in Sleep and dreams. `collectorOrder` is the sole selection; an empty list disables collection. Connecting ego does not select it. Saving collection settings cancels the active dream while preserving the sleep deadline.
- Migrate a null `collectorOrder` once: legacy auto becomes ego → Tavily when ego was enabled, otherwise Tavily alone; explicit ego becomes ego alone when enabled, otherwise an empty list; explicit Tavily/browser becomes that single method. Retain old settings and browser-profile files without using them for collection.
- Start collection with `dream_search` to register a public query and optional sleep material id. Failed or blocked methods and empty search results advance through the saved order using that query, without returning to earlier methods or resetting deadlines and quotas. A legacy ego call without a query returns `needsSearch` when needed. Exhausted dreams use existing sources or skip without asking for help.
- Leave user-controlled or paused ego Spaces paused. Do not automatically resume control or reject browser permission prompts. Collection can continue through the next selected backend.
- Replace Chrome collection with sequential HTTP searches through 360, Sogou, Bing RSS and DuckDuckGo, using MIT-licensed Netlingo URL construction and parsers. No browser installation, Profile or API key is required. Register each accepted result URL and excerpt separately; enforce response-size limits, per-engine/total timeouts and cancellation.
- Test only the first selected, configured backend, without fallback, selection changes or source quota use. Empty valid Tavily responses can confirm connection; web search requires usable excerpts.

- 在「睡眠与梦境」通过复选框和优先级操作选择 ego、Tavily、网页搜索。`collectorOrder` 是唯一采集选择，空列表表示不采集；连接 ego 不改变选择。保存采集配置取消当前梦境，保留睡眠截止时间。
- `collectorOrder` 为 null 时迁移一次：旧 auto 在 ego 启用时变为 ego → Tavily，否则仅 Tavily；旧明确选择 ego 时，启用则仅 ego，关闭则空列表；明确选择 Tavily/browser 时保留该单项。保留旧配置和 browser-profile 文件，采集不使用它们。
- 先通过 `dream_search` 登记公开查询词和可选的睡梦素材 id。方式失败、受阻或搜索结果为空时，使用该查询词按保存顺序向下尝试，不回头，也不重置时限和额度。旧 ego 调用未登记查询词时，按需返回 `needsSearch`。所有方式用尽后使用已有来源，或无来源时跳过，不请求人工协助。
- 保持用户控制或已暂停的 ego Space 状态，不自动恢复控制或拒绝浏览器权限提示；通过后续已选后端继续采集。
- Chrome 采集替换为依次请求 360、搜狗、Bing RSS、DuckDuckGo 的 HTTP 搜索，采用 MIT 许可的 Netlingo 网址拼接及解析器，无需浏览器、Profile 或 API Key。每个有效结果网址和摘录分别登记来源，限制响应大小、单引擎及总时限，并支持取消。
- 连接测试只验证首个已选且配置齐全的后端，不自动回退、不修改选择，也不占用来源额度；Tavily 的有效空响应可以确认连接，网页搜索必须取得可用摘录。

## 0.7.2

- Require dream text, sources and processing progress to be saved only through Dream tools. End the task after a successful save without appending dream or collection records to notes.md or other memory files.
- 明确要求梦境正文、来源和处理进度只通过梦境工具保存；保存成功后结束任务，不为梦境或采集过程追加 notes.md 或其他记忆文件。

## 0.7.1

- Preserve the host's checkbox check marks and selected colors for ego collection and screenshot window restoration; exclude checkboxes from text-field backgrounds, borders and padding.
- 保留 ego 采集与截图恢复窗口复选框的宿主勾号和选中色；文本输入框的背景、边框及内边距不再应用于复选框。

## 0.7.0

- Add daydream alarms with persistent fixed topics, separate from sleep materials. Migrate legacy `daydreamTimes` once to incomplete alarms that require topics; keep old records' unknown kind and do not queue historical shares.
- Add confirmed archive deletion and optional QQ Dream talk with its own group allowlist. Sleep dreams become eligible after waking; daydreams become eligible after completion. Persist one group recommendation and notification state per record; Coo chooses whether to use `dream_read`, `qq_draft` and `qq_confirm`.
- Keep ordinary QQ messages from waking Coo. Configured owners can explicitly request waking privately or by group @mention; other direct group mentions allow only a brief sleep reply. Mention detection uses QQ's rendered marker as a compatibility fallback. A touch cancels sleep/dreaming only when desktop-pet reports `touch.woke=true`.
- Keep common collection settings on Configuration, separate configuration readiness from the selected backend, and explain the built-in OBS export and default Electron runtime.

- 增加长期保留固定话题的白日梦闹钟，与睡梦素材分开。旧 `daydreamTimes` 仅迁移一次，生成待填写话题的闹钟；旧记录种类仍为未知，不补发历史梦境。
- 增加确认删除档案，以及默认关闭、使用独立群白名单的 QQ 梦话。睡梦醒后、白日梦完成后可提示分享；每条记录持久化一次群推荐和提示状态，由 Coo 决定是否调用 `dream_read`、`qq_draft` 与 `qq_confirm`。
- QQ 普通消息不再唤醒。配置的主人可在私聊或群聊 @ 时明确要求醒来；其他直接群提及仅允许简短睡眠回复。提及检测使用 QQ 渲染标记作为兼容回退；触摸仅在桌宠报告 `touch.woke=true` 时中断睡眠/梦境。
- 通用采集配置统一保留在「配置」页，区分配置齐全与当前使用状态，并说明内置 OBS 导出和默认 Electron 运行时。

## 0.6.0

- Preserve archive rows and their open/closed state during refreshes, so clicking a dream title toggles it in both directions.
- Require a title of at most 80 characters, composed by Coo to summarize each new dream. Keep existing version 1 records intact with explicitly marked excerpt fallbacks, without model requests to generate old titles.
- Add per-dream and daily registered-source limits, defaulting to 5 and 20. Deduplicate URLs without fragments within a dream; persist daily counts and material processing dates atomically. Cancellation does not refund counts, and connection tests do not consume them.
- Prompt Coo to collect several news sources around one topic per dream. Report current and daily usage in the panel. Existing deployments receive the new defaults; archives without `collectionCounts` start at zero without recounting historical records.

- 档案刷新保留记录节点和展开/收起状态，点击梦境标题可以双向切换。
- 新梦境要求 Coo 拟定不超过 80 个字符的概括标题。已有 version 1 记录完整保留，缺失标题采用明确标记的正文摘录，不为旧标题请求模型。
- 增加单次梦境与每日成功登记来源上限，默认分别为 5 和 20。同一次梦境按去除片段的网址去重，每日计数与素材处理日期原子保存；取消不退回条数，连接测试不计入条数。
- 提示 Coo 每次围绕同一个主题采集多篇新闻，面板显示本次与今日用量。旧部署使用新配置默认值；没有 `collectionCounts` 的档案从零开始计数，不追溯历史记录。

## 0.5.0

- Add 13 `dream_ego_*` tools for public-page browsing during an active dream, using a persistent deployment-owned Space. Nonempty `dream_ego_read` results register sources and mark designated materials processed for the day.
- Replace Profile selection and fixed ego search URLs with ego's default Profile and agent-chosen public pages. The default Profile may share existing login sessions; see the README's browser-context boundary before upgrading.
- Add ego enable, Space, timeout, snapshot limit, screenshot restoration and connection mode settings. Saved paths are preserved; ego stays disabled until enabled manually or by a successful connection. Legacy `egoProfileId` is ignored; saved search URLs remain Chrome configuration.
- Add direct and ordinary-permission helper connections, manually launched helper scripts, control handoff/resume and persistent halted/uncertain state. Cancellation retains the Space/pages and prevents further work for the old dream.
- Make ego connection tests verify connection and control without searching. Tavily/Chrome keep their public-query test. Build and ship the helper bundle with its runtime and upstream MIT notices.

- 增加 13 个 `dream_ego_*` 工具，在活动梦境期间通过部署专属的持久 Space 浏览公开页面。`dream_ego_read` 的非空结果登记来源，并标记指定素材当天已处理。
- ego 改用默认 Profile，由 Coo 选择公开页面，移除 Profile 选择和固定搜索地址。默认 Profile 可能共享已有登录状态；升级前请阅读 README 中的浏览器环境边界。
- 增加 ego 启用、Space、超时、快照上限、截图恢复窗口及连接方式配置。保留已有路径，ego 默认关闭，手动开启或连接成功后启用。旧 `egoProfileId` 不再使用，已有搜索网址保留为 Chrome 配置。
- 增加直连和普通权限辅助进程、手动启动文件、控制权交接/恢复及持久化暂停/结果不确定状态。取消时保留 Space/页面，并阻止旧梦境后续操作。
- ego 连接测试仅验证连接与控制权，不搜索；Tavily/Chrome 继续使用公开查询测试。构建并分发辅助进程及运行时，保留上游 MIT 声明。

## 0.4.1

- Run ego CLI requests through private `.mjs` files and read JSON result files so Profile detection and connection do not depend on console formatting or inline script parsing.
- Remove each call’s temporary directory after completion and keep owner-only read/write permissions on scripts and results.
- Report an unreadable connection result with reconnect/report guidance instead of an unsupported upgrade instruction.

- ego CLI 通过独立 `.mjs` 文件执行请求、JSON 文件返回结果，Profile 检测与连接不再依赖控制台格式或内联脚本解析。
- 每次调用结束后删除临时目录，脚本和结果文件仅允许所有者读写。
- 无法读取连接结果时提示重新连接及报告问题，不再无依据地要求升级浏览器。

## 0.4.0

- Add one sidebar indicator for collection configuration readiness, with the selected backend and missing configuration in its hover text.
- Show sleep/dream phase, the latest successful collection time and specific failures as text.
- Add a direct collection connection test that sends a fixed public query without invoking Coo, processing designated material or recording a dream.
- Move ego, Tavily and Chrome inputs into a separate collection settings panel with expandable sections; retain ego/Tavily status in the sleep panel.
- Support automatic ego-first selection and explicit ego, Tavily or Chrome selection. Existing paths, Profile ids and credentials are preserved.

- 增加一颗侧栏采集配置灯，悬停显示选用后端及缺少的配置。
- 通过文字显示睡眠/梦境阶段、最近成功采集时间及具体失败原因。
- 增加直接测试采集连接的按钮，发送固定公开查询，不调用 Coo、不处理指定素材、不记录梦境。
- 将 ego、Tavily、Chrome 输入移入独立的素材采集配置页面，支持展开详细选项；睡眠面板保留 ego/Tavily 状态。
- 支持自动优先选择 ego，或明确选择 ego、Tavily、Chrome；保留已有路径、Profile id 和密钥。

## 0.3.0

- Group configuration by sleep, collection, QQ access and the dream text window.
- Show missing configuration, connection checks and collection errors alongside gray/green status indicators.
- Detect ego Profiles from an installed application/CLI path, save the selected id internally, and reuse an extension-owned dream Space.
- Supply public HTML search defaults when explicitly connecting an empty browser-search configuration; preserve custom values.

- 按睡眠、采集、QQ 权限和梦境文字窗分类配置。
- 显示缺少的配置、连接检查及采集错误，并用灰色/绿色状态点区分配置状态。
- 根据已安装应用/CLI 路径检测 ego Profile，内部保存所选 id，复用扩展创建的梦境专用 Space。
- 显式连接时为空的浏览器搜索配置填入公开 HTML 搜索默认值，保留自定义配置。

## 0.2.0

- Show ego configuration before Tavily and the selected collector; migrate manual ego/Tavily selection to automatic ego-first selection.
- 显示 ego、Tavily 的配置状态及当前采集方式，将原手动选择迁移为 ego 优先的自动选择。

## 0.1.0

- Add idle, scheduled and explicit-command sleep, early wake and one dream decision per sleep period.
- Add scheduled daydreams, persistent designated materials, daily retrieval dates and searchable dream artifacts.
- Add Tavily, separately installed ego-lite and dedicated Chromium collection adapters.
- Add an eleven-language panel for sleep, materials, archive queries and local credential setup.
- Add an optional macOS single-display text window using the existing local OBS frame header.

- 增加无互动、定时及明确指令触发的睡眠，支持提前唤醒，每次入睡决定一次是否做梦。
- 增加定时白日梦、长期保留的指定素材、每天检索日期及可查询的梦境档案。
- 增加 Tavily、独立安装的 ego-lite 及专属 Chromium 采集适配器。
- 增加十一种语言的面板，用于睡眠、素材、档案查询及本机凭据配置。
- 增加可关闭的 macOS 单显示器文字窗，使用已有本机 OBS 帧的位置头部。
