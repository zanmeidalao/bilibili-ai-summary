/**
 * B站AI总结助手 - background service worker
 *
 * 网络请求全部在 Service Worker 中发起：
 *  - SW 的 fetch 拥有 host_permissions，Chrome 会绕过 CORS 响应检查，
 *    因此即使 api.bilibili.com / aisubtitle.hdslb.com 不返回
 *    Access-Control-Allow-Origin，也能正常读取响应（content script 的
 *    fetch 没有该特权，会被 CORS 拦截报 Failed to fetch）。
 *  - 扩展上下文可设置 Referer 请求头（网页 fetch 不允许），B 站 API 依赖该头。
 *  - 请求不带页面 Origin，不会触发 B 站 412 风控。
 *
 * content script 通过 chrome.runtime.sendMessage({type:'GET_SUBTITLE'}) 调用。
 */
'use strict';

// 复用 shared.js 中的 AI 站点库（AI_SITE_NAMES / getAiSites），
// 保证 content script 与 service worker 使用同一份「地址→中文名」映射。
importScripts('shared.js', 'updater.js');

// 存储键旧名迁移（biliSubtitle* → biliAiSummary*），避免已安装用户已有提示词/设置丢失
const LEGACY_KEY_MAP = {
  biliSubtitleCopyMode: 'biliAiSummaryCopyMode',
  biliSubtitleAiEnabled: 'biliAiSummaryAiEnabled',
  biliSubtitleAiPrompt: 'biliAiSummaryAiPrompt',
  biliSubtitlePrompts: 'biliAiSummaryPrompts',
  biliSubtitleLan: 'biliAiSummaryLan',
  biliSubtitleQn: 'biliAiSummaryQn',
  biliSubtitleLanDoc: 'biliAiSummaryLanDoc',
  biliSubtitleAiSite: 'biliAiSummaryAiSite',
  biliSubtitleAiConvo: 'biliAiSummaryAiConvo',
  biliSubtitleAiAutoOpen: 'biliAiSummaryAiAutoOpen'
};
function migrateLegacyKeys() {
  chrome.storage.local.get(Object.keys(LEGACY_KEY_MAP), (old) => {
    const sets = {}, removes = [];
    for (const k of Object.keys(LEGACY_KEY_MAP)) {
      if (old[k] !== undefined) { sets[LEGACY_KEY_MAP[k]] = old[k]; removes.push(k); }
    }
    if (removes.length === 0) return;
    chrome.storage.local.set(sets, () => { if (removes.length) chrome.storage.local.remove(removes); });
  });
}
migrateLegacyKeys();

// ==================== GitHub 更新检测（基于仓库 version.json） ====================
// 安装/升级时建立周期检查闹钟并立即查一次；之后由 chrome.alarms 周期触发。
try {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
      setupUpdateAlarm();
      checkForUpdate().catch(() => {});
    });
  }
  if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((a) => {
      if (a && a.name === UPDATE_ALARM) checkForUpdate().catch(() => {});
    });
  }
} catch (e) { /* 不支持则跳过更新检测 */ }

// ==================== 基础工具 ====================
const sleep = (t) => new Promise((r) => setTimeout(r, t));

async function getJson(url, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { Referer: 'https://www.bilibili.com/' }
      });
      if (resp.ok) return JSON.parse(await resp.text());
      // HTTP 错误：4xx 为客户端错误（风控 412 / 字幕不存在 404 等），无需重试直接抛
      let msg = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(await resp.text());
        if (j && j.message) msg = `${j.message}（HTTP ${resp.status}）`;
      } catch (e) { /* 响应体不是 JSON，保留状态码 */ }
      if (resp.status < 500) throw new Error(msg); // 4xx：不重试
      lastErr = new Error(msg); // 5xx：进入重试
    } catch (e) {
      // 4xx 已显式抛错，直接向上传递，避免空耗重试
      if (e && e.message && /^HTTP [1-4]\d\d/.test(e.message)) throw e;
      lastErr = e;
      await sleep(500);
    }
  }
  throw lastErr || new Error('请求失败');
}

// ==================== wbi 签名（player 接口） ====================
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
  11, 36, 20, 34, 44, 52
];

let wbiCache = null;

async function getWbiMixinKey() {
  if (wbiCache && wbiCache.expire > Date.now()) return wbiCache.mixinKey;
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', 2);
  const img = nav.data && nav.data.wbi_img && nav.data.wbi_img.img_url;
  const sub = nav.data && nav.data.wbi_img && nav.data.wbi_img.sub_url;
  if (!img || !sub) throw new Error('无法获取 wbi 密钥');
  const imgKey = img.slice(img.lastIndexOf('/') + 1).replace(/\.\w+$/, '');
  const subKey = sub.slice(sub.lastIndexOf('/') + 1).replace(/\.\w+$/, '');
  const orig = imgKey + subKey;
  let mixinKey = '';
  for (const i of MIXIN_KEY_ENC_TAB) mixinKey += orig[i];
  mixinKey = mixinKey.slice(0, 32);
  wbiCache = { mixinKey, expire: Date.now() + 10 * 60 * 1000 };
  return mixinKey;
}

