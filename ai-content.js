/**
 * B站AI总结助手 - AI 页面 content script
 *
 * 职责：在本页内完成字幕的写入与发送（不使用 chrome.debugger，避免触发调试横幅）。
 * 收到 INJECT_AI_TEXT 消息后，找到聊天输入框，聚焦并把字幕写入，再点击「发送」按钮
 * （兜底派发 Enter）。另响应 FOCUS_AI_INPUT 供 background 聚焦输入框。
 */
(() => {
  'use strict';

  if (window.__biliAiFillLoaded) return;
  window.__biliAiFillLoaded = true;

  // 常见 AI 站点的输入框选择器（按优先级排列）
  const GPT_SELECTORS = ['.ProseMirror[contenteditable="true"]', '#prompt-textarea', '#prompt-input', 'div[contenteditable="true"][role="textbox"]'];
  const HOST_SELECTORS = {
    'chatgpt.com': GPT_SELECTORS,
    'chat.openai.com': GPT_SELECTORS,
    'claude.ai': ['.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
    'gemini.google.com': ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
    'aistudio.google.com': ['.ql-editor[contenteditable="true"]', 'div[contenteditable="true"]'],
    'chat.deepseek.com': ['textarea#chat-input', '#chat-input textarea', '#chat-input [contenteditable="true"]'],
    'kimi.moonshot.cn': ['[data-lexical-editor="true"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
    'chatglm.cn': ['textarea', 'div[contenteditable="true"]'],
    'www.chatglm.cn': ['textarea', 'div[contenteditable="true"]'],
    'www.kimi.com': ['[data-lexical-editor="true"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
    'chat.qwen.ai': ['textarea', 'div[contenteditable="true"]'],
    'tongyi.aliyun.com': ['textarea', 'div[contenteditable="true"]'],
    'www.doubao.com': ['textarea', 'div[contenteditable="true"]'],
    'doubao.com': ['textarea', 'div[contenteditable="true"]'],
    'yiyan.baidu.com': ['textarea', 'div[contenteditable="true"]'],
    'chat.baidu.com': ['textarea', 'div[contenteditable="true"]'],
    'yuanbao.tencent.com': ['textarea', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
    'grok.com': ['textarea', 'div[contenteditable="true"]'],
    'www.perplexity.ai': ['textarea', 'div[contenteditable="true"]'],
    'copilot.microsoft.com': ['div[contenteditable="true"]', 'textarea'],
    'chat.mistral.ai': ['textarea', 'div[contenteditable="true"]']
  };

  // 输入框 placeholder 关键词，用于通用查找时打分
  const PLACEHOLDER_HINTS = ['发送', '输入', '发消息', '提问', '消息', 'send', 'message', 'ask', 'prompt', 'chat', '对话'];

  function hostOf() {
    try { return location.hostname.toLowerCase(); } catch (e) { return ''; }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) === 0) return false;
    return true;
  }

  /** 给候选输入框打分：面积 + placeholder 关键词 + role + 视口底部位置 */
  function score(el) {
    const r = el.getBoundingClientRect();
    let sc = r.width * r.height;
    const ph = String(el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').toLowerCase();
    if (PLACEHOLDER_HINTS.some((k) => ph.includes(k))) sc += 500;
    if (el.getAttribute('role') === 'textbox') sc += 300;
    const vh = window.innerHeight || 0;
    if (r.bottom <= vh && r.bottom > vh * 0.4) sc += 200;
    return sc;
  }

  function rankBest(list) {
    if (!list.length) return null;
    return list.slice().sort((a, b) => score(b) - score(a))[0];
  }

  /** 找到聊天输入框：站点特定选择器 → 通用 textarea → 通用 contenteditable */
  function pickInput() {
    const prefs = HOST_SELECTORS[hostOf()] || [];
    for (const sel of prefs) {
      const el = rankBest(Array.from(document.querySelectorAll(sel)).filter(isVisible));
      if (el) return el;
    }
    const ta = rankBest(Array.from(document.querySelectorAll('textarea')).filter(isVisible));
    if (ta) return ta;
    const ce = rankBest(Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(isVisible));
    return ce;
  }

  /** 解析出真正可编辑的元素：容器 → 下钻找 .ProseMirror / contenteditable 子元素 */
  function resolveEditorElement(el) {
    if (!el) return null;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el;
    if (el.getAttribute('contenteditable') === 'true') return el;
    const inner = el.querySelector('.ProseMirror[contenteditable="true"], [contenteditable="true"]');
    return inner || el;
  }

  /** 聚焦聊天输入框并把光标放到末尾，供 CDP 真实输入使用 */
  function focusEditor() {
    const el = pickInput();
    if (!el) return { ok: false, error: '未找到聊天输入框（页面可能尚未加载完成）' };
    const editor = resolveEditorElement(el);
    if (!editor) return { ok: false, error: '目标元素不可编辑' };

    editor.focus();
    try { editor.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }

    // 光标放到末尾
    try {
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const len = (editor.value || '').length;
        editor.setSelectionRange(len, len);
      } else {
        const sel = window.getSelection();
        if (sel) {
          sel.selectAllChildren(editor);
          sel.collapseToEnd();
        }
      }
    } catch (e) { /* ignore */ }

    return { ok: true };
  }

  // 各 AI 站点的「发送」按钮选择器（按优先级）。兜底用通用选择器。
  const SEND_SELECTORS = {
    'chatgpt.com': ['button[data-testid="send-button"]', 'button[aria-label="Send"]'],
    'chat.openai.com': ['button[data-testid="send-button"]', 'button[aria-label="Send"]'],
    'claude.ai': ['button[aria-label="Send message"]', 'button[aria-label="发送"]'],
    'gemini.google.com': ['button[aria-label="Send message"]', 'button[aria-label="发送"]'],
    'aistudio.google.com': ['button[aria-label="Send message"]', 'button[aria-label="发送"]', 'button.send-button'],
    'chat.deepseek.com': ['button#chat-input-send', 'button[aria-label="发送"]', 'button[data-testid="send"]'],
    'kimi.moonshot.cn': ['button[aria-label="发送"]', 'button[data-testid="send"]'],
    'www.kimi.com': ['button[aria-label="发送"]', 'button[data-testid="send"]'],
    'chatglm.cn': ['button[aria-label="发送"]', 'button.send-btn'],
    'www.chatglm.cn': ['button[aria-label="发送"]', 'button.send-btn'],
    'chat.qwen.ai': ['button[aria-label="发送"]', 'button.send-btn'],
    'tongyi.aliyun.com': ['button[aria-label="发送"]'],
    'www.doubao.com': ['button[aria-label="发送"]'],
    'doubao.com': ['button[aria-label="发送"]'],
    'yiyan.baidu.com': ['button[aria-label="发送"]', 'button.send-btn'],
    'chat.baidu.com': ['button[aria-label="发送"]', 'button.send-btn'],
    'yuanbao.tencent.com': ['button[aria-label="发送"]', 'button.send-btn'],
    'grok.com': ['button[aria-label="Send"]'],
    'www.perplexity.ai': ['button[aria-label="Send"]', 'button[aria-label="发送"]'],
    'copilot.microsoft.com': ['button[aria-label="Send"]'],
    'chat.mistral.ai': ['button[aria-label="Send"]', 'button[aria-label="发送"]']
  };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function resetCaretEnd(editor) {
    try {
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const len = (editor.value || '').length;
        editor.setSelectionRange(len, len);
      } else {
        const sel = window.getSelection();
        if (sel) { sel.selectAllChildren(editor); sel.collapseToEnd(); }
      }
    } catch (e) { /* ignore */ }
  }

  function readLength(editor) {
    return (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT')
      ? (editor.value || '').length
      : (editor.textContent || '').trim().length;
  }

  async function insertAtCaret(editor, text) {
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      try {
        // React 受控组件兼容：用原生 value setter 写入 + 派发 input 事件
        const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(editor, (editor.value || '') + text);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        editor.value = (editor.value || '') + text;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      // contenteditable：用 execCommand 插入（富文本编辑器可识别），无需调试器
      resetCaretEnd(editor);
      try {
        document.execCommand('insertText', false, text);
      } catch (e) {
        // 兜底：直接插入文本节点
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }
  }

  function findSendButton() {
    const prefs = SEND_SELECTORS[hostOf()] || [];
    for (const sel of prefs) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) return btn;
    }
    // 通用兜底：aria-label 含 send/发送、data-testid 含 send、或 type=submit 的按钮
    return document.querySelector(
      'button[aria-label*="send" i], button[aria-label*="发送" i], button[data-testid*="send" i], button[type="submit"]'
    ) || null;
  }

  function clickSend(editor) {
    const btn = findSendButton();
    if (btn) { btn.click(); return true; }
    // 兜底：合成 Enter（多数站点 keydown 监听会响应）
    try {
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    } catch (e) { /* ignore */ }
    return false;
  }

  /**
   * 页面内注入并发送：聚焦输入框 → 分段写入字幕 → 校验 → 点击发送。
   * 全程不使用 chrome.debugger，故不会触发「插件已开始调试此浏览器」横幅。
   */
  async function injectAndSend(text) {
    const el = pickInput();
    if (!el) return { ok: false, error: '未找到聊天输入框（页面可能尚未加载完成）' };
    const editor = resolveEditorElement(el);
    if (!editor) return { ok: false, error: '目标元素不可编辑' };

    editor.focus();
    try { editor.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    resetCaretEnd(editor);

    // 分段写入，避免超大文本一次性插入冻结编辑器
    const CHUNK = 4000;
    for (let i = 0; i < text.length; i += CHUNK) {
      const piece = text.slice(i, i + CHUNK);
      await insertAtCaret(editor, piece);
      if (i + CHUNK < text.length) await sleep(40);
    }

    await sleep(120);
    const len = readLength(editor);
    if (len < Math.floor(text.length * 0.8)) {
      return { ok: false, error: '文本未能完整写入输入框（页面可能无响应）' };
    }

    const sent = clickSend(editor);
    return { ok: true, sent, length: len };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return undefined;
    if (msg.type === 'FOCUS_AI_INPUT') {
      sendResponse(focusEditor());
      return undefined;
    }
    if (msg.type === 'INJECT_AI_TEXT') {
      injectAndSend(msg.text || '').then(sendResponse);
      return true; // 异步处理，保持消息通道打开
    }
    return undefined;
  });
})();
