<!-- Owner: src/world.ts, src/collection.ts, src/config.ts, src/archive.ts, src/usage.ts, src/model-text.ts, src/ENV_PROMPT.en.md, src/search.ts, src/web-search.ts, src/ego-browser.ts, src/ego-runtime.mjs, src/ego-transport/, webui/client.ts, webui/style.css, package.json -->

# cortico-world-dream

<img src="assets/icon.png" alt="Dream extension icon" width="128" height="128">

English | [简体中文](README_zh.md)

A standalone Cortico World for sleep, dream material collection and a searchable dream archive. Package name: `cortico-world-dream`; World id: `dream`; World API: **6**. The manifest includes the `cortico-world` keyword. The host must support that contract.


Dream events ask Coo to use the existing `pet_act` tool for its sleep/standing pose and follow the sleep reply rules. The World controls its own deadlines, searches and records. Poses and replies depend on Coo following the environment prompt; other Worlds' messages are not blocked. This extension does not write to Memory. Optional dream sharing asks Coo to consider sharing a dream through the existing QQ tools.

## Install from a local directory

Use Node.js 22 or later and the package's declared pnpm version. In this package directory, run:

```sh
corepack pnpm install
pnpm build
pnpm test
pnpm typecheck
```

1. Open Coopanion's **Extensions** page, select **World**, then **Install from a local directory**.
2. Select this package directory containing `package.json`, rather than `src`, `dist` or the Coopanion repository root.
3. Complete installation and restart Coopanion when the installation receipt requests it.
4. Open the **Dreams** World page and enable it. Automatic inactivity, sleep schedules and daydream schedules are initially disabled.
5. Open **Material collection settings** to connect an installed ego browser or save a Tavily key. ego accepts `ego-browser`, a blank field for PATH lookup, or an absolute executable/application path. **Connect and detect** checks the connection without selecting ego for collection. Web search needs no browser or API key. Keep API keys in the **Tavily API Key** field; do not put them in material topics, chat messages or prompts.
6. In **Sleep and dreams → Material collection**, check the methods to use, move them up or down into priority order, and save. Dreams try the saved methods in that order. Unchecking every method disables collection.

Local installation links to this directory. Keep it in place; after source changes, run `pnpm build` and restart Coopanion. This does not publish anything to npm.

If you saved a custom dream environment prompt, Cortico continues to prefer the deployment override. Upgrading does not replace it. Merge `{{dream.index}}`, its reading rules and the group/private sharing rules from `src/ENV_PROMPT.en.md` in the **Dream environment prompt** editor and save. Without an override, the updated package template is used. After restarting to load the updated extension, choose **System prompts → Apply now** or **World overview → Reload system prefix** to update the current conversation’s context. Saving a template or resuming an existing session after restart does not itself rebuild its prefix.

Version 0.9.0 removes the dream text window and its configuration controls. Saved `overlayEnabled`, `overlayUrl` and `overlayElectronFile` values are ignored. The upgrade leaves deployed files and dream archives in place.

## Sleep and dream settings

The **Configuration** page contains sleep, request timeout, result limit and per-dream/daily source limits. **QQ dream sharing** contains QQ command permissions and dream recipients. **Material collection settings** contains backend setup and connection controls. **Sleep and dreams** contains collection checkboxes and priority controls, backend status, designated sleep materials, daydream alarms and the archive.

| Setting | Behavior |
| --- | --- |
| Default sleep duration | Initially 10 minutes; range 1–1440 minutes. The panel can override one sleep period. |
| Sleep after inactivity | Initially disabled; default threshold 30 minutes. Eligible messages and desktop-pet touch events reset the clock. Only a touch reported as waking the pet ends sleep. |
| Dream mode | `always` starts a dream on each sleep entry. `probability` draws once per sleep period; value 0–1, initially 0.5. No repeated draws during that period. |
| Maximum dream duration | Initially 5 minutes, up to 60. Recording, cancellation, timeout or waking ends the dream; sleep can continue after recording. |
| Scheduled sleep | Initially disabled. Enter times such as `22:30,23:45`; each time is handled once per deployment-local day. |
| Scheduled daydreams | Initially disabled. Each alarm binds one `HH:mm` time to a fixed public topic. Starts only while awake with no active dream, without forcing sleep. |
| QQ users | Initially empty. Comma-separated QQ account numbers allowed to control this World. |