async function wbiSign(params) {
  const mixinKey = await getWbiMixinKey();
  const all = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

// 经典紧凑 MD5 实现（Joseph Myers 风格）
function md5(inputString) {
  const hc = '0123456789abcdef';
  function rh(n) {
    let j, s = '';
    for (j = 0; j <= 3; j++) {
      s += hc.charAt((n >> (j * 8 + 4)) & 0x0f) + hc.charAt((n >> (j * 8)) & 0x0f);
    }
    return s;
  }
  function ad(x, y) {
    const l = (x & 0xffff) + (y & 0xffff);
    const m = (x >> 16) + (y >> 16) + (l >> 16);
    return (m << 16) | (l & 0xffff);
  }
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cm(q, a, b, x, s, t) { return ad(rl(ad(ad(a, q), ad(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cm((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cm((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cm(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cm(c ^ (b | ~d), a, b, x, s, t); }
  function sb(x) {
    let i;
    const nblk = ((x.length + 8) >> 6) + 1;
    const blks = new Array(nblk * 16);
    for (i = 0; i < nblk * 16; i++) blks[i] = 0;
    for (i = 0; i < x.length; i++) blks[i >> 2] |= x.charCodeAt(i) << ((i % 4) * 8);
    blks[i >> 2] |= 0x80 << ((i % 4) * 8);
    blks[nblk * 16 - 2] = x.length * 8;
    return blks;
  }
  let i;
  const x = sb(inputString);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  let olda, oldb, oldc, oldd;
  for (i = 0; i < x.length; i += 16) {
    olda = a; oldb = b; oldc = c; oldd = d;
    a = ff(a, b, c, d, x[i + 0], 7, -680876936);
    d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819);
    b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897);
    d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063);
    b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510);
    d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713);
    b = gg(b, c, d, a, x[i + 0], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691);
    d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335);
    b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438);
    d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961);
    b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558);
    d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632);
    b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174);
    d = hh(d, a, b, c, x[i + 0], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979);
    b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487);
    d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520);
    b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i + 0], 6, -198630844);
    d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523);
    b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070);
    d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259);
    b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = ad(a, olda); b = ad(b, oldb); c = ad(c, oldc); d = ad(d, oldd);
  }
  return rh(a) + rh(b) + rh(c) + rh(d);
}

// ==================== 字幕逻辑 ====================
const LANG_NAME = { zh: '中文', en: '英文', other: '其他语言' };

/** 按 中文 > 英文 > 其他 选取字幕 */
function pickSubtitle(subs) {
  if (!subs || !subs.length) return null;
  const rank = (s) => {
    const l = String(s.lan || '').toLowerCase();
    if (l === 'ai-zh' || l.startsWith('zh')) return 0; // 中文
    if (l === 'ai-en' || l.startsWith('en')) return 1; // 英文
    return 2; // 其他
  };
  const sorted = subs.slice().sort((a, b) => rank(a) - rank(b));
  const best = sorted[0];
  const r = rank(best);
  return {
    sub: best,
    lang: r === 0 ? LANG_NAME.zh : r === 1 ? LANG_NAME.en : LANG_NAME.other
  };
}

/** 按「播放器是否展示 AI 字幕」过滤：aiAllowed=false 时剔除 ai- 前缀（AI 生成）字幕 */
function filterAiSubs(subs, aiAllowed) {
  if (aiAllowed) return subs || [];
  const isAi = (s) => String(s.lan || '').toLowerCase().startsWith('ai-');
  return (subs || []).filter((s) => !isAi(s));
}

/** 字幕 URL 可能是 //aisubtitle.hdslb.com/... 协议相对地址，规范为 https */
function normalizeUrl(u) {
  const s = String(u || '');
  if (s.startsWith('//')) return 'https:' + s;
  return s;
}

/** 解析字幕文本：优先纯 JSON，兼容 JSONP 包裹 */
function parseSubtitleText(text) {
  try { return JSON.parse(text); } catch (e) { /* fallthrough */ }
  const m = String(text).match(/window\.__SubtitleJSONP__\s*=\s*([\s\S]+?)\s*;?\s*$/);
  if (m) {
    try { return JSON.parse(m[1]); } catch (e) { /* ignore */ }
  }
  return null;
}

