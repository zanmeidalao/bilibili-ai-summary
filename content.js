/**
 * B站AI总结助手 - content script
 *
 * 职责：
 *  - 生成可拖拽的悬浮按钮（左键复制 / 右键切设置）
 *  - 从「当前 URL」提取 BV 号（绝不依赖 __INITIAL_STATE__ / __playinfo__ /
 *    oid 等可能残留「上一个视频」数据的来源，避免复制错视频的字幕）
 *  - 所有网络请求交给 background（Service Worker 拥有 host_permissions，
 *    可绕过 CORS 读取 B 站接口响应；content script 直连会被 CORS/风控拦截）
 */
(() => {
  'use strict';

  if (window.__biliAiSummaryLoaded) return;
  window.__biliAiSummaryLoaded = true;

  // ===================== 常量 =====================
  const STORAGE_KEY = 'biliAiSummaryCopyMode'; // 'text' | 'ts' | 'srt'
  const MODE_LABEL = { text: '纯文本', ts: '带时间戳', srt: 'SRT 格式' };
  const AI_KEY = 'biliAiSummaryAiEnabled'; // 是否自动发送到右侧 AI 标签页
  const PROMPT_KEY = 'biliAiSummaryAiPrompt'; // 旧版单提示词（仅用于迁移）
  const PROMPTS_KEY = 'biliAiSummaryPrompts'; // 提示词数组：[{id,name,text,builtin,active}]
  const LAN_KEY = 'biliAiSummaryLan'; // 字幕语言：'auto' 或具体语言代码
  const QN_KEY = 'biliAiSummaryQn'; // 下载清晰度：16/32/64/80（默认 64=720p，体积小且够清晰）
  const DL_SAVE_KEY = 'biliAiSummaryDlSaveMode'; // 下载位置：'ask'（每次询问）| 'default'（默认下载文件夹）
  const LAN_DOC_KEY = 'biliAiSummaryLanDoc'; // 语言代码→友好名 缓存（持久化，便于主菜单右侧显示）
  const AI_SITE_KEY = 'biliAiSummaryAiSite'; // AI 模型选择：选中的默认站点 host
  const AI_CONVO_KEY = 'biliAiSummaryAiConvo'; // AI 对话标签：'new'(新建对话) | 'reuse'(沿用对话)，默认 'reuse'

  // 默认分析提示词 / escapeHtml / normPrompt 由 shared.js 注入（content script 与 options.js 共享，避免重复）

  const QN_LABEL = { 16: '360p', 32: '480p', 64: '720p', 80: '1080p' };

  // ===================== 视频信息提取（只信 URL） =====================
  function getVideoInfo() {
    const params = new URLSearchParams(location.search);
    const p = parseInt(params.get('p') || '1', 10) || 1;
    // 仅以页面 URL 的 bvid 作为视频标识（用户正在看的视频页）。
    // 不再做播放器交叉校验：点击时的字幕闸门改由 onMainClick 内对「当前 URL」实时复检决定，
    // 保证「闸门」与「抓取」使用同一时刻的 URL，避免灰度状态滞后导致的误发。
    let bvid = params.get('bvid') || '';
    if (!bvid) {
      const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      if (m) bvid = m[1];
    }
    bvid = (bvid || '').trim();
    return { bvid, cid: '', p };
  }

  // 读取播放器「字幕」菜单，判断 AI 生成字幕（ai-）是否真正被播放器展示。
  // 返回 { ok, showsAi }：
  //   ok=true  → 已确定播放器字幕面板里是否有 AI 字幕项
  //   ok=false → 无法探测（播放器未就绪/选择器不匹配），交由调用方保守处理
  // B 站字幕语言项（.bpx-player-ctrl-subtitle-language-item[data-lan]）通常随播放器就绪进入 DOM；
  // 个别情况下需展开面板才出现，故 allowOpen=true 时才会自动展开面板读取（点击闸门用），
  // 无字幕灰度指示等被动场景用 allowOpen=false 避免面板闪烁。
  async function getPlayerAiVisible(opts) {
    const allowOpen = !!(opts && opts.allowOpen);
    const itemSel = '.bpx-player-ctrl-subtitle-language-item';
    const aiItemSel = '.bpx-player-ctrl-subtitle-language-item[data-lan^="ai-"]';
    let result = { ok: false };
    try {
      // 1) 语言项已在 DOM → 直接判定（无需展开，无闪烁）
      if (document.querySelector(aiItemSel)) {
        result = { ok: true, showsAi: true };
      } else if (document.querySelectorAll(itemSel).length) {
        result = { ok: true, showsAi: false };
      } else if (allowOpen) {
        // 2) 需展开面板才出现的版本：展开读取后收起还原
        const btnSels = [
          '.bpx-player-ctrl-btn[aria-label="字幕"]',
          '.bpx-player-ctrl-subtitle-btn',
          '.bilibili-player-subtitle-btn'
        ];
        let btn = null;
        for (const s of btnSels) { btn = document.querySelector(s); if (btn) break; }
        if (!btn) {
          result = { ok: false };
        } else {
          btn.click(); // 仅展开字幕语言面板，不点具体语言项，避免改变已选字幕
          const t0 = Date.now();
          while (Date.now() - t0 < 800) {
            if (document.querySelector(itemSel)) break;
            await new Promise((r) => setTimeout(r, 60));
          }
          const ai = !!document.querySelector(aiItemSel);
          try { btn.click(); } catch (e) { /* ignore */ } // 收起面板，还原状态
          result = { ok: true, showsAi: ai };
        }
      } else {
        // 被动场景不自动展开，仅读到为止；读不到交给调用方重试
        result = { ok: false };
      }
    } catch (e) {
      result = { ok: false };
    }
    return result;
  }

  // ===================== 消息通信 =====================
  function sendMessage(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error('扩展环境不可用'));
        return;
      }
      const timer = setTimeout(() => reject(new Error('请求超时，请重试')), timeoutMs || 30000);
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(res);
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // ===================== 格式化 =====================
  function fmtSRTTime(sec) {
    sec = Math.max(0, Number(sec) || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
  }

  function fmtTS(sec) {
    sec = Math.max(0, Number(sec) || 0);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const pad = (n, w) => String(n).padStart(w, '0');
    return `[${pad(m, 2)}:${pad(s, 2)}]`;
  }

  function formatSubs(body, mode) {
    const lines = body
      .map((e) => ({ from: Number(e.from) || 0, to: Number(e.to) || 0, content: String(e.content || '').trim() }))
      .filter((e) => e.content);
    if (!lines.length) return '';
    if (mode === 'srt') {
      return lines
        .map((e, i) => `${i + 1}\n${fmtSRTTime(e.from)} --> ${fmtSRTTime(e.to)}\n${e.content}`)
        .join('\n\n');
    }
    if (mode === 'ts') {
      return lines.map((e) => `${fmtTS(e.from)} ${e.content}`).join('\n');
    }
    return lines.map((e) => e.content).join('\n');
  }

  // ===================== 剪贴板 =====================
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 兜底：隐藏 textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // ===================== 模式存取 =====================
  let copyMode = 'text';
  function getMode() { return copyMode; }
  function setMode(mode) {
    copyMode = mode;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STORAGE_KEY]: mode });
      }
    } catch (e) { /* ignore */ }
  }

  // ===================== AI 发送开关 =====================
  let aiEnabled = true; // 默认开启：复制后自动发送到右侧 AI
  function getAiEnabled() { return aiEnabled; }
  function setAiEnabled(v) {
    aiEnabled = !!v;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [AI_KEY]: aiEnabled });
      }
    } catch (e) { /* ignore */ }
  }

  // ===================== AI 分析提示词（可管理列表，单选 active） =====================
  function defaultPrompts() {
    return [{ id: 'builtin-default', name: '默认分析', text: DEFAULT_AI_PROMPT, builtin: true, active: true }];
  }
  // normPrompt 由 shared.js 注入（与 options.js 共享）
  let prompts = defaultPrompts();
  function getActivePrompt() { return prompts.find((p) => p.active) || null; }
  function setActivePrompt(id) {
    prompts.forEach((p) => { p.active = (id !== '__none__' && p.id === id); });
    savePrompts();
    updateModeUI();
  }
  function savePrompts() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [PROMPTS_KEY]: prompts });
      }
    } catch (e) { /* ignore */ }
  }

  // ===================== 字幕语言 / 下载清晰度 =====================
  let subLan = 'auto'; // 'auto' 或具体语言代码
  function getLan() { return subLan; }
  function setLan(v, doc) {
    subLan = v || 'auto';
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const payload = { [LAN_KEY]: subLan };
        if (doc != null && subLan !== 'auto') {
          lanDocCache[subLan] = String(doc);
          payload[LAN_DOC_KEY] = lanDocCache;
        }
        chrome.storage.local.set(payload);
      }
    } catch (e) { /* ignore */ }
  }

  let dlQn = '64'; // 默认 720p：体积小、清晰够用；下载时按 720→480→360 回退（1080p 可选但体积更大）
  function getQn() { return dlQn; }
  function setQn(v) {
    dlQn = (v == null) ? '64' : String(v);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [QN_KEY]: dlQn });
      }
    } catch (e) { /* ignore */ }
  }

  // 下载位置：'ask' = 每次弹出系统保存对话框（用户自选位置）；'default' = 浏览器默认下载文件夹
  let dlSaveMode = 'ask';
  function getDlSaveMode() { return dlSaveMode; }
  function setDlSaveMode(v) {
    dlSaveMode = (v === 'default') ? 'default' : 'ask';
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [DL_SAVE_KEY]: dlSaveMode });
      }
    } catch (e) { /* ignore */ }
  }
  // 用于「每次询问」模式：在用户点击时弹出的文件选择器句柄（写盘时复用，无需再次手势）
  let pendingSaveHandle = null;
  // 「每次询问」模式的下载端口（句柄经结构化克隆透传给离屏页，由离屏页直接写盘）
  let dlPort = null;
  // 收集离屏页回传的视频字节分片（端口结构化克隆，ArrayBuffer 不丢失），收齐后由本页写盘
  let dlChunks = null;
  // 看门狗定时器：若后台/离屏页长时间无任何回传，提示多半是旧代码未重载
  let dlWatchdogTimer = null;
  // 清洗为合法文件名（与 background 的 sanitizeFilename 保持一致）
  function sanitizeName(name) {
    return String(name || 'video')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video';
  }

  // base64 → Uint8Array（接收离屏页发来的视频字节）
  function base64ToUint8Array(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ===================== AI 模型选择 =====================
  const DEFAULT_AI_SITE = 'chat.deepseek.com'; // 从未手动选择时的默认站点
  let aiSite = DEFAULT_AI_SITE;   // 当前选中的站点 host
  function getAiSite() { return aiSite; }
  function setAiSite(v) {
    aiSite = v || DEFAULT_AI_SITE;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [AI_SITE_KEY]: aiSite });
      }
    } catch (e) { /* ignore */ }
  }
  // ===================== AI 对话标签（新建对话 / 沿用对话） =====================
  const DEFAULT_CONVO_MODE = 'reuse'; // 默认沿用对话（保持现有行为不变）
  let aiConvoMode = DEFAULT_CONVO_MODE; // 'new'（每次新建标签页）| 'reuse'（复用已有）
  const CONVO_LABEL = { new: '新建对话', reuse: '沿用对话' };
  function getConvoMode() { return aiConvoMode; }
  function setConvoMode(v) {
    aiConvoMode = (v === 'new') ? 'new' : 'reuse';
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [AI_CONVO_KEY]: aiConvoMode });
      }
    } catch (e) { /* ignore */ }
  }
  // getAiSites() 每次都会重新解析 manifest，缓存一次避免重复开销（P2-6）
  let _aiSitesCache = null;
  function getAiSitesCached() {
    if (!_aiSitesCache) {
      _aiSitesCache = (typeof window !== 'undefined' && window.getAiSites) ? window.getAiSites() : [];
    }
    return _aiSitesCache;
  }
  // host → 中文名（优先匹配 getAiSites 的代表 host，兜底查 AI_SITE_NAMES 兼容 www/非 www 形态）
  function aiSiteName(host) {
    if (!host) return '';
    const sites = getAiSitesCached();
    const s = sites.find((x) => x.host === host);
    if (s) return s.name;
    // 兜底：直接查中文名映射（兼容 www.kimi.com 这类未在 getAiSites 代表的别名 host）
    return (typeof window !== 'undefined' && window.AI_SITE_NAMES && window.AI_SITE_NAMES[host]) || host;
  }

  // ===================== UI（Shadow DOM） =====================
  const host = document.createElement('div');
  host.id = 'bili-ai-summary-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .wrap {
      position: fixed;
      z-index: 2147483647;
      font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    .btn {
      position: relative;
      width: 52px; height: 52px;
      border-radius: 50%;
      background: linear-gradient(135deg, #fb7299, #e85b8f);
      color: #fff;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(251, 114, 153, .45);
      border: 2px solid rgba(255,255,255,.85);
      transition: transform .15s, box-shadow .15s;
      text-align: center;
    }
    .btn:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(251,114,153,.6); }
    .btn:active { transform: scale(.96); }
    /* 当前视频无字幕时图标转为灰度，提示不可用 */
    .btn.no-sub { filter: grayscale(1); opacity: .5; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .btn.no-sub:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,.3); }
    .btn .main { font-size: 15px; font-weight: 700; line-height: 1; letter-spacing: 1px; }
    .btn .sub { font-size: 9px; opacity: .9; margin-top: 3px; line-height: 1; }
    .toast {
      position: fixed;
      z-index: 2147483647;
      max-width: 320px;
      background: rgba(20, 20, 25, .92);
      color: #fff;
      font-size: 13px;
      line-height: 1.5;
      padding: 9px 13px;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,.3);
      pointer-events: none;
      opacity: 0;
      transition: opacity .2s;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .toast.show { opacity: 1; }
    .toast.ok { border-left: 3px solid #52c41a; }
    .toast.warn { border-left: 3px solid #faad14; }
    .toast.err { border-left: 3px solid #ff4d4f; }
    .dlp {
      position: fixed;
      z-index: 2147483647;
      width: 300px;
      background: rgba(20, 20, 25, .93);
      color: #fff;
      font-size: 12px;
      line-height: 1.5;
      padding: 10px 13px;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
      pointer-events: none;
      display: none;
    }
    .dlp.show { display: block; }
    .dlp .dlp-title { font-weight: 700; margin-bottom: 6px; }
    .dlp .dlp-bar {
      height: 8px;
      background: rgba(255,255,255,.18);
      border-radius: 4px;
      overflow: hidden;
    }
    .dlp .dlp-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #fb7299, #e85b8f);
      border-radius: 4px;
      transition: width .25s;
    }
    .dlp .dlp-meta {
      margin-top: 6px;
      color: rgba(255,255,255,.82);
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .dlp .dlp-meta .dlp-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dlp .dlp-meta .dlp-pct { font-weight: 700; }
    .menu {
      position: fixed;
      z-index: 2147483647;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0,0,0,.25);
      overflow: hidden;
      font-size: 13px;
      min-width: 168px;
      display: none;
    }
    .menu.show { display: block; }
    .menu .title {
      padding: 7px 12px;
      background: #f5f6f7;
      color: #61666d;
      font-size: 12px;
      border-bottom: 1px solid #e5e6e7;
    }
    .menu .item {
      padding: 9px 14px;
      cursor: pointer;
      color: #18191c;
      display: flex; justify-content: space-between; gap: 12px;
      align-items: center;
    }
    .menu .item:hover { background: #f0f1f2; }
    .menu .item .cur { color: #fb7299; font-weight: 700; }
    .menu .item .cur:empty { display: none; }
    .menu .sep { border-top: 1px solid #e5e6e7; margin: 4px 0; }
    .menu .back { color: #61666d; }
    /* 下载项置顶高亮，右键后正好出现在鼠标位置下方，方便直接点击 */
    .menu .dl-item {
      background: linear-gradient(135deg, #fb7299, #e85b8f);
      color: #fff;
      font-weight: 700;
      justify-content: center;
    }
    .menu .dl-item:hover { background: linear-gradient(135deg, #ff8aa8, #f06291); }
    /* 分析提示词子菜单内的「新建提示词」操作项：醒目高亮 */
    .menu .new-prompt-item {
      background: #fff1f5; color: #d4387a; font-weight: 700;
      border: 1px dashed #ffb3cf; margin: 4px 8px; border-radius: 6px;
      justify-content: center;
    }
    .menu .new-prompt-item:hover { background: #ffe3ee; }
    .ai-dot {
      position: absolute; top: -3px; right: -3px;
      width: 15px; height: 15px; border-radius: 50%;
      background: #52c41a; border: 2px solid #fff;
      color: #fff; font-size: 7px; font-weight: 700;
      display: none; align-items: center; justify-content: center;
      box-shadow: 0 1px 3px rgba(0,0,0,.3);
    }
    .ai-dot.on { display: flex; }

    /* 更新角标：发现新版本时显示（橙色 ↑） */
    .update-dot {
      position: absolute; top: -3px; left: -3px;
      width: 15px; height: 15px; border-radius: 50%;
      background: #fa8c16; border: 2px solid #fff;
      color: #fff; font-size: 10px; font-weight: 700;
      display: none; align-items: center; justify-content: center;
      box-shadow: 0 1px 3px rgba(0,0,0,.3);
    }
    .update-dot.on { display: flex; }

    /* 更新行：状态说明靠左，按钮靠右，小色点指示版本状态（不醒目） */
    .panel .p-update {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 12px; color: #61666d;
    }
    .panel .p-update-status { display: flex; align-items: center; gap: 7px; }
    .panel .p-update-dot {
      width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
      background: #9499a0;
    }
    .panel .p-update.state-uptodate .p-update-dot { background: #52c41a; }
    .panel .p-update.state-available .p-update-dot { background: #fa8c16; }
    .panel .p-update.state-error .p-update-dot { background: #e24b4a; }
    .panel .p-update.state-checking .p-update-dot { background: #9499a0; }
    .panel .p-update-ver { color: #61666d; white-space: nowrap; }
    .panel .p-update .p-check-update, .panel .p-update .p-dl-update {
      height: 28px; border: none; border-radius: 8px; font-size: 12px; cursor: pointer;
      font-family: inherit; padding: 0 12px; line-height: 1;
    }
    .panel .p-update .p-check-update { background: #f1f2f3; color: #18191c; }
    .panel .p-update .p-check-update:hover { background: #e6e8ea; }
    .panel .p-update .p-check-update:disabled { opacity: .6; cursor: default; }
    .panel .p-update .p-dl-update { background: #fa8c16; color: #fff; }
    .panel .p-update .p-dl-update:hover { filter: brightness(.97); }

    /* 控制面板（右键悬浮按钮弹出） */
    .panel {
      position: fixed; z-index: 2147483647;
      width: 320px; background: #fff; border: 1px solid #e3e5e7;
      border-radius: 14px; box-shadow: 0 10px 34px rgba(0,0,0,.16);
      padding: 14px 16px 12px; display: none;
      font-family: "Microsoft YaHei","PingFang SC",sans-serif; color: #18191c;
    }
    .panel.show { display: block; }
    .panel .p-head { display: flex; align-items: center; gap: 8px; }
    .panel .p-status { font-size: 12px; padding: 2px 8px; border-radius: 11px; background: #eaf7ee; color: #52c41a; white-space: nowrap; }
    .panel .p-status.no { background: #f1f2f3; color: #9499a0; }
    .panel .p-bv { font-size: 11px; color: #9499a0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .panel .p-close { width: 22px; height: 22px; border: none; background: transparent; color: #9499a0; font-size: 18px; line-height: 1; cursor: pointer; }
    .panel .p-title { font-size: 13px; margin: 4px 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .panel .p-actions { display: flex; gap: 8px; margin-bottom: 14px; }
    .panel .p-copy { flex: 1; height: 38px; border: none; border-radius: 9px; background: linear-gradient(135deg,#fb7299,#e85b8f); color: #fff; font-size: 14px; cursor: pointer; }
    .panel .p-copy:active { filter: brightness(.96); }
    .panel .p-dl { flex: 1; height: 38px; border: 1px solid #fb7299; border-radius: 9px; background: #fff; color: #fb7299; font-size: 14px; cursor: pointer; }
    .panel .p-dl:active { background: #fff5f8; }
    .panel .p-group { margin-bottom: 14px; }
    .panel .p-row { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
    .panel .p-label { font-size: 13px; color: #61666d; }
    .panel .p-group > .p-label { display: block; margin-bottom: 6px; }
    .panel .seg { display: flex; gap: 6px; }
    .panel .seg button { flex: 1; padding: 7px 4px; border: 1px solid #e3e5e7; border-radius: 8px; background: #fff; color: #61666d; font-size: 13px; cursor: pointer; font-family: inherit; }
    .panel .seg button.active { background: #fb7299; border-color: #fb7299; color: #fff; }
    .panel .dd { position: relative; margin-left: auto; }
    .panel .dd-trigger {
      display: flex; align-items: center; gap: 6px; min-width: 150px; max-width: 196px;
      padding: 6px 8px; border: 1px solid #e3e5e7; border-radius: 8px;
      background: #fff; color: #18191c; font-size: 13px; font-family: inherit; cursor: pointer;
    }
    .panel .dd.open .dd-trigger { border-color: #fb7299; }
    .panel .dd-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
    .panel .dd-caret { color: #9499a0; font-size: 11px; }
    .panel .dd-list {
      position: absolute; top: calc(100% + 4px); right: 0; z-index: 20;
      min-width: 100%; max-height: 220px; overflow-y: auto;
      background: #fff; border: 1px solid #e3e5e7; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 4px;
    }
    .panel .dd-list[hidden] { display: none; }
    .panel .dd-item { padding: 7px 10px; border-radius: 6px; font-size: 13px; color: #18191c; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel .dd-item:hover { background: #fff5f8; color: #fb7299; }
    .panel .dd-item.active { background: #fb7299; color: #fff; }
    .panel .switch { margin-left: auto; width: 42px; height: 24px; border-radius: 13px; background: #e3e5e7; position: relative; cursor: pointer; transition: background .15s; flex: 0 0 auto; }
    .panel .switch.on { background: #fb7299; }
    .panel .switch .knob { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .15s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
    .panel .switch.on .knob { left: 20px; }
    .panel .p-manage { border: none; background: transparent; color: #fb7299; font-size: 13px; cursor: pointer; padding: 2px 4px; font-family: inherit; }
    .panel .p-foot { font-size: 11px; color: #9499a0; border-top: 1px solid #f1f2f3; padding-top: 8px; margin-top: 2px; line-height: 1.5; }

  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  shadow.appendChild(styleEl);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = `
    <div class="btn no-sub" title="点击复制当前视频字幕；右键切换默认设置">
      <div class="main">字幕</div>
      <div class="sub">复制</div>
      <div class="ai-dot">AI</div>
      <div class="update-dot">↑</div>
    </div>
  `;
  shadow.appendChild(wrap);

  const toast = document.createElement('div');
  toast.className = 'toast';
  shadow.appendChild(toast);

  // 下载进度条（下载视频时显示）
  const dlp = document.createElement('div');
  dlp.className = 'dlp';
  dlp.innerHTML = `
    <div class="dlp-title">下载视频</div>
    <div class="dlp-bar"><div class="dlp-fill"></div></div>
    <div class="dlp-meta">
      <div class="dlp-text">准备中…</div>
      <div class="dlp-pct">0%</div>
    </div>
  `;
  shadow.appendChild(dlp);
  const dlpFill = dlp.querySelector('.dlp-fill');
  const dlpText = dlp.querySelector('.dlp-text');
  const dlpPct = dlp.querySelector('.dlp-pct');
  let dlpTimer = null;

  function showDlp() {
    dlp.classList.add('show');
    positionDlp();
    dlpFill.style.width = '0%';
    dlpText.textContent = '正在获取视频地址…';
    dlpPct.textContent = '0%';
  }
  function updateDlp(pct, text) {
    dlpFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    dlpPct.textContent = Math.round(pct) + '%';
    if (text) dlpText.textContent = text;
  }
  // 拉流阶段进度：优先显示"分片 x/N"，总量未知时显示已下载 MB
  function formatDlpText(msg) {
    const segInfo = (msg.segDone && msg.segCount) ? `分片 ${msg.segDone}/${msg.segCount}` : '';
    const mb = (Number(msg.received) || 0) / 1024 / 1024;
    const mbText = mb >= 0.01 ? ` · ${mb.toFixed(1)}MB` : '';
    if (msg.phase === 'save') {
      if (msg.state === 'complete') return '文件已保存 ✓';
      return '正在写入磁盘…' + (mb > 0 ? ` ${mb.toFixed(1)}MB` : '');
    }
    if (segInfo) return `正在拉取视频流（${segInfo}${mbText}）`;
    if (mb > 0) return `正在拉取视频流…${mbText}`;
    return '正在拉取视频流…';
  }
  function hideDlp() {
    dlp.classList.remove('show');
    clearTimeout(dlpTimer);
    dlpTimer = setTimeout(() => { dlpFill.style.width = '0%'; }, 400);
  }
  function positionDlp() {
    const r = wrap.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - 320);
    dlp.style.left = left + 'px';
    dlp.style.top = (r.bottom + 10) + 'px';
  }

  // 接收 background 转发的下载进度（拉流阶段 + 落盘阶段）
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'DOWNLOAD_PROGRESS') return undefined;
    const total = Number(msg.total) || 0;
    const received = Number(msg.received) || 0;
    const pct = total > 0 ? (received / total) * 100 : 0;
    updateDlp(pct, formatDlpText(msg));
    return undefined;
  });

  // ===================== 控制面板（右键悬浮按钮弹出） =====================
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="p-head">
      <span class="p-status">有字幕</span>
      <span class="p-bv"></span>
      <button class="p-close" title="关闭">×</button>
    </div>
    <div class="p-title"></div>
    <div class="p-actions">
      <button class="p-copy">复制字幕</button>
      <button class="p-dl">下载视频</button>
    </div>
    <div class="p-group">
      <div class="p-label">复制格式</div>
      <div class="seg" data-seg="mode">
        <button data-v="text">纯文本</button>
        <button data-v="ts">带时间戳</button>
        <button data-v="srt">SRT 格式</button>
      </div>
    </div>
    <div class="p-row">
      <span class="p-label">发送到右侧 AI</span>
      <span class="switch" data-switch="ai"><span class="knob"></span></span>
    </div>
    <div class="p-row">
      <span class="p-label">AI 模型</span>
      <div class="dd" data-dd="aiSite">
        <button class="dd-trigger" type="button"><span class="dd-text"></span><span class="dd-caret">▾</span></button>
        <div class="dd-list" hidden></div>
      </div>
    </div>
    <div class="p-row">
      <span class="p-label">AI 对话标签</span>
      <div class="dd" data-dd="convo">
        <button class="dd-trigger" type="button"><span class="dd-text"></span><span class="dd-caret">▾</span></button>
        <div class="dd-list" hidden></div>
      </div>
    </div>
    <div class="p-row">
      <span class="p-label">字幕语言</span>
      <div class="dd" data-dd="lan">
        <button class="dd-trigger" type="button"><span class="dd-text"></span><span class="dd-caret">▾</span></button>
        <div class="dd-list" hidden></div>
      </div>
    </div>
    <div class="p-row">
      <span class="p-label">下载清晰度</span>
      <div class="dd" data-dd="qn">
        <button class="dd-trigger" type="button"><span class="dd-text"></span><span class="dd-caret">▾</span></button>
        <div class="dd-list" hidden></div>
      </div>
    </div>
    <div class="p-row">
      <span class="p-label">下载位置</span>
      <div class="dd" data-dd="dlSave">
        <button class="dd-trigger" type="button"><span class="dd-text"></span><span class="dd-caret">▾</span></button>
        <div class="dd-list" hidden></div>
      </div>
    </div>
    <div class="p-row">
      <span class="p-label">分析提示词</span>
      <button class="p-manage">管理</button>
      <div class="dd" data-dd="prompt">
        <button class="dd-trigger" type="button"><span class="dd-text"></span><span class="dd-caret">▾</span></button>
        <div class="dd-list" hidden></div>
      </div>
    </div>
    <div class="p-group p-update">
      <span class="p-update-status">
        <span class="p-update-dot"></span>
        <span class="p-update-ver"></span>
      </span>
      <button class="p-check-update" type="button">检查更新</button>
      <button class="p-dl-update" type="button" hidden>下载更新</button>
    </div>
    <div class="p-foot">设置保存在本机浏览器，修改后立即对所有 B 站页面生效</div>
  `;
  shadow.appendChild(panel);

  const pStatus = panel.querySelector('.p-status');
  const pBv = panel.querySelector('.p-bv');
  const pTitle = panel.querySelector('.p-title');
  const pCopy = panel.querySelector('.p-copy');
  const pDl = panel.querySelector('.p-dl');
  const pClose = panel.querySelector('.p-close');
  const segMode = panel.querySelector('[data-seg="mode"]');
  const ddConvo = panel.querySelector('[data-dd="convo"]');
  const switchAi = panel.querySelector('[data-switch="ai"]');
  const ddAiSite = panel.querySelector('[data-dd="aiSite"]');
  const ddLan = panel.querySelector('[data-dd="lan"]');
  const ddQn = panel.querySelector('[data-dd="qn"]');
  const ddDlSave = panel.querySelector('[data-dd="dlSave"]');
  const ddPrompt = panel.querySelector('[data-dd="prompt"]');

  function closeAllDropdowns() {
    panel.querySelectorAll('.dd.open').forEach((d) => {
      d.classList.remove('open');
      const l = d.querySelector('.dd-list'); if (l) l.hidden = true;
    });
  }
  function setupDropdown(ddEl, opts) {
    const trigger = ddEl.querySelector('.dd-trigger');
    const textEl = ddEl.querySelector('.dd-text');
    const listEl = ddEl.querySelector('.dd-list');
    function render() {
      const options = opts.getOptions();
      const cur = String(opts.get());
      // 内容签名：选项 + 当前选中。未变化时跳过重建，避免下拉打开时反复重绘导致选项抖动
      const sig = cur + '::' + options.map((o) => String(o.value) + '=' + o.label).join('&');
      if (sig === render._sig && listEl.childElementCount) return;
      render._sig = sig;
      listEl.innerHTML = options.map((o) =>
        `<div class="dd-item${String(o.value) === cur ? ' active' : ''}" data-v="${escapeHtml(String(o.value))}">${escapeHtml(o.label)}</div>`
      ).join('');
      const curOpt = options.find((o) => String(o.value) === cur);
      textEl.textContent = curOpt ? curOpt.label : '';
    }
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !ddEl.classList.contains('open');
      closeAllDropdowns();
      if (willOpen) { render(); ddEl.classList.add('open'); listEl.hidden = false; }
    });
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.dd-item');
      if (!item) return;
      e.stopPropagation();
      const v = item.getAttribute('data-v');
      opts.set(v);
      closeAllDropdowns();
      if (opts.onChange) opts.onChange(v);
    });
    return { render, set: (v) => { opts.set(v); render(); } };
  }
  const aiSiteDd = setupDropdown(ddAiSite, {
    getOptions: () => (window.getAiSites ? window.getAiSites() : []).map((s) => ({ value: s.host, label: s.name })),
    get: () => getAiSite(), set: (v) => setAiSite(v),
    onChange: () => { updateModeUI(); showToast('AI 模型已选择：' + aiSiteName(getAiSite()), 'ok'); }
  });
  const lanDd = setupDropdown(ddLan, {
    getOptions: () => {
      const arr = [{ value: 'auto', label: '自动（中→英→其他）' }];
      Object.keys(lanDocCache).forEach((k) => arr.push({ value: k, label: lanDocCache[k] }));
      return arr;
    },
    get: () => subLan, set: (v) => setLan(v, lanDocCache[v]),
    onChange: () => { updateModeUI(); showToast('字幕语言已设为：' + (subLan === 'auto' ? '自动' : (lanDocCache[subLan] || subLan)), 'ok'); }
  });
  const qnDd = setupDropdown(ddQn, {
    getOptions: () => [16, 32, 64, 80].map((q) => ({ value: String(q), label: QN_LABEL[q] || String(q) })),
    get: () => String(getQn()), set: (v) => setQn(v),
    onChange: () => { updateModeUI(); showToast('下载清晰度已设为：' + (QN_LABEL[getQn()] || getQn()), 'ok'); }
  });
  const dlSaveDd = setupDropdown(ddDlSave, {
    getOptions: () => [
      { value: 'ask', label: '每次询问我保存位置' },
      { value: 'default', label: '默认下载文件夹' }
    ],
    get: () => getDlSaveMode(), set: (v) => setDlSaveMode(v),
    onChange: () => { updateModeUI(); showToast('下载位置已设为：' + (getDlSaveMode() === 'ask' ? '每次询问我保存位置' : '默认下载文件夹'), 'ok'); }
  });
  const promptDd = setupDropdown(ddPrompt, {
    getOptions: () => [
      { value: '__none__', label: '不使用提示词' },
      ...prompts.map((p) => ({ value: p.id, label: p.name }))
    ],
    get: () => (getActivePrompt() ? getActivePrompt().id : '__none__'),
    set: (v) => setActivePrompt(v),
    onChange: () => { updateModeUI(); showToast('已切换分析提示词：' + (getActivePrompt() ? getActivePrompt().name : '不使用提示词'), 'ok'); }
  });
  const convoDd = setupDropdown(ddConvo, {
    getOptions: () => [
      { value: 'new', label: '新建对话' },
      { value: 'reuse', label: '沿用对话' }
    ],
    get: () => getConvoMode(), set: (v) => setConvoMode(v),
    onChange: () => { updateModeUI(); showToast('AI 对话标签：' + (getConvoMode() === 'new' ? '新建对话' : '沿用对话'), 'ok'); }
  });
  const pManage = panel.querySelector('.p-manage');

  // ===================== GitHub 更新检测 UI（基于仓库 version.json） =====================
  const pUpdate = panel.querySelector('.p-update');
  const pUpdateDot = panel.querySelector('.p-update-dot');
  const pUpdateVer = panel.querySelector('.p-update-ver');
  const updateDot = wrap.querySelector('.update-dot');
  const pCheckUpdate = panel.querySelector('.p-check-update');
  const pDlUpdate = panel.querySelector('.p-dl-update');

  function showUpdateDot(on) {
    if (updateDot) updateDot.classList.toggle('on', !!on);
  }
  // 更新行状态机：checking / uptodate / available / error
  function setUpdateState(state, info) {
    if (!pUpdate) return;
    pUpdate.classList.remove('state-checking', 'state-uptodate', 'state-available', 'state-error');
    pUpdate.classList.add('state-' + state);
    const cur = info && info.current ? String(info.current) : '';
    const latest = info && info.latest ? String(info.latest) : cur;
    let ver = '';
    if (state === 'checking') ver = '检查中…';
    else if (state === 'error') ver = '检查失败';
    else if (state === 'available' && cur && latest && cur !== latest) ver = '发现新版本 v' + cur + ' → v' + latest;
    else if (state === 'available') ver = '发现新版本 v' + latest;
    else if (cur) ver = '已是最新 v' + cur;
    if (pUpdateVer) pUpdateVer.textContent = ver;
    if (pCheckUpdate) {
      if (state === 'available') { pCheckUpdate.hidden = true; }
      else {
        pCheckUpdate.hidden = false;
        pCheckUpdate.disabled = (state === 'checking');
        pCheckUpdate.textContent = state === 'checking' ? '检查中…' : (state === 'error' ? '重试' : '检查更新');
      }
    }
    if (pDlUpdate) pDlUpdate.hidden = (state !== 'available');
    showUpdateDot(!!(info && info.updateAvailable));
  }
  function renderUpdateInfo(info) {
    if (!info) { setUpdateState('uptodate', { current: '' }); return; }
    if (info.updateAvailable) setUpdateState('available', info);
    else if (info.error) setUpdateState('error', info);
    else setUpdateState('uptodate', info);
  }
  function getStoredUpdate() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['biliAiSummaryUpdateInfo'], (r) => resolve(r && r.biliAiSummaryUpdateInfo ? r.biliAiSummaryUpdateInfo : null));
      } catch (e) { resolve(null); }
    });
  }
  async function refreshUpdatePanel(fresh) {
    try {
      if (fresh) {
        const res = await sendMessage({ type: 'CHECK_UPDATE' }, 20000);
        if (res && res.ok) renderUpdateInfo(res.result);
        else renderUpdateInfo(await getStoredUpdate());
      } else {
        renderUpdateInfo(await getStoredUpdate());
      }
    } catch (e) { /* ignore */ }
  }
  if (pCheckUpdate) pCheckUpdate.addEventListener('click', async (e) => {
    e.stopPropagation();
    const before = await getStoredUpdate();
    setUpdateState('checking', before);
    await refreshUpdatePanel(true);
    const info = await getStoredUpdate();
    if (info && info.updateAvailable) showToast('发现新版本 ' + info.latest + '，可点击「下载更新」', 'ok');
    else showToast(info && info.error ? ('更新检查失败：' + info.error) : '已是最新版本', info && info.error ? 'warn' : 'ok');
  });
  if (pDlUpdate) pDlUpdate.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const res = await sendMessage({ type: 'DOWNLOAD_UPDATE' }, 20000);
      if (res && res.ok) showToast('已开始下载更新包，解压覆盖原文件夹后到 chrome://extensions 点「重新加载」', 'ok');
      else showToast('下载更新失败：' + ((res && res.error) || '未知错误'), 'warn');
    } catch (err) { showToast('下载更新失败：' + (err && err.message ? err.message : err), 'warn'); }
  });

  let panelOpen = false;
  function positionPanel(x, y) {
    const pw = panel.offsetWidth || 320;
    const ph = panel.offsetHeight || 480;
    let left = (x != null) ? x : (wrap.getBoundingClientRect().left);
    let top = (y != null) ? y : (wrap.getBoundingClientRect().bottom + 10);
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }
  function openControlPanel(x, y) {
    fillAiSiteOptions();
    fillLangOptions();
    const info = getVideoInfo();
    pBv.textContent = info.bvid || '非视频页';
    pTitle.textContent = info.bvid ? (document.title || '视频页') : '请在 B 站视频页使用';
    updateModeUI();
    refreshUpdatePanel(false);
    positionPanel(x, y);
    panel.classList.add('show');
    panelOpen = true;
  }
  function hidePanel() { panel.classList.remove('show'); panelOpen = false; }
  document.addEventListener('click', (e) => {
    const inShadow = e.composedPath().includes(host); // 点击是否发生在本扩展 Shadow DOM 内部（规避 retargeting 误判）
    if (panelOpen && !inShadow) hidePanel();
    closeAllDropdowns();
  });

  const btn = wrap.querySelector('.btn');
  const btnMain = btn.querySelector('.main');
  const btnSub = btn.querySelector('.sub');

  let toastTimer = null;
  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = 'toast show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2600);
  }

  function positionToast() {
    const r = wrap.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - 340);
    toast.style.left = left + 'px';
    toast.style.top = (r.bottom + 10) + 'px';
  }

  function updateModeUI() {
    segMode.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.getAttribute('data-v') === getMode()));
    if (convoDd) convoDd.render();
    switchAi.classList.toggle('on', getAiEnabled());
    if (aiSiteDd) aiSiteDd.render();
    if (lanDd) lanDd.render();
    if (qnDd) qnDd.render();
    if (dlSaveDd) dlSaveDd.render();
    if (promptDd) promptDd.render();
    const noSub = btn.classList.contains('no-sub');
    pStatus.textContent = noSub ? '无字幕' : '有字幕';
    pStatus.classList.toggle('no', noSub);
    const dot = btn.querySelector('.ai-dot');
    if (dot) dot.classList.toggle('on', getAiEnabled());
    btnSub.textContent = MODE_LABEL[getMode()] || '复制';
    btn.title = getAiEnabled()
      ? '点击复制字幕并自动发送到默认AI对话模型标签页；右键切换默认设置'
      : '点击复制当前视频字幕；右键切换默认设置';
  }

  // 记录已见过的语言 doc，便于主菜单显示友好标签
  let lanDocCache = {};

  function fillAiSiteOptions() { if (aiSiteDd) aiSiteDd.render(); }
  async function fillLangOptions() {
    const info = getVideoInfo();
    if (info.bvid) {
      try {
        const res = await sendMessage({ type: 'GET_SUBTITLE_LANGS', info: { bvid: info.bvid }, aiAllowed: true }, 30000);
        if (res && res.ok && Array.isArray(res.result)) {
          lanDocCache = {};
          res.result.forEach((l) => {
            lanDocCache[String(l.lan)] = l.lan_doc || l.lan;
          });
          try { chrome.storage.local.set({ [LAN_DOC_KEY]: lanDocCache }); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* 读取失败则仅保留“自动”项 */ }
    }
    if (lanDd) lanDd.render();
  }

  pCopy.addEventListener('click', async (e) => { e.stopPropagation(); hidePanel(); await onMainClick(); });
  pDl.addEventListener('click', async (e) => { e.stopPropagation(); hidePanel(); await onDownloadVideo(); });
  pClose.addEventListener('click', (e) => { e.stopPropagation(); hidePanel(); });

  segMode.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    setMode(b.getAttribute('data-v')); updateModeUI();
    showToast(`复制格式已切换为：${MODE_LABEL[getMode()]}`, 'ok');
  }));
  // AI 对话标签下拉：由 convoDd (setupDropdown) 统一处理选项点击，无需单独绑定
  switchAi.addEventListener('click', (e) => {
    e.stopPropagation();
    setAiEnabled(!getAiEnabled()); updateModeUI();
    showToast('发送到右侧 AI：' + (getAiEnabled() ? '已开启' : '已关闭'), 'ok');
  });
  pManage.addEventListener('click', (e) => { e.stopPropagation(); hidePanel(); openSettings(); });

  function openSettings() {
    const fallback = () => {
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS_PAGE' }, (r) => {
        if (!r || !r.ok) showToast('无法打开设置页', 'err');
      });
    };
    try {
      chrome.runtime.openOptionsPage(() => {
        if (chrome.runtime.lastError) fallback();
      });
    } catch (err) {
      fallback();
    }
  }


  async function onDownloadVideo() {
    const info = getVideoInfo();
    if (!info.bvid) {
      showToast('未识别到视频（仅支持单个视频页）', 'warn');
      return;
    }
    hidePanel();
    showDlp();
    positionDlp();

    // 决定保存方式：'ask' = 每次弹出系统保存对话框（用户自选位置）；'default' = 浏览器默认下载文件夹
    let saveMode = getDlSaveMode();
    pendingSaveHandle = null;
    const qn = getQn();
    const suggested = sanitizeName(document.title || 'bilibili视频') + '_' + (QN_LABEL[qn] || qn) + '.mp4';
    console.log('[字幕助手] ▶ 进入下载流程（新代码已生效） qn=' + qn + ' 保存方式=' + saveMode + ' 文件名=' + suggested);
    if (saveMode === 'ask') {
      // 文件选择器需要「用户手势 + 顶层安全上下文」，必须在点击时下手
      const supportsFs = ('showSaveFilePicker' in window) &&
        (function () { try { return window.self === window.top; } catch (e) { return false; } })();
      if (!supportsFs) {
        saveMode = 'default';
        showToast('当前环境不支持选择保存位置，将保存到默认下载文件夹', 'warn');
      } else {
        try {
          pendingSaveHandle = await window.showSaveFilePicker({ suggestedName: suggested });
        } catch (e) {
          if (e && e.name === 'AbortError') { hideDlp(); showToast('已取消下载', 'warn'); return; }
          // 其它错误（如权限被拒）→ 退回默认文件夹
          saveMode = 'default';
          pendingSaveHandle = null;
          showToast('无法打开保存对话框，将保存到默认下载文件夹', 'warn');
        }
      }
    }

    // 统一走端口：后台→离屏页拉流，拉到的视频字节回传本页落盘。
    //  - ask    模式：pendingSaveHandle 非空，本页用该句柄写到你选的位置；
    //  - default 模式：pendingSaveHandle 为空，本页用锚点下载到默认下载文件夹。
    // 关键：字节在本页(renderer)落盘，离屏页只负责拉流，彻底规避离屏页写盘 0 字节问题。
    try {
      dlPort = chrome.runtime.connect({ name: 'bili-dl-port' });
      dlPort.onMessage.addListener(handleDlPort);
      dlPort.postMessage({
        type: 'START',
        requestId: 'dl-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
        info,
        qn,
        filename: suggested
      });
      // 结果由端口异步回报（handleDlPort 处理进度、写盘与完成提示）
      // 看门狗：30s 内若后台/离屏页无任何回传（连 ACK 都没有），多半是扩展未重载到新代码
      if (dlWatchdogTimer) clearTimeout(dlWatchdogTimer);
      dlWatchdogTimer = setTimeout(() => {
        try {
          if (dlChunks === null && dlPort) {
            hideDlp();
            showToast('下载无响应：请先到扩展管理页「重新加载」本扩展，再按 F5 刷新B站视频页后重试', 'err');
          }
        } catch (e) { /* ignore */ }
      }, 30000);
    } catch (e) {
      hideDlp();
      showToast('下载通道不可用：' + ((e && e.message) || e), 'err');
      pendingSaveHandle = null;
    }
  }

  /** 处理下载端口回传的消息：进度 / 视频字节分片 / 完成 */
  function handleDlPort(m) {
    // 任意回传都清除看门狗（证明后台/离屏页在正常工作）
    if (dlWatchdogTimer) { clearTimeout(dlWatchdogTimer); dlWatchdogTimer = null; }
    if (!m) return;
    if (m.type === 'DL_ACK') {
      console.log('[字幕助手] 后台已收到下载请求（新代码生效），开始解析视频地址…');
      return;
    }
    if (m.type === 'DL_INFO') {
      console.log('[字幕助手] 后台解析完成：清晰度=' + (m.qualityLabel || m.quality || '?') + ' 分片数=' + (m.segCount || '?') + ' 文件名=' + (m.filename || ''));
      if (m.acceptQn && m.acceptQn.length) console.log('[字幕助手] 可用清晰度列表 accept_quality=' + m.acceptQn.join(','));
      if (m.hasDash) console.log('[字幕助手] DASH 格式可用（1080p+ 在 DASH 内，音视频分离）');
      if (m.note) console.log('[字幕助手] 提示：' + m.note);
      if (dlpText) dlpText.textContent = '已解析 ' + (m.qualityLabel || '') + '，开始拉流…';
      return;
    }
    if (m.type === 'DL_LOG') {
      console.log('[字幕助手] ' + (m.text || ''));
      return;
    }
    if (m.type === 'PROGRESS') {
      const total = Number(m.total) || 0;
      const received = Number(m.received) || 0;
      const pct = total > 0 ? (received / total) * 100 : 0;
      updateDlp(pct, formatDlpText(m));
      return;
    }
    if (m.type === 'DL_CHUNK') {
      // 收集离屏页回传的视频字节分片（base64 文本，解码为 Uint8Array）
      if (!dlChunks) dlChunks = { filename: m.filename, count: m.count, parts: new Array(m.count), received: 0 };
      try {
        const bin = atob(m.b64);
        const arr = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
        dlChunks.parts[m.index] = arr;
      } catch (e) {
        console.error('[字幕助手] 分片 base64 解码失败 index=' + m.index, e);
      }
      dlChunks.received++;
      if (dlpText) dlpText.textContent = '正在接收视频数据… (' + dlChunks.received + '/' + dlChunks.count + ')';
      // 每收到约 10% 打个点，便于判断分片是否真正在传输
      if (dlChunks.received === 1 || dlChunks.received % Math.max(1, Math.floor(dlChunks.count / 10)) === 0 || dlChunks.received === dlChunks.count) {
        console.log('[字幕助手] 接收分片进度 ' + dlChunks.received + '/' + dlChunks.count);
      }
      if (dlChunks.received === dlChunks.count) {
        // 全部到齐 → 按索引顺序拼接成完整视频字节
        let total = 0;
        for (let i = 0; i < dlChunks.count; i++) total += (dlChunks.parts[i] ? dlChunks.parts[i].length : 0);
        const all = new Uint8Array(total);
        let off = 0;
        for (let i = 0; i < dlChunks.count; i++) {
          const part = dlChunks.parts[i];
          if (!part) { console.error('[字幕助手] 视频分片缺失 index=' + i); continue; }
          all.set(part, off);
          off += part.length;
        }
        const handle = pendingSaveHandle;
        pendingSaveHandle = null;
        const fname = dlChunks.filename;
        dlChunks = null;
        console.log('[字幕助手] 收齐视频字节，总长度=' + all.byteLength);
        writeDlBytes(all, handle, fname);
      }
      return;
    }
    if (m.type === 'DL_END') {
      // 诊断：明确离屏页到底拉到了多少字节（fetchedBytes），与本地收齐长度对照，定位 0 字节根因
      if (m.fetchedBytes != null) {
        console.log('[字幕助手] 离屏页 fetchedBytes=' + m.fetchedBytes + '，本地已收到分片=' + (dlChunks ? dlChunks.received : 0));
      }
      if (!m.ok) {
        hideDlp();
        showToast('下载失败：' + (m.error || '拉流失败'), 'err');
        dlChunks = null;
        if (dlPort) { try { dlPort.disconnect(); } catch (e) { /* ignore */ } dlPort = null; }
      } else if (dlChunks && dlChunks.received < dlChunks.count) {
        // offscreen 已经发完 DL_END，但页面还有分片没到：端口丢包了
        hideDlp();
        showToast('下载失败：视频分片在传输中丢失（收到 ' + dlChunks.received + '/' + dlChunks.count + '），请换较低清晰度重试', 'err');
        console.error('[字幕助手] DL_END 提前到达，分片未收齐', dlChunks.received, '/', dlChunks.count);
        dlChunks = null;
        if (dlPort) { try { dlPort.disconnect(); } catch (e) { /* ignore */ } dlPort = null; }
      }
      // ok 且分片已收齐时，写盘已在收齐分片时(writeDlBytes)完成，这里无需重复处理
      return;
    }
  }

  /** 把拼接好的视频字节落盘：ask 模式用用户选中的文件句柄，default 模式用锚点下载到默认文件夹 */
  async function writeDlBytes(all, handle, fname) {
    // 防御：0 字节不落盘，避免产生无用的 0 字节文件，并给出明确提示（旧代码才会收到 0 字节）
    if (!all || all.byteLength === 0) {
      hideDlp();
      showToast('收到 0 字节视频，下载未成功：请确认扩展已「重新加载」到最新版（旧版会出现此 0 字节问题），再按 F5 刷新本页重试', 'err');
      console.error('[字幕助手] 收齐的视频字节为 0，已拒绝写入 0 字节文件');
      if (dlPort) { try { dlPort.disconnect(); } catch (e2) { /* ignore */ } dlPort = null; }
      return;
    }
    try {
      if (dlpText) dlpText.textContent = '正在写入文件…';
      if (handle) {
        // 普通渲染进程(renderer) 的 File System Access 写盘最可靠，不会再出现 0 字节
        const writable = await handle.createWritable();
        await writable.write(all);
        await writable.close();
        hideDlp();
        showToast('已保存：' + (handle.name || fname), 'ok');
        console.log('[字幕助手] 写盘完成，字节数=' + all.byteLength);
      } else {
        fallbackAnchorDownload(all, fname);
        hideDlp();
        showToast('已保存到默认下载文件夹：' + (fname || ''), 'ok');
      }
    } catch (e) {
      hideDlp();
      showToast('保存失败：' + ((e && e.message) || e), 'err');
      console.error('[字幕助手] 写盘失败', e);
    }
    if (dlPort) { try { dlPort.disconnect(); } catch (e2) { /* ignore */ } dlPort = null; }
  }

  // 兜底：仅在异常时触发（default 模式本由离屏页直接下载）。在页面内用锚点下载字节。
  function fallbackAnchorDownload(ab, filename) {
    try {
      const blob = new Blob([ab], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'video.mp4';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 60000);
    } catch (e) { /* ignore */ }
  }

  // 下载落盘最终态：default 模式由离屏页锚点下载完成后经 background 转发而来。
  // ask 模式的最终态由端口(handleDlPort)处理，不走这条 onMessage。
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'DOWNLOAD_DONE') return undefined;
    hideDlp();
    if (msg.ok) {
      const name = msg.filename ? msg.filename.split('/').pop() : '';
      showToast(name ? ('已保存：' + name) : '文件已保存 ✓', 'ok');
    } else {
      showToast('下载失败：' + (msg.error || '保存被中断'), 'err');
    }
    return undefined;
  });

  // 拖拽 & 点击：仅主键(左键)进入拖拽/点击判定；右键只弹菜单，绝不触发复制
  let dragging = false, moved = false, startX = 0, startY = 0, origX = 0, origY = 0;
  function loadPos() {
    try {
      // 旧键迁移：biliSubtitleCopyPos → biliAiSummaryCopyPos
      const oldRaw = localStorage.getItem('biliSubtitleCopyPos');
      if (oldRaw) {
        localStorage.setItem('biliAiSummaryCopyPos', oldRaw);
        localStorage.removeItem('biliSubtitleCopyPos');
      }
      const raw = localStorage.getItem('biliAiSummaryCopyPos');
      if (raw) {
        const p = JSON.parse(raw);
        wrap.style.left = p.x + 'px';
        wrap.style.top = p.y + 'px';
        return;
      }
    } catch (e) { /* ignore */ }
    wrap.style.right = '24px';
    wrap.style.top = '140px';
  }
  function savePos() {
    const r = wrap.getBoundingClientRect();
    try { localStorage.setItem('biliAiSummaryCopyPos', JSON.stringify({ x: r.left, y: r.top })); } catch (e) { /* ignore */ }
  }
  function normalizePos() {
    const r = wrap.getBoundingClientRect();
    const x = Math.min(Math.max(0, r.left), window.innerWidth - r.width);
    const y = Math.min(Math.max(0, r.top), window.innerHeight - r.height);
    if (x !== r.left || y !== r.top) {
      wrap.style.left = x + 'px';
      wrap.style.top = y + 'px';
    }
  }

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    const r = wrap.getBoundingClientRect();
    origX = r.left; origY = r.top;
    btn.setPointerCapture(e.pointerId);
    hidePanel();
  });
  btn.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (moved) {
      wrap.style.left = (origX + dx) + 'px';
      wrap.style.top = (origY + dy) + 'px';
    }
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (moved) { savePos(); normalizePos(); }
    else { onMainClick(); }
  }
  btn.addEventListener('pointerup', (e) => {
    if (e.button === 0) endDrag(e);
    else dragging = false;
  });
  btn.addEventListener('pointercancel', () => { dragging = false; });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = false; // 兜底：右键绝不触发点击
    openControlPanel(e.clientX, e.clientY);
  });
  // 键盘/无障碍触发
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMainClick(); } });
  btn.setAttribute('tabindex', '0');
  btn.setAttribute('role', 'button');

  // ===================== 焦点管理：切回标签页后恢复视频空格控制 =====================
  function focusVideoPlayer() {
    const vids = document.querySelectorAll('video');
    if (!vids.length) return;
    let target = null;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.width > 50 && r.height > 50) { target = v; break; }
    }
    if (!target) target = vids[0];
    try {
      if (target.tabIndex < 0) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    } catch (e) { /* ignore */ }
  }

  let focusRetryTimer = null;
  function onTabReturned() {
    clearTimeout(focusRetryTimer);
    [120, 350, 800].forEach((ms) => {
      focusRetryTimer = setTimeout(focusVideoPlayer, ms);
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) onTabReturned();
  });
  window.addEventListener('focus', onTabReturned);

  // ===================== 主流程 =====================
  async function onMainClick() {
    try { btn.blur(); } catch (e) { /* ignore */ }
    hidePanel();

    const info = getVideoInfo();
    if (!info.bvid) {
      showToast('视频无字幕或识别失败，请刷新重试', 'warn');
      return;
    }

    // 点击时实时复检：用与后续抓取「同一时刻 URL」查询当前视频字幕列表。
    // 闸门与抓取同源，可避免「指示器灰度滞后」造成的「灰了却仍抓取/跳 AI」。
    // 无字幕则只提示、不复制、不发送、不跳 AI；有字幕再继续完整流程。
    showToast('正在检测字幕…');
    positionToast();
    // 以「播放器实际展示」为准：仅当播放器字幕菜单里出现 AI 字幕项时，AI 字幕才算可用。
    // 点击闸门允许自动展开面板兜底（极短暂闪烁可接受）。
    const pi = await getPlayerAiVisible({ allowOpen: true });
    const aiAllowed = pi.ok ? pi.showsAi : false;
    let hasSub = false;
    try {
      const lr = await sendMessage({ type: 'GET_SUBTITLE_LANGS', info: { bvid: info.bvid, cid: info.cid }, aiAllowed }, 30000);
      hasSub = !!(lr && lr.ok && Array.isArray(lr.result) && lr.result.length > 0);
    } catch (e) { /* 检测失败按「无字幕」保守处理 */ }
    if (!hasSub) {
      if (btn) btn.classList.add('no-sub');
      showToast('该视频暂无字幕', 'warn');
      return;
    }
    if (btn) btn.classList.remove('no-sub');

    showToast('正在获取字幕…');
    positionToast();
    try {
      const res = await sendMessage({ type: 'GET_SUBTITLE', info, lan: getLan(), lanDoc: lanDocCache[getLan()] || getLan(), aiAllowed }, 30000);
      if (!res || !res.ok) {
        throw new Error((res && res.error) || '请求失败');
      }
      const result = res.result;
      let text = formatSubs(result.body, getMode());
      if (!text) { showToast('字幕内容为空', 'warn'); return; }
      if (result.title) {
        text = `【${result.title}】\n\n${text}`;
      }
      // AI 发送开启且存在激活提示词时，末尾追加该提示词（复制与发送内容一致）
      if (getAiEnabled()) {
        const ap = getActivePrompt();
        if (ap && ap.text) text = `${text}\n\n${ap.text}`;
      }
      const ok = await copyText(text);
      if (!ok) {
        showToast('复制失败，请手动选择文本', 'err');
        return;
      }
      if (!getAiEnabled()) {
        showToast(`已复制 ${result.body.length} 条字幕（${result.lang} · ${MODE_LABEL[getMode()]}）`, 'ok');
        return;
      }
      showToast(`已复制，正在发送到右侧 AI…（${result.body.length} 条）`, '');
      positionToast();
      try {
        const convoMode = getConvoMode();
        const aiRes = await sendMessage({ type: 'SEND_TO_AI', text, convoMode }, 30000);
        if (aiRes && aiRes.ok) {
          if (aiRes.sent) {
            let where;
            if (aiRes.reused) {
              where = '已发送到已打开的 ' + aiSiteName(aiRes.reused);
            } else if (aiRes.autoOpened) {
              where = (convoMode === 'new' ? '已新建 ' : '已自动打开 ') + aiSiteName(aiRes.autoOpened) + (convoMode === 'new' ? ' 对话并发送' : ' 并发送');
            } else {
              where = '已复制到右侧 AI';
            }
            showToast(`已复制，${where}（${result.body.length} 条 · ${result.lang}）`, 'ok');
          } else {
            showToast(`已复制并填入右侧 AI，请手动按 Enter 发送（${result.body.length} 条）`, 'warn');
          }
        } else {
          showToast('已复制，但发送到 AI 失败：' + ((aiRes && aiRes.error) || '未知错误'), 'warn');
        }
      } catch (e) {
        showToast('已复制，但发送到 AI 失败：' + (e && e.message ? e.message : e), 'warn');
      }
    } catch (e) {
      console.error('[字幕助手]', e);
      showToast('复制失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  // ===================== 无字幕图标灰度指示 =====================
  // 当前页面视频无可用字幕时，给按钮加 .no-sub（灰度）样式，直观提示不可用。
  // 查询失败（未登录/网络异常）按「无字幕」灰显，仅影响指示，不影响点击时的真实报错。
  async function updateSubtitleIndicator() {
    if (!btn) return;
    const info = getVideoInfo();
    if (!info.bvid) { btn.classList.add('no-sub'); return; }
    try {
      // 1) 取完整字幕列表（含 ai-）：
      //    - 空 → 真·无字幕，直接灰显（无需展开面板，无闪烁）
      //    - 含人工字幕 → 必然可用，直接彩色（人工字幕始终展示，无需展开面板）
      const r = await sendMessage({ type: 'GET_SUBTITLE_LANGS', info: { bvid: info.bvid, cid: info.cid }, aiAllowed: true }, 30000);
      const raw = (r && r.ok && Array.isArray(r.result)) ? r.result : [];
      if (raw.length === 0) { btn.classList.add('no-sub'); return; }
      const hasHuman = raw.some((s) => !String(s.lan || '').toLowerCase().startsWith('ai-'));
      if (hasHuman) { btn.classList.remove('no-sub'); return; }
      // 2) 仅含 AI 字幕：先被动探测播放器是否展示（无闪烁）
      let pi = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        pi = await getPlayerAiVisible({ allowOpen: false });
        if (pi && pi.ok) { btn.classList.toggle('no-sub', !pi.showsAi); return; }
        await new Promise((rs) => setTimeout(rs, 700));
      }
      // 3) 被动失败（B 站字幕项默认不渲染进 DOM，需展开过才出现）→ 兜底展开一次读取（极短暂闪烁），读完还原
      pi = await getPlayerAiVisible({ allowOpen: true });
      btn.classList.toggle('no-sub', !(pi && pi.ok && pi.showsAi));
    } catch (e) {
      btn.classList.add('no-sub');
    }
  }

  // ===================== 初始化 =====================
  function init() {
    // 读取模式 / AI 开关 / 提示词 / 语言 / 清晰度
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(
          [STORAGE_KEY, AI_KEY, PROMPTS_KEY, PROMPT_KEY, LAN_KEY, QN_KEY, LAN_DOC_KEY, AI_SITE_KEY, AI_CONVO_KEY],
          (res) => {
            if (res && res[STORAGE_KEY] && MODE_LABEL[res[STORAGE_KEY]]) copyMode = res[STORAGE_KEY];
            if (res && typeof res[AI_KEY] === 'boolean') aiEnabled = res[AI_KEY];
            if (res && Array.isArray(res[PROMPTS_KEY]) && res[PROMPTS_KEY].length) {
              prompts = res[PROMPTS_KEY].map(normPrompt);
            } else if (res && res[PROMPT_KEY] != null) {
              // 迁移：旧版单提示词 → 内置默认项，并清理旧键
              prompts = [{ id: 'builtin-default', name: '默认分析', text: String(res[PROMPT_KEY]), builtin: true, active: true }];
              savePrompts();
              try { chrome.storage.local.remove(PROMPT_KEY); } catch (e) { /* ignore */ }
            }
            if (res && res[LAN_KEY]) subLan = res[LAN_KEY];
            if (res && res[LAN_DOC_KEY] && typeof res[LAN_DOC_KEY] === 'object') lanDocCache = res[LAN_DOC_KEY];
            if (res && res[QN_KEY]) dlQn = String(res[QN_KEY]) === 'auto' ? '64' : String(res[QN_KEY]);
          if (res && res[DL_SAVE_KEY]) dlSaveMode = res[DL_SAVE_KEY] === 'default' ? 'default' : 'ask';
            if (res && res[AI_SITE_KEY]) aiSite = String(res[AI_SITE_KEY]);
            if (res && res[AI_CONVO_KEY]) aiConvoMode = (res[AI_CONVO_KEY] === 'new') ? 'new' : 'reuse';
            updateModeUI();
          }
        );
        // 实时同步设置页 / 其它页面改动
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          if (changes[STORAGE_KEY]) { const v = changes[STORAGE_KEY].newValue; if (v && MODE_LABEL[v]) { copyMode = v; updateModeUI(); } }
          if (changes[AI_KEY]) { aiEnabled = !!changes[AI_KEY].newValue; updateModeUI(); }
          if (changes[PROMPTS_KEY]) {
            const arr = changes[PROMPTS_KEY].newValue;
            if (Array.isArray(arr) && arr.length) prompts = arr.map(normPrompt);
            else prompts = defaultPrompts();
            updateModeUI();
          }
          if (changes[LAN_KEY]) { subLan = changes[LAN_KEY].newValue || 'auto'; updateModeUI(); }
          if (changes[QN_KEY]) {
            const q = String(changes[QN_KEY].newValue || '80');
            dlQn = q === 'auto' ? '64' : q; // 兼容旧版遗留的 'auto' 值（已无对应 UI 选项）
            updateModeUI();
          }
          if (changes[DL_SAVE_KEY]) { dlSaveMode = (changes[DL_SAVE_KEY].newValue === 'default') ? 'default' : 'ask'; updateModeUI(); }
          if (changes[AI_SITE_KEY]) { aiSite = changes[AI_SITE_KEY].newValue || DEFAULT_AI_SITE; updateModeUI(); }
          if (changes[AI_CONVO_KEY]) { aiConvoMode = (changes[AI_CONVO_KEY].newValue === 'new') ? 'new' : 'reuse'; updateModeUI(); }
        });
      }
    } catch (e) { /* ignore */ }

    updateModeUI();
    // 进入页面：有缓存更新信息则直接显示，否则主动检查一次（避免每页重复联网）
    getStoredUpdate().then((info) => {
      if (info) renderUpdateInfo(info);
      else refreshUpdatePanel(true);
    });
    loadPos();
    normalizePos();
    document.body.appendChild(host);

    // 页面加载稳定后（B 站 player/view 接口就绪）首次检测字幕可用性，驱动图标灰度
    setTimeout(updateSubtitleIndicator, 2000);

    // SPA 路由变化（B 站站内跳转）时保持按钮在视口内并重新检测字幕可用性。
    // 改用 history API 拦截 + popstate/hashchange，比每 1.2s 轮询 location.href 更即时、更省 CPU（P2-7）。
    (function hookSpaNav() {
      let lastHref = location.href;
      const fire = () => {
        if (location.href !== lastHref) {
          lastHref = location.href;
          normalizePos();
          updateModeUI();
          updateSubtitleIndicator();
        }
      };
      window.addEventListener('popstate', fire);
      window.addEventListener('hashchange', fire);
      const wrap = (orig) => function () { const r = orig.apply(this, arguments); fire(); return r; };
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    })();
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();