Dates and schedules use the deployment's time zone. Missed slots are not replayed after downtime. A valid sleep deadline resumes after restart; an interrupted dream does not restart or reroll.

Direct command examples: `睡觉十分钟`, `睡觉 30 分钟`, `sleep 10 minutes`, `睡觉`, `sleep`. No duration means the configured duration. `醒来`, `起床` and `wake up` wake early. Broader natural-language phrasing depends on Coo's tool use.

Ordinary desktop or settings-chat messages wake Coo and cancel its dream. A desktop-pet touch ends sleep or dreaming only when its event reports `meta.touch.woke === true`; other touches only reset inactivity. The desktop-pet World merges repeated touches, normally publishing about 2.5 seconds after the last touch, so Dream may observe the wake later than the animation.

Ordinary QQ messages do not wake Coo. A configured **QQ user** can explicitly request waking in private chat or by @mentioning Coo in a group. For natural-language QQ requests, Coo must recognize an explicit wake request before calling `dream_wake` with `explicitWakeRequest: true`. A mention alone is insufficient. While asleep, a direct group @mention from anyone, including a configured user who has not asked to wake, prompts at most one short sleep phrase such as “呼，呼…”, without ending sleep or discussing the message's topic.

The current QQ event contract exposes a rendered self-mention marker, not original `at` metadata. Mention detection therefore uses a compatibility fallback and cannot authenticate the original @mention. **QQ users** is this World's command allowlist; it is not the logged-in QQ account or an automatically synchronized Memory “owner” setting. This World does not read Memory documents to infer that permission.

For natural-language requests, `dream.message_ref` supplies the original message’s `eventCursor` to Coo. It binds the original wording to the internal number and includes QQ’s platform `messageId` when available. Coo interprets whether the message requests `dream_sleep`, `dream_wake` or `dream_add_material`; a reference does not establish sleep intent. References cover messages received since the World started, within five minutes and eligible under its existing sender and conversation rules. Literal sleep and wake commands remain automatic. References carry user wording as external content, without copying console PINs or attachments or writing to the dream archive or Memory. Tools revalidate the original message; a QQ platform id, the reference event’s own cursor, or a cursor that expired or predates restart cannot replace an eligible original cursor. Coo is instructed to treat the original and its reference as one message, without an extra chat reply.

A natural-language local message first wakes Coo under the ordinary-message policy. If Coo then interprets that same message as a request for a new sleep duration, its reference remains usable by `dream_sleep`. A newer user interaction or sleep-state operation invalidates this exception. Retrying an already applied sleep tool call does not extend the deadline.

## Materials and archive

Add a public topic or public link in **Designated materials** for sleep dreams, or ask Coo in eligible chat to save a topic. Chat additions use `dream_add_material` and the incoming event cursor. Topics have a 500-character limit, carry the `指定素材` tag, and remain until deleted in the panel.

The prompt asks Coo to process designated materials not yet retrieved on the deployment-local day before choosing its own news. A successful, nonempty `dream_search` or `dream_ego_read` with that material's id marks it processed for the day. Official WebSearch marks it when `dream_web_search_result` accepts sources for the request; failed or empty results do not. Other ego actions do not mark a material processed. Priority is an instruction to Coo; the World records processing dates.

**Daydream alarms and topics** has separate time and public-topic fields. Topics are required, limited to 500 characters and retained for every occurrence of that alarm. Each time can have only one alarm. Daydreams reuse their alarm's topic without a daily processed flag and do not borrow sleep materials. Enable scheduled daydreams in **Configuration**, then add or edit the alarms in the sleep panel.

Coo starts collection with `dream_search`, registering a public query and an optional sleep `materialId`. Tavily and web search return sources directly; ego returns `needsBrowser`, after which Coo browses and registers sources with `dream_ego_read`. The prompt asks Coo to choose one topic for each dream and collect several related news sources within the configured limits. It then calls `dream_record` with a title, dream text and returned source ids. Coo writes the title from the completed dream, summarizing its central scene or idea in at most 80 characters. Dream text is limited to 6000 characters. Records retain the title, text, source titles/URLs/excerpts, material ids and timestamps. Dreams are fictional artifacts, not factual autobiographical Memory entries.