/** 获取字幕列表：优先 wbi 签名接口，失败回退无签名 v2 */
async function fetchSubtitleList(bvid, cid) {
  try {
    const q = await wbiSign({ bvid, cid });
    const r = await getJson(`https://api.bilibili.com/x/player/wbi/v2?${q}`, 2);
    const subs = (r.data && r.data.subtitle && r.data.subtitle.subtitles) || [];
    if (subs.length) return subs;
  } catch (e) {
    console.warn('[字幕助手] wbi player 失败，回退 v2:', e);
  }
  const r2 = await getJson(
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`
  );
  const subs2 = (r2.data && r2.data.subtitle && r2.data.subtitle.subtitles) || [];
  return subs2;
}

/** 抓取字幕内容：SW fetch 优先（扩展特权绕过 CORS），主世界 JSONP 兜底 */
async function fetchSubtitleBody(subtitleUrl, tabId) {
  const url = normalizeUrl(subtitleUrl);

  // 方式一：SW fetch
  try {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { Referer: 'https://www.bilibili.com/' }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = parseSubtitleText(await resp.text());
    if (json && Array.isArray(json.body)) return json.body;
    throw new Error('字幕内容格式异常');
  } catch (e) {
    console.warn('[字幕助手] SW fetch 字幕失败，尝试 JSONP:', url, e);
  }

  // 方式二：页面主世界 JSONP（script 标签跨域加载不受 CORS 限制）
  if (tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (u) => new Promise((resolve) => {
          try {
            try { delete window.__SubtitleJSONP__; } catch (e) { window.__SubtitleJSONP__ = undefined; }
            const s = document.createElement('script');
            s.src = u;
            const timer = setTimeout(() => { cleanup(); resolve({ error: '字幕 JSONP 加载超时' }); }, 20000);
            function cleanup() {
              clearTimeout(timer);
              try { s.remove(); } catch (e) { /* ignore */ }
            }
            s.onload = () => {
              cleanup();
              const v = window.__SubtitleJSONP__;
              if (v) resolve({ json: v });
              else resolve({ error: '字幕未返回 JSONP 数据' });
            };
            s.onerror = () => { cleanup(); resolve({ error: '字幕 JSONP 加载失败' }); };
            (document.head || document.documentElement).appendChild(s);
          } catch (e) {
            resolve({ error: String((e && e.message) || e) });
          }
        }),
        args: [url]
      });
      const res = results && results[0] && results[0].result;
      if (res && res.json && Array.isArray(res.json.body)) return res.json.body;
      if (res && res.error) console.warn('[字幕助手] JSONP 失败:', res.error);
    } catch (e) {
      console.warn('[字幕助手] executeScript 失败:', e);
    }
  }

  throw new Error('下载字幕失败（SW fetch 与 JSONP 均不可用）');
}

/** 拉取视频视图（/x/web-interface/view）返回 data；downloadVideo 与 fetchVideoView 共用，消除重复请求与解析 */
async function fetchView(bvid) {
  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (!view || !view.data) throw new Error('获取视频信息失败');
  return view.data;
}

/** 解析视频视图并取字幕列表（getSubtitle / getSubtitleLangs 共用） */
async function fetchVideoView(info) {
  if (!info || !info.bvid) throw new Error('未识别到视频（仅支持视频页）');
  const data = await fetchView(info.bvid);
  // 优先使用前台传入的真实 cid（来自播放器当前播放源），避免 SPA 自动连播 /
  // 页内换源 / 多 P 场景下按 info.p 重新解析选错分 P；缺失时再回退按 p 解析。
  let cid;
  if (info.cid) {
    cid = String(info.cid);
  } else {
    const pages = data.pages || [];
    const page = pages[(info.p || 1) - 1] || pages[0] || data;
    cid = String(page.cid || data.cid || '');
  }
  if (!cid) throw new Error('获取视频信息失败');
  const bvid = data.bvid || String(info.bvid);
  const title = data.title || '';
  const subs = await fetchSubtitleList(bvid, cid);
  return { subs, title, bvid, cid };
}

/** 主流程：view → 字幕列表 → 选择 → 字幕内容
 * @param lan 指定语言代码（'zh'/'en'/'ai-zh' 等），'auto'/空则沿用中→英→其他优先级
 * @param lanDoc 友好语言名，仅用于「找不到该语言」时的报错文案
 */
async function getSubtitle(info, tabId, lan, lanDoc, aiAllowed) {
  const { subs: rawSubs, title, bvid } = await fetchVideoView(info);
  const subs = filterAiSubs(rawSubs, aiAllowed);
  let picked;
  if (lan && lan !== 'auto') {
    const match = subs.find((s) => String(s.lan) === String(lan));
    picked = match ? { sub: match, lang: match.lan_doc || match.lan } : null;
  } else {
    picked = pickSubtitle(subs);
  }
  if (!picked) {
    throw new Error(
      lan && lan !== 'auto'
        ? `该视频没有「${lanDoc || lan}」字幕（可在右键菜单改回「自动」）`
        : '该视频暂无字幕（AI/CC 字幕需登录 B 站后可用）'
    );
  }

  const body = await fetchSubtitleBody(picked.sub.subtitle_url, tabId);
  return {
    body,
    title,
    bvid,
    lang: picked.lang,
    lan: picked.sub.lan,
    lanDoc: picked.sub.lan_doc
  };
}

/** 仅取可用字幕语言列表（供右键菜单动态展示） */
async function getSubtitleLangs(info, aiAllowed) {
  const { subs } = await fetchVideoView(info);
  return filterAiSubs(subs, aiAllowed).map((s) => ({ lan: s.lan, lan_doc: s.lan_doc || s.lan }));
}

// ==================== 视频下载（按所选清晰度，默认 1080p 自动回退） ====================
// 目标：点一下按钮把当前视频以所选清晰度存到本地（拉流失败逐级回退）。
// 技术要点：
//  - playurl 需要登录态才能拿到带签名的 durl 地址（SW 内 fetch 已能过 player 域，见字幕逻辑）。
//  - 视频流 CDN（*.bilivideo.com / *.hdslb.com / *.mountaintoys.cn 分片）返回 403 的病根
//    不是浏览器登录 Cookie，而是请求头（尤其 Referer / Origin / Range）触发 CDN 反盗链。
//    分片拉取与请求头组合重试放在 offscreen document 里做（那里有 DOM，能生成 blob URL）。
//  - MV3 Service Worker 没有 URL.createObjectURL，所以必须借助 offscreen 生成 blob URL，
//    再由 SW 用 chrome.downloads 落盘；chrome.downloads.onChanged 把落盘进度推回页面。

const VIDEO_DURATION_LIMIT_MS = 30 * 60 * 1000; // 30 分钟，用于标题里提示时长

/** 清洗标题为合法文件名（去非法字符、限制长度） */
function sanitizeFilename(name) {
  return String(name || 'video')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

/**
 * 在线获取某一清晰度的 durl 分片地址（带签名）。
 * @param bvid cid qn
 * @returns {Array<{url:string,size:number}>}
 */
async function fetchPlayUrlDurl(bvid, cid, qn) {
  // platform=html5 是关键：B 站给"html5 播放器"返回的 durl 走播放器同款 CDN 节点
  // （cn-gddg-* 等直连节点），防盗链允许 html5 式请求；不带此参数会返回
  // upos-sz-* 对象存储节点，防盗链极严（专防下载工具），几乎必然 403。
  // 注意：绝不能带 high_quality:1 —— 该参数会强制返回该清晰度下"最高码率"编码，
  // 体积会膨胀数倍（例如 1080p 两分钟视频从 ~200MB 暴涨到 1.19GB）。
  // 去掉后返回标准码率，体积正常且清晰度肉眼无差别。
  const q = await wbiSign({ bvid, cid, qn, fnval: 0, platform: 'html5' });
  const r = await getJson(`https://api.bilibili.com/x/player/wbi/playurl?${q}`, 2);
  // B站 playurl 的 qn 是"最低要求"，接口可能返回更高清晰度（如请求 80 返回 112/4K）。
  // 这里记录实际返回的 quality，便于上层 enforce 不超出用户选择。
  const actualQn = Number(r.data && r.data.quality) || qn;
  const acceptQn = (r.data && r.data.accept_quality) || [];
  const durl = (r.data && r.data.durl) || [];
  const withUrl = durl.filter((d) => d && d.url);
  // 优先取非空 size 的分片；若全部缺 size（部分接口返回不含 size），退而使用全部有 url 的
  const sized = withUrl.filter((d) => Number(d.size) > 0);
  const list = sized.length ? sized : withUrl;
  // DASH 格式诊断：fnval>=16 时才返回 dash，且 1080p+ 普遍只在 dash 里提供（durl 最高 720p）
  const hasDash = !!(r.data && r.data.dash);
  if (hasDash) {
    const dv = (r.data.dash.video || []).map((v) => v.id).join(',');
    const da = (r.data.dash.audio || []).length;
    console.log(`[字幕助手] DASH 可用：video清晰度=[${dv}]，audio流数=${da}`);
  } else {
    console.log(`[字幕助手] 未返回 DASH（fnval=0 仅 durl 格式，最高 720p），accept_quality=${acceptQn.join(',')}`);
  }
  return { list, actualQn, acceptQn, hasDash };
}

/** 确保 offscreen document 存在（离屏页负责分片拉取 + blob 生成）。
 *  每次都先 hasDocument() 检查：离屏页被 Chrome 回收后也能感知并重建，
 *  避免旧实现「首次成功后永久缓存」导致回收后 sendMessage 无人接收（P0-2）。 */
let offscreenCreating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (offscreenCreating) { await offscreenCreating; return; }
  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: '下载视频需要在离屏页面生成 Blob URL 并拉取视频流'
  }).then(() => { offscreenCreating = null; })
    .catch((e) => { offscreenCreating = null; throw new Error('无法创建离屏下载页面：' + ((e && e.message) || e)); });
  await offscreenCreating;
}

