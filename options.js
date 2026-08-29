/**
 * B站AI总结助手 - 提示词管理页（分析提示词管理）
 *
 * 存储键 biliAiSummaryPrompts：数组 [{ id, name, text, builtin, active }]
 *  - 单选：整组里 0 或 1 条 active=true
 *  - builtin=true 的内置默认项不可删除、不可改名、内容不可编辑，仅可停用/选为当前
 * DEFAULT_AI_PROMPT / escapeHtml / normPrompt 由 shared.js 注入（与 content.js 共享）；
 * 与 content.js 通过 chrome.storage.onChanged 实时同步，无需消息通信。
 */
'use strict';

// 默认分析提示词由 shared.js 注入（与 content.js 共享，避免重复）

const KEYS = {
  prompts: 'biliAiSummaryPrompts',
  legacyPrompt: 'biliAiSummaryAiPrompt' // 旧版单提示词（仅用于迁移）
};

const $ = (id) => document.getElementById(id);
let prompts = []; // 当前编辑中的数组
let isDirty = false; // 是否存在未保存修改
function setDirty(v) {
  isDirty = !!v;
  updateDirtyUI();
  const btn = $('save');
  if (btn) btn.disabled = !isDirty;
}
function updateDirtyUI() {
  const tag = $('dirty');
  if (!tag) return;
  tag.textContent = isDirty ? '● 未保存修改' : '✓ 已保存';
  tag.className = 'dirty-tag ' + (isDirty ? 'dirty' : 'clean');
}