The environment prompt, `dream_record` description and completion event require dream text, sources and processing progress to be saved only through Dream tools. File tools must not append records of this dream, its collection process or material-processing status to `notes.md` or other memory files. End the current task after a successful save; dream sharing is triggered by a separate `dream.share` event.

Click a record's title to expand or collapse it. The panel keeps that state through status refreshes and archive searches while the panel stays open. It shows the most recent 30 matching records; searches include titles. `dream_query` returns up to 50 summaries with titles, and `dream_read` returns one full record.

The `{{dream.index}}` environment variable is a JSON array of up to 10 most recently saved dreams, newest first. Each entry contains only `id`, `date` in `YYYY-MM-DD` format using the deployment's time zone, and the existing `title`; an empty archive produces `[]`. Coo treats these titles as fictional archive data, uses `dream_read` with an entry's id for details, and uses `dream_query` for records beyond the index.

The World derives the index from its archive when Cortico rebuilds the environment prefix or previews the prompt. Saving or deleting a record is reflected in the next generated index. Ordinary model requests reuse the current session prefix, so they do not refresh it automatically. The index exists in runtime memory and model context; it does not create another file or write to Memory.

Use a record's delete control and confirm to remove it and its share-notification entry in one archive write. Deletion does not refund collection counts or remove designated materials and alarms. It cannot retract existing events, model context, QQ drafts or sent messages.

Existing version 1 archives remain readable. Records without titles receive a short body excerpt marked `titleSource: "legacy-excerpt"`; their text and sources remain intact, and missing dream kinds stay unknown. New Coo-authored titles use `titleSource: "summary"`. Compatibility fields are saved on the next archive write; no model call generates missing titles. The retention rules below apply after upgrade.

On upgrade to 0.7.0, old `daydreamTimes` are migrated once to alarms with empty topics. Fill each topic before that alarm can run; deleted alarms are not recreated from the old setting. Existing designated materials remain available only to sleep dreams. Historical dreams are not automatically queued for sharing.

Another World can emit an event asking Coo to call `dream_query` and `dream_read` before deciding whether to start a conversation. Context-building or memory-query workflows can request the same tools. This package does not add that conversation World or modify existing Memory extensions.

## Retention, reference scores and deep dreams

Version 0.12.1 keeps ordinary dreams for **30 × 24 hours**, up to **100 records**. Records exactly 30 days old remain until they exceed that age. Cleanup runs on startup, every minute while running, before archive tool reads, and atomically when appending a dream. It first removes expired ordinary records, then removes the oldest ordinary records by creation time until at most 100 remain. Deep records are exempt from both limits. Manual deletion works for either tier.

The existing `dream/archive.json` stores each record's `score`, `tier` (`ordinary` or `deep`) and nullable `promotedAt`. Old records start ordinary at zero points and keep their body and sources until the retention policy removes them. Cleanup removes the record's collected sources, sharing state and usage receipts together; it preserves designated topics, daydream alarms and consumed collection counts. It cannot retract already sent messages or old model context.

**Configuration → Dream archive → Deep dream threshold** defaults to **3** (integer 0–1000). After each newly credited reply, a score strictly greater than this value promotes the record; the fourth valid reference promotes it with the default. Threshold changes take effect on the next credited use. Promotion is permanent even if the threshold later rises. `dream_query` and `dream_read` include the score and tier and can still retrieve deep records. Their titles carry a **Deep dream** badge in the archive whether collapsed or expanded.

Scoring supports **official QQ and desktop pet replies**. For a real current topic, Coo reads an older dream using `dream_read({id, replyTo})`. `replyTo` identifies the incoming QQ `messageId` and optional `target` (`group:<id>` or `private:<id>`), or a desktop `eventCursor` from `dream.message_ref`. The incoming message must be within five minutes, predate the read, and follow the dream's creation. Reading issues a five-minute `usage.usageToken` without adding points. Coo then sends its reply and calls `dream_mark_used({id, usageToken, reply})`: QQ supplies the outgoing `messageId` from the successful `qq_confirm` receipt; desktop supplies the exact visible reply `text`, joining its spoken beats without action markup.