// 下载任务 id(requestId) → 发起下载的标签页 id 映射（进度转发用，待 DOWNLOAD_DONE 再清理）
const downloadTabMap = new Map();
let downloadSeq = 0;

/** 通知页面 content script 显示/更新下载进度 */
function forwardProgress(requestId, payload) {
  const tabId = downloadTabMap.get(requestId);
  if (!tabId) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: 'DOWNLOAD_PROGRESS', ...payload }).catch(() => {});
  } catch (e) { /* 标签页可能已关闭 */ }
}

/** 由 offscreen 回报的下载进度 → 转发给页面 */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'DOWNLOAD_PROGRESS') return undefined;
  forwardProgress(msg.requestId, msg);
  return undefined;
});

/**
 * 离屏页下载落盘完成后回报（成功/失败）：转发最终态给页面并清理任务映射。
 * 落盘进度由 offscreen 直接发来，经上面的 DOWNLOAD_PROGRESS 监听转发给页面。
 */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'DOWNLOAD_DONE') return undefined;
  const tabId = downloadTabMap.get(msg.requestId);
  if (tabId) {
    try {
      chrome.tabs.sendMessage(tabId, {
        type: 'DOWNLOAD_DONE',
        ok: !!msg.ok,
        error: msg.error || '',
        filename: msg.filename || ''
      });
    } catch (e) { /* 标签页可能已关闭 */ }
    downloadTabMap.delete(msg.requestId);
  }
  return undefined;
});