function defaultPrompts() {
  return [{ id: 'builtin-default', name: '默认分析', text: DEFAULT_AI_PROMPT, builtin: true, active: true }];
}
function uid() { return 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

// normPrompt / escapeHtml 由 shared.js 注入（与 content.js 共享，避免重复）

function load() {
  chrome.storage.local.get([KEYS.prompts, KEYS.legacyPrompt], (res) => {
    if (res && Array.isArray(res[KEYS.prompts]) && res[KEYS.prompts].length) {
      prompts = res[KEYS.prompts].map(normPrompt);
    } else if (res && res[KEYS.legacyPrompt] != null) {
      // 兼容旧版单提示词 → 内置默认项，并清理旧键
      prompts = [{ id: 'builtin-default', name: '默认分析', text: String(res[KEYS.legacyPrompt]), builtin: true, active: true }];
      try { chrome.storage.local.remove(KEYS.legacyPrompt); } catch (e) { /* ignore */ }
    } else {
      prompts = defaultPrompts();
    }
    render();
    setDirty(false);
  });
}

function render() {
  const box = $('prompts');
  box.innerHTML = '';
  prompts.forEach((p) => {
    const card = document.createElement('div');
    const locked = !!p.builtin;
    card.className = 'pcard' + (locked ? ' locked' : '') + (p.active ? ' active' : '');
    const lockedAttr = locked ? ' disabled' : '';
    const badge = p.active ? '<span class="badge">当前生效</span>' : '';
    const lockLabel = locked ? '<span class="plock">内置 · 不可编辑</span>' : '';
    const del = locked ? '' : '<button class="pdel" type="button">删除</button>';
    card.innerHTML = `
      <div class="phead">
        <label class="radio"><input type="radio" name="prompt" value="${escapeHtml(p.id)}" ${p.active ? 'checked' : ''}> 选为当前</label>
        ${badge}
        <input class="pname" type="text" value="${escapeHtml(p.name)}" placeholder="提示词名称"${lockedAttr}>
        ${lockLabel}
        ${del}
      </div>
      <textarea class="ptext" placeholder="提示词正文（发送到右侧 AI 时追加）"${lockedAttr}>${escapeHtml(p.text)}</textarea>
    `;
    card.querySelector('input[type="radio"]').addEventListener('change', () => { setActive(p.id); });
    if (!locked) {
      card.querySelector('.pname').addEventListener('input', (e) => { p.name = e.target.value; setDirty(true); });
      card.querySelector('.ptext').addEventListener('input', (e) => { p.text = e.target.value; setDirty(true); });
      const d = card.querySelector('.pdel');
      if (d) d.addEventListener('click', () => { prompts = prompts.filter((x) => x.id !== p.id); render(); setDirty(true); });
    }
    box.appendChild(card);
  });
  // 同步「不使用提示词」单选
  const noneRadio = document.querySelector('input[name="prompt"][value="__none__"]');
  if (noneRadio) noneRadio.checked = !prompts.some((p) => p.active);
}

function setActive(id) {
  prompts.forEach((p) => { p.active = (id !== '__none__' && p.id === id); });
  setDirty(true);
  // 仅更新 radio 选中态，不重建 DOM（避免编辑中的输入框失焦）
  document.querySelectorAll('input[name="prompt"]').forEach((r) => { r.checked = (r.value === id); });
  // 同步卡片高亮与「当前生效」徽章（不重建 DOM）
  document.querySelectorAll('#prompts .pcard').forEach((card) => {
    const rid = card.querySelector('input[type="radio"]').value;
    const isActive = (id !== '__none__' && rid === id);
    card.classList.toggle('active', isActive);
    const badge = card.querySelector('.badge');
    if (isActive && !badge) {
      const b = document.createElement('span');
      b.className = 'badge'; b.textContent = '当前生效';
      card.querySelector('.phead').insertBefore(b, card.querySelector('.pname'));
    } else if (!isActive && badge) {
      badge.remove();
    }
  });
}

function addPrompt() {
  prompts.push({ id: uid(), name: '新提示词', text: '', builtin: false, active: false });
  render();
  setDirty(true);
}

function save() {
  const sel = document.querySelector('input[name="prompt"]:checked');
  const activeId = sel ? sel.value : '__none__';
  prompts.forEach((p) => { p.active = (p.id === activeId); });
  chrome.storage.local.set(
    { [KEYS.prompts]: prompts },
    () => setDirty(false)
  );
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  // 「不使用提示词」单选：切换时同步内存态，使后续 render 不会悄悄取消勾选
  const noneRadio = document.querySelector('input[name="prompt"][value="__none__"]');
  if (noneRadio) noneRadio.addEventListener('change', () => { setActive('__none__'); });
  $('add').addEventListener('click', addPrompt);
  $('save').addEventListener('click', save);
  // Ctrl/Cmd+S：大众习惯的保存快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (isDirty) save();
    }
  });
  // 存在未保存修改时，离开/刷新页面前拦截提醒，防止误关丢内容
  window.addEventListener('beforeunload', (e) => {
    if (isDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ===================== 关于 / 更新（基于 GitHub 仓库 version.json） =====================
  (function setupAbout() {
    const aboutCur = $('about-cur');
    const aboutLatest = $('about-latest');
    const aboutCheck = $('about-check');
    const aboutDl = $('about-dl');
    const aboutRepo = $('about-repo');
    const aboutNotes = $('about-notes');

    function curVersion() {
      try { return (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '—'; }
      catch (e) { return '—'; }
    }
    function renderAbout(info) {
      if (aboutCur) aboutCur.textContent = curVersion();
      if (!info) { if (aboutLatest) aboutLatest.textContent = '—'; return; }
      const avail = !!info.updateAvailable;
      if (aboutLatest) {
        aboutLatest.textContent = avail ? ('发现新版本 ' + info.latest) : ('已是最新（' + (info.latest || curVersion()) + '）');
        aboutLatest.classList.toggle('has-update', avail);
      }
      if (aboutDl) aboutDl.style.display = avail ? '' : 'none';
      if (aboutRepo) {
        const url = (info && info.releaseUrl) || '#';
        aboutRepo.href = url;
        aboutRepo.style.display = (url && url !== '#') ? '' : 'none';
      }
      if (aboutNotes) {
        aboutNotes.textContent = info && info.notes
          ? ('更新说明：' + info.notes + (info.date ? '（' + info.date + '）' : ''))
          : (info && info.error ? ('检查失败：' + info.error) : '');
      }
    }
    function getStored() {
      return new Promise((resolve) => {
        try { chrome.storage.local.get(['biliAiSummaryUpdateInfo'], (r) => resolve(r && r.biliAiSummaryUpdateInfo ? r.biliAiSummaryUpdateInfo : null)); }
        catch (e) { resolve(null); }
      });
    }
    if (aboutCheck) aboutCheck.addEventListener('click', () => {
      aboutCheck.textContent = '检查中…';
      chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' }, (res) => {
        aboutCheck.textContent = '检查更新';
        if (res && res.ok) renderAbout(res.result);
        else getStored().then(renderAbout);
      });
    });
    if (aboutDl) aboutDl.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_UPDATE' }, (res) => {
        if (!res || !res.ok) alert('下载更新失败：' + ((res && res.error) || '未知错误'));
      });
    });
    if (aboutCur) aboutCur.textContent = curVersion();
    getStored().then(renderAbout);
  })();
});
