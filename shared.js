'use strict';
/**
 * B站AI总结助手 - 共享常量与工具
 * 同时被 content.js（content_scripts）、options.js（设置页）与 background.js（service worker，经 importScripts 注入）加载，
 * 避免 DEFAULT_AI_PROMPT / escapeHtml / normPrompt / AI 站点库 在多处重复定义导致漂移。
 * 用 root（window 或 self）挂载，确保 content script 多文件注入、options 页与 SW 都能以裸标识符访问。
 */
(function (root) {
  root.DEFAULT_AI_PROMPT = `【标题或核心是一个问题吗？如果不是，则进入分析环节：【这些文字表示这是在做什么事？以及概括一下内容。只保留最关键的信息但要全，尽量简短、高亮重点、排版方便人看，多用emoji。遇到难懂的概念，可以打比方，也可以用问答的方式帮助理解。如果本文包含数据，则提炼出关键数据并与本文外的相关搜索到的数据进行横向（其他情况）纵向（过去，如果文中的数据是过去的数据则和现在比较）比较。注意非数字数据不要这么分析。然后给出一个总体总结，最后各简单一句话总结一下作者的价值观、立场、目的。】如果标题或核心是一个问题，则进入回答环节：【前面的分析环节全不要，而只回答这个问题，文本包含的和问题无关的（即非论点、分论点、论据的）内容先全省略，然后再告诉我省略的内容是什么。】先告诉我进入哪个环节。注意回答环节不要总结、数据分析、总结立场。】`;

  root.escapeHtml = function (s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  root.normPrompt = function (p) {
    return {
      id: (p && p.id) ? p.id : ('u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
      name: (p && p.name) ? String(p.name) : '未命名提示词',
      text: (p && p.text != null) ? String(p.text) : '',
      builtin: !!(p && p.builtin),
      active: !!(p && p.active)
    };
  };

  // ============ AI 站点库（地址 → 中文名，用于「AI 模型选择」） ============
  // key 为 host，需与 manifest 中 ai-content.js 的 content_scripts.matches 保持一致。
  root.AI_SITE_NAMES = {
    'chatgpt.com': 'ChatGPT',
    'chat.openai.com': 'ChatGPT',
    'claude.ai': 'Claude',
    'gemini.google.com': 'Gemini',
    'aistudio.google.com': 'Gemini（AI Studio）',
    'chat.deepseek.com': 'DeepSeek',
    'kimi.moonshot.cn': 'Kimi',
    'www.kimi.com': 'Kimi',
    'chatglm.cn': '智谱清言（GLM）',
    'www.chatglm.cn': '智谱清言（GLM）',
    'chat.qwen.ai': '通义千问',
    'tongyi.aliyun.com': '通义千问',
    'doubao.com': '豆包',
    'www.doubao.com': '豆包',
    'yiyan.baidu.com': '文心一言',
    'chat.baidu.com': '文心一言',
    'yuanbao.tencent.com': '元宝',
    'grok.com': 'Grok',
    'www.perplexity.ai': 'Perplexity',
    'copilot.microsoft.com': 'Copilot',
    'chat.mistral.ai': 'Mistral'
  };

  /**
   * 返回去重后的 AI 站点库：[{ host, name, url }]
   *  - host：用于匹配 / 打开
   *  - name：中文名（来自地址映射）
   *  - url：打开用的地址（https://host/）
   * 同名站点（manifest 中 www / 非 www 成对）只保留一个代表，避免菜单重复。
   */
  root.getAiSites = function () {
    const seen = new Set();
    const out = [];
    let mf = null;
    try {
      mf = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest() : null;
    } catch (e) { mf = null; }
    const list = (mf && mf.content_scripts) || [];
    for (const cs of list) {
      if (!cs.js || !cs.js.includes('ai-content.js')) continue;
      for (const m of cs.matches || []) {
        let host = '';
        try { host = m.replace(/^\*:\/\//, '').replace(/\/\*$/, ''); } catch (e) { continue; }
        if (!host) continue;
        const name = (root.AI_SITE_NAMES && root.AI_SITE_NAMES[host]) || host;
        if (seen.has(name)) continue; // 同名去重，保留首个
        seen.add(name);
        out.push({ host: host, name: name, url: 'https://' + host + '/' });
      }
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