/** 离屏页 CDN 拉流失败时，由 SW 兜底拉取视频分片（SW 拥有 host_permissions，CORS 绕过最稳） */
async function fetchSegmentInSw(url, headers, credentials) {
  const resp = await fetch(url, { credentials: credentials || 'omit', headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.arrayBuffer();
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'FETCH_SEGMENT') return undefined;
  fetchSegmentInSw(msg.url, msg.headers || {}, msg.credentials)
    .then((ab) => sendResponse({ ok: true, arrayBuffer: ab }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // 异步 sendResponse
});

/**
 * 通过 offscreen 拉取分片并拼接成完整视频字节，再按 saveMode 落盘：
 *  - 'ask'     → 把字节发回页面，由页面用文件选择器写到用户指定位置；
 *  - 'default' → 离屏页锚点下载到浏览器默认下载文件夹。
 * @returns { started, totalBytes, filename, diagnostic }
 */
async function downloadViaOffscreen(durl, filename, tabId, requestId, saveMode) {
  await ensureOffscreen();
  let resp;
  const payload = { type: 'DOWNLOAD_START', requestId, durl, filename, saveMode: saveMode || 'default' };
  try {
    resp = await chrome.runtime.sendMessage(payload);
  } catch (e) {
    // 离屏页可能刚被回收：重建后重试一次（P0-2）
    try { await ensureOffscreen(); } catch (e2) { /* ignore */ }
    resp = await chrome.runtime.sendMessage(payload);
  }
  if (!resp || !resp.ok) {
    const err = new Error((resp && resp.error) || '离屏下载失败');
    if (resp && resp.error && resp.error.includes('诊断')) err.diagnostic = resp.error;
    throw err;
  }
  // requestId→tabId 映射保留至下载彻底完成（DOWNLOAD_DONE）再清理，
  // 否则离屏页转发的 save 阶段 DOWNLOAD_PROGRESS 找不到目标标签页
  return resp.result;
}

/** 主下载流程：view → playurl(指定清晰度，缺失则逐级回退) → offscreen 拉流 → 落盘
 * @param preferredQn 用户指定清晰度（16/32/64/80 或 'auto'）；auto 沿用原 360p 优先链
 */
/** 解析可下载视频流地址与文件名（清晰度优先 + 逐级回退）。供默认(sendMessage)与询问(端口)两种下载模式共用。 */
async function resolveDownload(info, preferredQn) {
  if (!info || !info.bvid) throw new Error('未识别到视频（仅支持视频页）');

  const data = await fetchView(info.bvid);
  const pages = data.pages || [];
  const page = pages[(info.p || 1) - 1] || pages[0] || data;
  const cid = String(page.cid || data.cid || '');
  if (!cid) throw new Error('获取视频信息失败');
  const bvid = data.bvid || String(info.bvid);
  const title = data.title || '';
  const duration = Number(data.duration) || 0;

  // 清晰度标签（含 1080p）
  const usedLabels = { 16: '360p', 32: '480p', 64: '720p', 80: '1080p' };
  // B站 playurl 的 qn 是"最低要求"，接口可能返回比请求更高的清晰度（如请求 80 实际返回 112/4K）。
  // 因此回退策略必须同时校验：1) 有可用 durl；2) 实际返回的 quality <= 请求的 qn。
  // 候选清晰度按「请求值 → 更小的可用值」排列，体积优先、只降不升。
  const allQualities = [80, 64, 32, 16];
  let qnCandidates;
  if (preferredQn && preferredQn !== 'auto') {
    const pq = Number(preferredQn) || 80;
    qnCandidates = [pq, ...allQualities.filter((q) => q < pq)];
  } else {
    qnCandidates = allQualities; // 默认 720p 起，由高到低尝试
  }
  let durl = null;
  let usedQn = null;
  let lastPlayErr = null;
  let lastActualQn = null;
  let lastAcceptQn = null;
  let lastDash = false;
  for (const qn of qnCandidates) {
    try {
      const res = await fetchPlayUrlDurl(bvid, cid, qn);
      lastActualQn = res.actualQn;
      lastAcceptQn = res.acceptQn;
      lastDash = res.hasDash;
      if (!res.list.length) {
        console.warn(`[字幕助手] playurl qn=${qn} 无可用分片，继续回退`);
        continue;
      }
      // 关键：实际返回的清晰度必须 <= 请求的清晰度，否则继续往下降
      if (res.actualQn > qn) {
        console.warn(`[字幕助手] playurl 请求 qn=${qn}，但接口实际返回 quality=${res.actualQn}（更高），继续回退`);
        continue;
      }
      durl = res.list;
      usedQn = res.actualQn; // 用实际清晰度（可能低于请求，但绝不会更高）
      break;
    } catch (e) {
      lastPlayErr = e;
      console.warn(`[字幕助手] playurl qn=${qn} 失败，继续回退：`, e);
    }
  }
  if (!durl) {
    const m = (lastPlayErr && lastPlayErr.message) || '';
    // 区分「网络被拦截」与「无可用视频流」，方便排障（而不是笼统报网络问题）
    if (/Failed to fetch|TypeError|network/i.test(m)) {
      throw new Error('获取播放地址失败：网络请求被拦截（请确认扩展已重新加载到最新版，并在浏览器登录了 B 站）');
    }
    const extra = lastActualQn ? `（最后一次接口返回 quality=${lastActualQn}，可接受列表=${(lastAcceptQn || []).join(',') || '无'}）` : '';
    throw new Error('该视频当前无可下载的视频流（可能需登录 B 站，或该清晰度不可用）' + extra);
  }

  const durLabel = duration ? `（${Math.round(duration)}s）` : '';
  // 文件名不再带子目录（避免保存到非预期路径）；用户可在「每次询问」模式下自行选择文件夹
  const filename = `${sanitizeFilename(title)}_${usedQn ? usedLabels[usedQn] : '视频'}${durLabel}.mp4`;
  // 预估总体积（分片 size 之和，仅供参考；B站偶尔 size 元数据不准，实际以下载为准）
  const totalSize = durl.reduce((s, d) => s + (Number(d.size) || 0), 0);
  const sizeMB = totalSize > 0 ? (totalSize / 1024 / 1024).toFixed(1) + 'MB' : '未知';
  console.log(`[字幕助手] 最终选定清晰度 quality=${usedQn}（${usedLabels[usedQn] || usedQn}），预估体积≈${sizeMB}，分片数=${durl.length}，文件名=${filename}`);
  return { durl, filename, usedQn, bvid, cid, acceptQn: lastAcceptQn, hasDash: !!lastDash };
}

async function downloadVideo(info, tabId, preferredQn, saveMode) {
  if (!info || !info.bvid) throw new Error('未识别到视频（仅支持视频页）');
  const { durl, filename, usedQn } = await resolveDownload(info, preferredQn);
  const usedLabels = { 16: '360p', 32: '480p', 64: '720p', 80: '1080p' };

  // 构造任务 id 并登记发起标签页（进度转发用）
  const requestId = 'task-' + (++downloadSeq);
  if (tabId) downloadTabMap.set(requestId, tabId);

  // 让离屏页面拉取分片并拼接成字节：
  //  - saveMode='ask'   → 离屏页把字节发回页面，由页面用「文件选择器」写到用户指定的位置；
  //  - saveMode='default' → 离屏页用锚点下载（渲染进程读取自有 blob，可靠）存到默认下载文件夹。
  // 不再使用 chrome.downloads.download(blobUrl)：下载网络服务无法解析扩展 blob URL，会静默失败。
  const off = await downloadViaOffscreen(durl, filename, tabId, requestId, saveMode);

  const totalBytes = off.totalBytes || 0;
  return {
    ok: true,
    message: `已开始下载（${usedQn ? usedLabels[usedQn] : ''}，${durl.length} 分片，${(totalBytes / 1024 / 1024).toFixed(1)}MB）`,
    filename,
    diagnostic: off.diagnostic // 供诊断排障
  };
}

// ==================== 下载端口中继（"每次询问位置"模式） ====================
// content 在用户点击时弹出「文件选择器」拿到句柄(FileSystemFileHandle)，该对象只能经
// 结构化克隆的端口传递，无法走 JSON 化的 sendMessage。故走：
//   content ──port(bili-dl-port)──▶ background ──port(bili-dl-off)──▶ offscreen(持句柄直接写盘)
// offscreen 回报的 PROGRESS/DONE 沿原路中继回 content。
// 按 requestId 维护「页面端口 ↔ 离屏端口」映射，支持连续多次下载互不串台
const dlPortMap = new Map(); // requestId -> { contentPort, offPort }
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'bili-dl-port') return;
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'START') return;
    // 立即回执：证明后台(新代码)已收到，避免前端看门狗误报「无响应」
    try { port.postMessage({ type: 'DL_ACK', requestId: msg.requestId }); } catch (e) { /* ignore */ }
    try {
      const info = await resolveDownload(msg.info, msg.qn);
      await ensureOffscreen();
      // 新创建的离屏页可能还在完成 JS 初始化，稍等 200ms 再连，避免 START 消息被漏接
      await new Promise((r) => setTimeout(r, 200));
      const offPort = chrome.runtime.connect({ name: 'bili-dl-off' });
      dlPortMap.set(msg.requestId, { contentPort: port, offPort });
      let offTimer = null;
      const resetOffTimer = () => {
        if (offTimer) clearTimeout(offTimer);
        offTimer = setTimeout(() => {
          try { port.postMessage({ type: 'DL_END', requestId: msg.requestId, ok: false, error: '离屏页传输超时（20秒内无新消息），请确认扩展已重新加载后重试' }); } catch (e) { /* ignore */ }
          try { offPort.disconnect(); } catch (e) { /* ignore */ }
          dlPortMap.delete(msg.requestId);
        }, 20000);
      };
      offPort.onMessage.addListener((m) => {
        resetOffTimer(); // 每收到一条消息重置计时器，避免大文件分片传输中误触发
        try {
          if (m && m.requestId == null) m.requestId = msg.requestId;
          if (port) port.postMessage(m);
        } catch (e) { /* ignore */ }
      });
      offPort.onDisconnect.addListener(() => { if (offTimer) clearTimeout(offTimer); dlPortMap.delete(msg.requestId); });
      // 离屏页 20s 内无任何消息，认为它没收到/卡死，直接报失败（避免空文件）
      resetOffTimer();
      // 把解析结果回报页面（页面 F12 控制台可见，便于排障；清晰度/分片数一目了然）
      const qLabels = { 16: '360p', 32: '480p', 64: '720p', 80: '1080p' };
      let note = '';
      // 用户选了更高清晰度但实际未拿到时，给出明确原因，避免用户以为选错
      if (Number(msg.qn) > Number(info.usedQn)) {
        if (info.acceptQn && info.acceptQn.length && !info.acceptQn.includes(Number(msg.qn))) {
          note = '当前账号/视频未开放 ' + qLabels[Number(msg.qn)] + ' 下载，B站返回的可用清晰度为 ' + info.acceptQn.map((q) => qLabels[q] || q).join('/') + '，已自动降级为 ' + qLabels[info.usedQn] + '。如需 1080p，请确认浏览器已登录大会员账号';
        } else if (info.hasDash) {
          note = '该视频 1080p+ 仅在 DASH 格式（音视频分离），当前下载通道仅支持 durl(flv，最高720p)。如需 1080p，请在后续版本选择 DASH';
        }
      }
      try {
        port.postMessage({
          type: 'DL_INFO',
          requestId: msg.requestId,
          quality: info.usedQn,
          qualityLabel: qLabels[info.usedQn] || String(info.usedQn || ''),
          segCount: info.durl.length,
          filename: info.filename,
          hasDash: !!info.hasDash,
          acceptQn: info.acceptQn || [],
          note
        });
      } catch (e) { /* ignore */ }
      // 把解析好的视频流地址与文件名交给离屏页拉流（拉到的字节由离屏页切片回传本页，本页再落盘）
      offPort.postMessage({ type: 'START', requestId: msg.requestId, durl: info.durl, filename: info.filename });
    } catch (e) {
      try { port.postMessage({ type: 'DL_END', requestId: msg.requestId, ok: false, error: String((e && e.message) || e) }); } catch (e2) { /* ignore */ }
    }
  });
  port.onDisconnect.addListener(() => {
    for (const [rid, v] of dlPortMap) {
      if (v.contentPort === port) { try { v.offPort.disconnect(); } catch (e) { /* ignore */ } dlPortMap.delete(rid); }
    }
  });
});

