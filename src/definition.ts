import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { DREAM_DEFAULTS, type DreamConfigSection } from './config.ts';
import { DREAM_EGO_TOOL_DECLS, DREAM_TOOL_DECLS } from './model-text.ts';
import { DreamWorld } from './world.ts';
import { strings } from './strings.ts';

export const DREAM: WorldDefinition<DreamConfigSection> = {
  id: 'dream', label: 'Dream', defaults: () => ({ ...DREAM_DEFAULTS }),
  create: context => new DreamWorld({ context }),
  describe: {
    tools: describeTools([...DREAM_TOOL_DECLS, ...DREAM_EGO_TOOL_DECLS], {
      dream_status: { zh: '查看睡眠状态、当前梦境任务和指定素材。', en: 'Read sleep state, the active dream task and designated materials.' },
      dream_sleep: { zh: '执行已认证消息中的睡眠指令。', en: 'Apply a sleep command from an authenticated message.' },
      dream_wake: { zh: '根据已认证消息结束睡眠和采集。', en: 'End sleep and collection after an authenticated message.' },
      dream_add_material: { zh: '保存用户指定的公开话题。', en: 'Save a public topic designated by the user.' },
      dream_search: { zh: '为当前梦境采集公开新闻素材。', en: 'Collect public news for the active dream.' },
      dream_web_search_result: { zh: '登记 Coo 转交的官方 WebSearch 来源，或报告失败以继续尝试后续采集方式。', en: 'Register official WebSearch sources reported by Coo, or report failure to try the next collection method.' },
      dream_record: { zh: '记录梦境概括标题、正文和已采集的来源。', en: 'Record a summarizing dream title, dream text and collected sources.' },
      dream_query: { zh: '按关键词和日期查询梦境摘要。', en: 'Query dream summaries by words and date.' },
      dream_read: { zh: '读取梦境、来源与分数，可为当前话题准备引用凭证。', en: 'Read a dream, sources and score; optionally prepare a reference for a current topic.' },
      dream_mark_used: { zh: '核对实际回复后为引用的梦境计分，超过阈值晋升为深层梦境。', en: 'Score a dream after verifying the reply; promote it when its score exceeds the threshold.' },
      dream_ego_open: { zh: '在梦境 Space 打开公开网址。', en: 'Open a public URL in the dream Space.' },
      dream_ego_navigate: { zh: '在已有梦境页面导航到公开网址。', en: 'Navigate a managed dream page to a public URL.' },
      dream_ego_tabs: { zh: '列出梦境 Space 内的页面。', en: 'List pages in the dream Space.' },
      dream_ego_read: { zh: '读取页面快照并登记梦境素材来源。', en: 'Read a page snapshot and register its dream source.' },
      dream_ego_click: { zh: '点击页面元素并查看结果。', en: 'Click a page element and observe the result.' },
      dream_ego_fill: { zh: '填写公开搜索字段。', en: 'Fill a public search field.' },
      dream_ego_press: { zh: '向页面元素发送按键。', en: 'Send a key or chord to a page element.' },
      dream_ego_scroll: { zh: '滚动页面并读取快照。', en: 'Scroll a page and read its snapshot.' },
      dream_ego_evaluate: { zh: '在公开页面内执行 JavaScript。', en: 'Evaluate JavaScript within a public page.' },
      dream_ego_wait: { zh: '在宿主等待，不执行页面脚本。', en: 'Wait in the host without running page scripts.' },
      dream_ego_shot: { zh: '截取公开页面的当前视口。', en: 'Capture the current public page viewport.' },
      dream_ego_close: { zh: '关闭由 Coo 创建的梦境页面。', en: 'Close an agent-created dream page.' },
      dream_ego_handoff: { zh: '将梦境浏览器控制权交给用户。', en: 'Hand the dream browser to the operator.' },
    }),
    events: (['sleeping', 'woke', 'requested', 'completed', 'cancelled', 'share', 'sleep_reply', 'message_ref'] as const).map(kind => ({
      type: `dream.${kind}`, description: { zh: strings('zh').events[kind], en: strings('en').events[kind] },
    })),
  },
};