The World verifies a matching channel output after that read in the same conversation. QQ evidence confirms API send success; desktop evidence confirms acceptance of the utterance, not completed playback or a read receipt. Topic relevance and whether the reply uses the dream remain Coo's judgment. An asynchronous desktop record may require retrying the score report; the reply must not be resent for scoring. Ordinary reads, queries, generation, failed sends, drafts and automatic QQ dream sharing do not count. A matching automatic share suggestion between the incoming message and output rejects ambiguous attribution. Console output currently has no verified delivery evidence and does not count. QQ speakers need not be command owners to provide a relevant conversational topic.

Each reply adds at most one point per dream. Opaque reply identities are stored in `usageReceipts` in the same archive for retry deduplication; chat bodies are not copied there. Prepared tokens stay in memory and expire after five minutes, sleep, daydream start or restart. Raising a score and recording its receipt use one atomic archive write. If using a custom environment prompt, merge the retention and reference-scoring instructions from `src/ENV_PROMPT.en.md`, then reload the system prefix.

## Optional QQ dream sharing

Dream sharing requires the QQ plugin and is off by default. In **QQ dream sharing**, save command owners (`qqUsers`) separately from sharing recipients. Enable `dreamTalkEnabled` and add groups to `dreamTalkGroups` or private recipients to `dreamTalkPrivates`. Recipient lists grant no sleep command permissions. A completed sleep dream waits until Coo wakes, while a completed daydream can be offered immediately when no sleep or dream is active.

Group and private dropdowns read enabled IDs from the QQ plugin’s watched list through its public roster panel. Choose an ID and select **Add**; a new empty row appears below it. Remove an entry with **×**. **Add custom** accepts a number when it is absent from the candidates or the QQ list cannot be read. Reading a list does not establish that QQ is connected. Only roster IDs and enabled flags are requested; the page does not retrieve account credentials, contact names or messages, or modify QQ’s own lists. Additions, edits, removals and the sharing switch save immediately; command owners use **Save command permissions**. Failed saves retain the entered values for retry.

For each queued record, the World randomly recommends one group or private recipient from the combined lists and provides one sharing suggestion to Coo. Coo calls `dream_read`, considers that conversation’s context, and may skip; if appropriate it uses `qq_draft`, reviews the draft and new events, then calls `qq_confirm`. QQ checks its own watched list when creating a draft; custom entries here do not bypass that check. A suggestion means Coo was notified, not that a message was delivered; it does not authorize choosing another recipient or broadcasting.

Pending notifications survive restart, and persisted notification events are checked to avoid repeating a suggestion after interruption. Disabling dream sharing or emptying both recipient lists clears pending work; removing a selected recipient discards its pending suggestion. Re-enabling the feature does not queue historical records. Deleting a dream clears its notification entry but cannot cancel a QQ draft or message already created elsewhere. Upgrading to 0.11.0 preserves existing owners, groups and pending group suggestions; the new private list defaults to empty. QQ settings move from **Configuration** to **QQ dream sharing** without renaming existing stored keys.

## Collection backends

In **Sleep and dreams → Material collection**, **Built-in** contains ego, Tavily and web search; **World extensions** contains **Official WebSearch (called by Coo)**. Numbers show the shared priority across both groups, and the move buttons adjust that order. Official WebSearch is unchecked by default. Version 0.12.0 preserves existing `collectorOrder` values; selecting the new method adds `websearch` to that same array.

Official WebSearch availability is checked by Coo when a dream reaches that method. Its status says **Coo checks tool availability**; local configuration readiness does not establish that `web_search` is installed or usable. Configure provider choices such as DeepSeek or Brave and their credentials in the official World, using the choices supported by your installed version. Dream neither reads those settings nor discovers a tool list.

The sidebar has one **Material collection configuration** indicator. Green means at least one checked backend has all required configuration; gray means none does. Backend indicators show configuration completeness, while **Currently using** identifies the current backend separately. This does not certify credentials, browser connectivity or search results. Hover text and connection results provide missing settings and errors.