// ==================== 发送到右侧 AI 标签页 ====================
// 受支持站点以 shared.js 的 AI_SITE_NAMES 为唯一来源（manifest 中 ai-content.js
// 的 matches 应与之保持一致），不再单独解析 manifest，避免两处不同步导致漏识别。
function isAiTabUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    const names = (typeof AI_SITE_NAMES !== 'undefined') ? AI_SITE_NAMES : {};
    return Object.keys(names).some((h) => {
      const lh = h.toLowerCase();
      return host === lh || host.endsWith('.' + lh);
    });
  } catch (e) {
    return false;
  }
}

/** 取 URL 的 host（小写），失败返回 '' */
function hostOf(url) {
  try { return new URL(url || '').hostname.toLowerCase(); } catch (e) { return ''; }
}

/** host → 站点中文名（基于 shared.js 注入的 AI_SITE_NAMES）；非受支持站点返回 null */
function aiName(host) {
  return (typeof AI_SITE_NAMES !== 'undefined' && AI_SITE_NAMES[host]) ? AI_SITE_NAMES[host] : null;
}

/**
 * 扫描「当前窗口」全部标签页，找出受支持的 AI 站点；
 * 若 preferHost 对应的站点已打开，则优先返回那个标签（按站点名判定一致，而非裸 host，
 * 以兼容 www / 非 www 形态，如 kimi.moonshot.cn 与 www.kimi.com 视为同一模型）。
 * 返回 { tabs: [全部AI标签], tab: 选定标签|null, matched: 是否命中所选站点 }
 */
async function findAnyAiTab(senderTabId, preferHost) {
  const current = await chrome.tabs.get(senderTabId);
  const tabs = await chrome.tabs.query({ windowId: current.windowId });
  const aiTabs = tabs.filter((t) => isAiTabUrl(t.url || t.pendingUrl || ''));
  if (!aiTabs.length) return { tabs: [], tab: null, matched: false };
  const selName = aiName(preferHost);
  if (selName) {
    const hit = aiTabs.find((t) => aiName(hostOf(t.url || t.pendingUrl || '')) === selName);
    if (hit) return { tabs: aiTabs, tab: hit, matched: true };
  }
  return { tabs: aiTabs, tab: aiTabs[0], matched: false };
}

// ============ AI 模型选择 / 自动新建标签页 ============
const AI_SITE_KEY = 'biliAiSummaryAiSite';     // 选中的默认站点 host（用于无右侧 AI 时自动新建）
const AI_AUTO_KEY = 'biliAiSummaryAiAutoOpen';  // 无右侧 AI 标签页时是否自动新建（默认 true）
const DEFAULT_AI_SITE = 'chat.deepseek.com';   // 从未手动选择时的默认站点

function getSelectedSite() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([AI_SITE_KEY], (r) => {
        const v = r && r[AI_SITE_KEY];
        resolve(v ? String(v) : DEFAULT_AI_SITE);
      });
    } catch (e) { resolve(DEFAULT_AI_SITE); }
  });
}

function getAutoOpenPref() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([AI_AUTO_KEY], (r) => {
        resolve(r && typeof r[AI_AUTO_KEY] === 'boolean' ? r[AI_AUTO_KEY] : true);
      });
    } catch (e) { resolve(true); }
  });
}

/** 在当前 B 站标签页右侧新建一个 AI 站点标签页（index = 当前.index + 1） */
async function openAiTabNextTo(senderTabId, host) {
  const cur = await chrome.tabs.get(senderTabId);
  const url = 'https://' + host + '/';
  const tab = await chrome.tabs.create({ url, index: (cur.index + 1) });
  return await waitTabReady(tab.id);
}

/** 等待新建标签页加载完成且 AI 页输入框可聚焦（轮询，最长 15s） */
async function waitTabReady(tabId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.status === 'complete') {
        for (const w of [300, 500, 800]) {
          await sleep(w);
          try {
            const res = await chrome.tabs.sendMessage(tabId, { type: 'FOCUS_AI_INPUT' });
            if (res && res.ok) return (await chrome.tabs.get(tabId));
          } catch (e) { /* 内容脚本尚未就绪，继续等待 */ }
        }
      }
    } catch (e) { /* 标签页可能已关闭 */ }
    await sleep(500);
  }
  throw new Error('新标签页加载超时（可能需要登录或网络较慢）');
}

/**
 * 发送字幕到 AI：先扫描当前窗口全部标签找受支持站点，再按决策树决定复用或新建。
 * 决策：
 *  - 已打开且与所选模型【一致】→ 直接复用该标签
 *  - 已打开其它 AI 站点但与所选【不一致】→ 在右侧新建所选站点（自动新建开关关则报错）
 *  - 完全没有受支持站点 → 在右侧新建所选站点（自动新建开关关则报错）
 * 加固点同上（超时保护 / 分段插入 / 发送前确认）。
 */