**Material collection settings** contains three expandable sections: ego, Tavily and web search. The default view exposes the ego path with **Connect and detect**, and the Tavily API Key input. The expanded ego section contains Space and connection configuration, connection status and helper controls. Save changes such as **Restore minimized window for screenshots** with **Save configuration**. Choose methods and their priority in **Sleep and dreams → Material collection**; this is the only collection selection. Shared limits are edited on **Configuration**. API keys are saved as secrets and never returned to the panel.

| Collection limit | Default and behavior |
| --- | --- |
| Maximum sources per dream (`maxSourcesPerDream`) | 5; integer range 1–20. Applies across all collection calls within one dream. |
| Maximum sources per day (`maxSourcesPerDay`) | 20; integer range 1–1000. Applies across dreams on the successful registration date in the deployment's time zone. |

The limits count successfully registered sources with nonempty text. Within one dream, URLs are normalized and their fragments removed before deduplication; repeated reads and paginated reads of the same URL reuse its source id without counting again. Collecting that URL in a later dream counts again. Web search registers each accepted result URL and excerpt as one source. Empty results, failures and connection tests do not consume these limits. These are source limits; they do not cap network requests or service charges.

The sleep panel shows the current dream's usage and today's usage as thin bars: color represents registered sources and gray represents the remaining allowance. Each bar also gives the used, remaining and limit counts. If a limit is reduced below existing usage, the bar is full, the remaining allowance is zero and the actual usage stays visible. Daily counts persist across restarts; waking, cancellation or not saving a dream does not refund registered sources. Earlier dates remain stored. Once a limit is reached, Coo can finish a dream using its existing sources; no new dream starts while the daily allowance is exhausted. Old deployments receive the default limits, and version 1 archives without `collectionCounts` start with zero counts; historical dream records are not recounted.

The sleep panel reports the current phase, collection result, attempted methods and each backend's status. The phase is **Awake**, **Sleeping**, **Waiting for Coo**, **Collecting**, or **Generating dream**. A daydream prefixes the current phase with **Daydream**. **Waiting for Coo** means the active dream is waiting for Coo to call the collection tool and obtain source material. **Generating dream** means source material has returned and the World is waiting for Coo to compose and save a dream; it does not establish that a model request is currently running. The collection result reports the latest successful, nonempty dream collection time or the current collection failure. This status stays in memory for the current World instance and resets when the World restarts.

**Test collection connection** is available only on **Material collection settings**. It requires an enabled World and tests only the first checked backend whose saved configuration is complete. It does not fall back to another method or change the selection. For ego it connects to the dream Space and verifies control, without navigating or searching. Tavily and web search receive `current public news YYYY-MM-DD`, using the deployment-local date. A valid empty Tavily response confirms its connection; web search fails if all its engines return no usable excerpts. Tests report the backend and diagnostic result without asking Coo to act. They do not register sources, consume source quotas, process designated materials, create dreams or update the latest successful dream-collection time. Tavily may count a test against the account's usage.

### Connect ego