async function sendToAi(text, senderTabId, convoMode) {
  const siteHost = await getSelectedSite();
  const autoOk = await getAutoOpenPref();
  // 「新建对话」模式：每次都新建标签页，跳过复用扫描（不受「自动新建」开关约束）
  const found = (convoMode === 'new') ? null : await findAnyAiTab(senderTabId, siteHost);

  let target = null;
  let autoOpenedHost = null; // 新建的站点 host（用于提示）
  let reusedHost = null;     // 复用的已打开标签 host（用于提示）

  if (found && found.tab && found.matched) {
    // 已打开且与所选模型一致 → 直接复用
    target = found.tab;
    reusedHost = hostOf(found.tab.url || found.tab.pendingUrl || '');
  } else if (found && found.tab && !found.matched) {
    // 已打开其它 AI 站点，但与所选不一致
    if (autoOk) {
      try {
        target = await openAiTabNextTo(senderTabId, siteHost);
        autoOpenedHost = siteHost;
      } catch (e) {
        return { ok: false, error: '自动新建 AI 标签页失败：' + ((e && e.message) || e) };
      }
    } else {
      const openName = aiName(hostOf(found.tab.url || found.tab.pendingUrl || '')) || '未知站点';
      const selName = aiName(siteHost) || siteHost;
      return { ok: false, error: `已打开的 AI 站点（${openName}）与所选模型（${selName}）不一致，且未开启「自动新建」` };
    }
  } else {
    // 没有任何受支持标签，或「新建对话」模式 → 在右侧新建所选站点
    // 「新建对话」模式本就要求每次新建，故不受「自动新建」开关约束
    if (autoOk || convoMode === 'new') {
      try {
        target = await openAiTabNextTo(senderTabId, siteHost);
        autoOpenedHost = siteHost;
      } catch (e) {
        return { ok: false, error: '自动新建 AI 标签页失败：' + ((e && e.message) || e) };
      }
    } else {
      return { ok: false, error: '未找到已打开的受支持 AI 站点（且未开启「自动新建」）' };
    }
  }

  if (!target) return { ok: false, error: '无法确定目标 AI 标签页' };
  const tab = target;

  await chrome.tabs.update(tab.id, { active: true });

  // 1) 让 AI 页 content script 聚焦输入框（快速重试：右侧通常已就绪，一次即成功）
  let focused = false;
  const waits = [100, 300];
  for (const w of waits) {
    await sleep(w);
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'FOCUS_AI_INPUT' });
      if (res && res.ok) { focused = true; break; }
    } catch (e) { /* 接收端不存在，重试 */ }
  }
  if (!focused) {
    const base = autoOpenedHost
      ? '新打开的 AI 页面未能定位输入框（可能未登录或加载失败）'
      : '未能在 AI 页面定位输入框（页面未打开，或安装后未刷新过 AI 页面）';
    return { ok: false, error: base };
  }

  // 2) 页面内 DOM 注入 + 点击发送（不使用调试器，无调试横幅），全程带超时保护
  try {
    const r = await withTimeout(runDomSend(tab.id, text), 20000, '发送超时（AI 页面无响应）');
    return { ok: true, sent: r.sent, autoOpened: autoOpenedHost, reused: reusedHost };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 限时包装：超时抛错，防止流程永久挂起 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))
  ]);
}

/**
 * DOM 注入式发送：向 AI 页 content script 发 INJECT_AI_TEXT，
 * 由其在本页内完成字幕写入与点击发送（不使用 chrome.debugger，无调试横幅）。
 */
async function runDomSend(tabId, text) {
  const res = await chrome.tabs.sendMessage(tabId, { type: 'INJECT_AI_TEXT', text });
  if (!res || !res.ok) throw new Error((res && res.error) || 'AI 页面注入失败');
  return { ok: true, sent: !!(res && res.sent) };
}

// ==================== 消息入口（统一一个 listener 按 type 分发） ====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;
  const tabId = sender.tab ? sender.tab.id : undefined;
  switch (msg.type) {
    case 'GET_SUBTITLE':
      getSubtitle(msg.info, tabId, msg.lan, msg.lanDoc, msg.aiAllowed)
        .then((r) => sendResponse({ ok: true, result: r }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // 异步 sendResponse
    case 'GET_SUBTITLE_LANGS':
      getSubtitleLangs(msg.info, msg.aiAllowed)
        .then((r) => sendResponse({ ok: true, result: r }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    case 'DOWNLOAD_360P':
      downloadVideo(msg.info, tabId, msg.qn, msg.saveMode)
        .then((r) => sendResponse({ ok: true, result: r }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    case 'SEND_TO_AI':
      if (!tabId) { sendResponse({ ok: false, error: '无法定位当前标签页' }); return undefined; }
      sendToAi(String(msg.text || ''), tabId, msg.convoMode)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    case 'OPEN_OPTIONS_PAGE':
      // content script 中 chrome.tabs 不可用，由 background 中转打开设置页
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }, () => {
        sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError ? String(chrome.runtime.lastError) : '' });
      });
      return true;
    case 'GET_UPDATE_INFO':
      // 读取已持久化的更新信息（不联网）
      getUpdateInfo().then((r) => sendResponse(r)).catch(() => sendResponse(null));
      return true;
    case 'CHECK_UPDATE':
      checkForUpdate()
        .then((r) => sendResponse({ ok: true, result: r }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    case 'DOWNLOAD_UPDATE': {
      // 下载最新版源码 zip（解压版扩展无法自替换，需用户手动覆盖并重载）
      (async () => {
        try {
          const info = await getUpdateInfo();
          const ver = info && info.latest ? info.latest : null;
          if (!ver) { sendResponse({ ok: false, error: '暂无可用更新信息，请先「检查更新」' }); return; }
          const url = getUpdateZipUrl(ver);
          await chrome.downloads.download({ url, filename: 'bilibili-ai-summary-update.zip', saveAs: false });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      })();
      return true;
    }
    default:
      return undefined;
  }
});