1. Install and open [ego-lite](https://github.com/citrolabs/ego-lite) separately, complete its initial setup, and enable the Dream World in Coopanion.
2. In **Material collection settings → ego**, keep `ego-browser` or leave the field blank to find it on PATH. An absolute executable path or a macOS `.app` path also works. Click **Connect and detect**; it opens the connection details without changing the checked methods or their priority.
3. The extension creates or reconnects to one deployment-owned dream Space and reports its name/id, selected transport and connection state. Connection progress, availability and errors appear above the expandable ego settings. A failed connection refreshes the panel immediately and shows its error code and reason; if no code is available, the cause is shown as unknown. Repeated connections reuse this Space. ego uses its default Profile; there is no Profile picker.

The default Profile may share existing login sessions with the dream Space. Coo is instructed to collect public material and avoid private account data, credentials, personal information, posting, purchases and account changes. The Space is an ownership boundary for browser operations, not a separate cookie store. Page text and screenshots can enter the host's configured model context; use ego only with a browser context suitable for this purpose.

| ego configuration | Default and behavior |
| --- | --- |
| Space name | Blank generates a deployment-specific name. Do not share its name or helper directory between deployments. |
| Request timeout | 45,000 ms; range 5,000–120,000 ms. |
| Snapshot text limit | 16,000 characters; range 1,000–60,000. |
| Restore minimized window | Enabled for page screenshots. |
| Connection mode | `auto`, `direct` or `helper`. `auto` tries direct CLI and uses an already running ordinary-permission helper only when ego rejects an elevated client before execution. |
| Helper directory | Blank uses `<dataDir>/dream/ego/helper`; a custom value must be an absolute path dedicated to this deployment. |

The helper is optional. **Prepare helper launcher** writes a launcher and displays its absolute path; it does not start a process. On macOS, open `start-ego-helper.command` yourself from a normal user session with Node.js 22 or later on PATH, then reconnect. Windows uses `start-ego-helper.cmd` and its accompanying PowerShell file. **Stop helper** stops this deployment's helper. Do not start it with root/administrator privileges.

Version 0.8.1 uses helper protocol 3. If you already run an ordinary-permission helper, stop it, prepare a new launcher and launch it again before reconnecting. A protocol 2 helper is incompatible. Direct connections do not require a helper.

The settings panel has no manual handoff or resume controls. Coo performs ordinary collection inside the dream Space. If ego reports user control, a browser permission prompt or an uncertain outcome, Dream suspends its browser work and continues through the selected backend order. It does not take control back, dismiss permission prompts or repeat an action whose outcome is unknown. The [public ego control contract](https://github.com/citrolabs/ego-lite/blob/d392204d1ea1a8027a591ab2b0129c2e11d85f26/package/ego-browser/src/ego-errors.ts) requires browser permission prompts to be handled by the user; it exposes no supported automatic rejection while the Space is paused.

For an existing Space, a recoverable local pause clears only after its metadata and a read-only SDK control check confirm agent control. This can detect control you returned in ego or recover local availability after an uncertain operation. It does not call a takeover or claim operation. The last unknown outcome remains available as `lastUnknownOutcome: { operation, code }` in connection state, `dream_status.browser` and collection receipts; restored availability does not establish whether that operation succeeded. An older uncertain state without the original operation name uses `operation: "unknown"`. Coo must inspect current pages before proceeding and must not replay the uncertain action.

Space checks use the saved id and verify its name. With no saved id, they require a unique match for the configured dream Space name and do not create a Space. Connecting to an existing agent Space delegated to the user retains its id while reporting that collection is paused, so later checks can recognize returned control. A Space owned by the user is a name conflict and is not adopted; configure a separate dream Space name in that case. Missing, ambiguous or mismatched identities do not authorize a takeover. An uncertain operation followed by a missing Space does not create a replacement. If the Space is confirmed missing and the controller is not paused for an uncertain outcome, a subsequent connection can create a new dream Space.

A dream that has advanced past ego does not return to it; later dreams can use ego after its availability is restored. Saving collection configuration, reconnecting, preparing or stopping the helper cancels the current dream while preserving the sleep deadline. The next dream uses the saved collection order.

Waking, cancellation and stopping the World cancel its pending work and prevent later operations or records for the old dream. The Space and pages remain available for inspection and reuse. An action already dispatched to the browser may still finish; cancellation cannot undo it. ego-lite is installed separately and is not bundled.

### ego browsing tools

During an active dream whose current collection method is ego, Coo can call 13 prefixed tools: `dream_ego_open`, `navigate`, `tabs`, `read`, `click`, `fill`, `press`, `scroll`, `evaluate`, `wait`, `shot`, `close` and `handoff` (each name begins with `dream_ego_`). They operate inside the owned dream Space. Page actions return snapshots and managed page labels; element references should come from a fresh snapshot. Only `dream_ego_read` registers nonempty text as a source for `dream_record`.

There is no fixed ego search website: Coo chooses public HTTP(S) pages and follows their browser interface. Explicit URLs reject credentials and known local/private addresses; this validation is not a browser-wide network filter. `evaluate` runs page JavaScript, with no Node or filesystem API. `shot` returns a page viewport image, up to 8 MiB, and requires a vision-capable model to interpret it; it does not capture the desktop. Video and Bilibili-specific tools are not included.

### Selection and search

For the `websearch` method, `dream_search` returns `needsWebSearch`, the public query, current quota and a `requestId`. Coo checks its available tools, calls the official `web_search` according to its declaration, then submits returned titles, public HTTPS URLs and excerpts through `dream_web_search_result` with the `cycleId` and `requestId`. The World assigns source ids for `dream_record`, counts distinct registered URLs and marks a designated sleep material processed only when sources are accepted. Source provenance identifies the content as model-reported from `web_search`; Dream does not independently verify that tool's response. Each handoff accepts one report, and a new query requires a new `dream_search` call.

An absent tool, failed search or empty result is reported with `failure: "unavailable"`, `"failed"` or `"empty"`. The same dream continues with the next selected method. Waking, expiry or a newer request makes old reports unusable. Dream cannot guarantee cancellation of an official tool already running in another World. **Test collection connection** cannot run this method and displays the Coo availability-check explanation instead. Merge these rules from `src/ENV_PROMPT.en.md` into any saved prompt override, then reload the system prefix.

The saved `collectorOrder` array is the only selection. For example, `["ego", "tavily", "browser"]` tries ego, then Tavily, then web search; `[]` disables collection. Each dream keeps its starting order and moves forward when a method is unavailable or fails, or a search returns no usable sources. It never returns to an earlier method, restarts sleep or resets source quotas. All methods share the same dream deadline and source limits. If every selected method is exhausted, Coo can record a dream from existing sources; with no sources, the dream is skipped without asking for manual help or inventing material.

Starting with `dream_search` registers the public query and optional sleep `materialId` before ego browsing. If ego is blocked, the World can then run the next backend with that query. An older direct ego call without a registered query returns `needsSearch` when fallback needs one; Coo continues with `dream_search` on the same topic. It must not infer a query from an error or private page, reclaim control or ask the user to restore ego.

On upgrade to 0.8.0, a `null` `collectorOrder` is migrated once from the old selection: `auto` becomes `["ego", "tavily"]` when `egoEnabled` was true, otherwise `["tavily"]`; explicit `ego` becomes `["ego"]` when enabled, otherwise `[]`; explicit `tavily` or `browser` becomes that single-item list. After migration, the old `backend` and `egoEnabled` values no longer select methods. Saved credentials, ego paths and Space settings are preserved. The old `egoProfileId`, Chrome executable path, search URL and domain settings remain stored but are not read or used for collection. An existing `dream/browser-profile/` directory is neither read nor deleted. Chrome is not required.

| Backend | Collected content |
| --- | --- |
| `tavily` | Sends news searches to `https://api.tavily.com/search` with a one-day time range. Retains returned excerpts, titles, links and dates when present; requests no raw pages, generated answers or images. |
| `ego` | Uses the installed `ego-browser nodejs` API for interactive public-page browsing, snapshots and page screenshots inside the owned dream Space. |
| `browser` | Web search: constructs fixed public search URLs and reads HTML/RSS result titles, links and excerpts over HTTP. It needs no Chrome installation, Profile or API key. |
| `websearch` | Coo calls the official `web_search` and reports its returned public source excerpts to Dream. The official World owns provider selection, requests and credentials. |

Web search uses the URL-building and result-parsing approach from [cortico-world-netlingo](https://github.com/danhuangpaii/cortico-world-netlingo/tree/38fea2eed308fc3a1f4865312d53a582b98279bf). It URL-encodes the same query and tries these fixed endpoints in order, stopping at the first usable result set:

1. `https://www.so.com/s?q={query}`
2. `https://www.sogou.com/web?query={query}`
3. `https://www.bing.com/search?format=rss&q={query}&count=10`
4. `https://html.duckduckgo.com/html/?q={query}&kl=cn-zh`

An HTTP error, timeout, oversized response or lack of valid excerpts advances to the next engine. Each engine gets at most 12 seconds or one quarter of the configured total request timeout, whichever is shorter; the whole search is also subject to that total timeout. Responses are capped at 512 KiB, and each accepted excerpt at 12,000 characters. The parser accepts only titled results with nonempty excerpts and public HTTPS domain URLs without credentials or custom ports. It does not visit result links, execute scripts, load page resources or read browser profiles. Endpoint DNS addresses are checked for public routing, and redirects are rejected. Search-engine HTML changes, challenges or login requirements can make a method unavailable.

Tavily and built-in web search default to a 30-second total timeout and a 5-result limit per call. Search results may lack publication dates; Coo must assess whether they suit the requested day. Tavily's one-day range also does not guarantee that each article was published today. Waking, cancellation and shutdown abort Dream-owned collection without trying another engine or backend and prevent old cycles from saving. Source text and browser action receipts are untrusted data, not instructions. ego processes receive a minimal environment without the Tavily credential.

## Data, files and network access

| Location or connection | Purpose |
| --- | --- |
| `<deployment dataDir>/dream/archive.json` | Sleep topics/processing dates, daydream alarms, dream titles/text/sources/scores/tiers, sharing state, usage receipt identities and daily collection counts; one atomic file. Ordinary dreams are subject to the 30-day/100-record retention limits. |
| `<deployment dataDir>/dream/state.json` | Sleep deadline and schedule execution dates. |
| `<deployment dataDir>/dream/ego/state.json` | Owned Space identity, halted/uncertain state and the last unknown operation outcome across restarts. |
| `<deployment dataDir>/dream/ego/rounds/round-*` | Per-call `script.mjs`, `result.json` and optional `page.png`; removed after success, failure or cancellation. |
| `<deployment dataDir>/dream/ego/helper/` or configured helper directory | Launchers, `helper.stdout.log`, `helper.stderr.log`, and running helper's `endpoint.json`/`.helper.lock`. Helper calls use its `ego/rounds/round-*` subdirectory and remove each completed round. |
| `<deployment dataDir>/dream/browser-profile/` | Legacy Chrome directory, if present; left in place without reading or deleting it. |
| `<deployment>/worlds/dream/ENV_PROMPT.en.md` or `ENV_PROMPT.zh.md` | Optional prompt override saved through Cortico’s prompt editor. |
| Deployment `.env` | Cortico `storeSecret` saves `CORTICO_DREAM_TAVILY_API_KEY` with owner-only permissions. The panel displays only whether it is configured. |
| Installed ego application/CLI and default Profile | Resolves and executes the CLI and manages the dream Space/pages. The default Profile can share login state with those pages. |
| Deployment configuration | Saves `collectorOrder`, ego CLI path, Space name, connection options and other nonsecret settings. Legacy selection and Chrome fields are retained but ignored after migration. |
| Cortico event store | New eligible messages/touches for activity, authorization and cancellation. Chat transcripts are not copied into the archive. |
| `https://api.tavily.com/search` | Dream or connection-test query and the Tavily credential authenticating that request; the key is not passed to browser backends or dream records. |
| Public websites selected by Coo | ego page navigation, public search interactions and page resources during an active dream. |
| `https://www.so.com/s`, `https://www.sogou.com/web`, `https://www.bing.com/search`, `https://html.duckduckgo.com/html/` | Fixed web-search endpoints receiving the public dream or connection-test query in priority order; no API key or browser cookies are sent. |
| Helper loopback HTTP endpoint | Authenticated local requests from this deployment to its optional helper. |

New directories use mode `0700`; archive/state files and ego scripts/results use `0600`. Archive/state updates use atomic replacement. The ego CLI imports each private `script.mjs` and returns a JSON file; console output is not the result channel. macOS helper launchers use `0700` and create logs with owner-only access; endpoint/lock files use `0600` and are removed when their helper exits. Launcher and log files remain for reuse and diagnosis.

The extension does not scan personal files or Memory documents. Browser tools are limited to the dream Space; Coo is instructed to use public material there. Public topics, source excerpts, snapshots, requested page images and dream text enter Coo's context and follow the host's configured model-service settings. Page screenshots are temporary transport files and are not stored in dream records.

Dependency installation contacts the configured npm registry. News collection runs during an active dream or a Tavily/web-search connection test. See [NOTICE.md](NOTICE.md) for sources and licenses, including the MIT-licensed ego integration and Netlingo search parsers adapted for this extension.

## Development checks

`pnpm test` runs offline World, adapter, archive and panel tests. `pnpm typecheck` checks Node/browser code, and `pnpm build` builds the panel and `dist/ego-helper.mjs`. The helper loads the shipped `src/ego-runtime.mjs`; retain both `src` and `dist` when installing. These checks do not replace a manual trial with the chosen news service and installed browser. Tests require no live account or installed Coopanion data.
