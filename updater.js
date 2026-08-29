'use strict';
/**
 * B站AI总结助手 - 基于 GitHub 仓库的更新检测（version.json 方案）
 *
 * 由 background.js 经 importScripts 注入（与 shared.js 同一注入方式）。
 *
 * 原理：
 *  - 仓库根目录维护 version.json（含最新 version / notes / date）；
 *  - 扩展后台定期 fetch raw.githubusercontent.com 上的该文件，与 manifest 的 version 比对；
 *  - 因 MV3 解压版扩展无法自替换文件，检测到新版本后仅做「通知 + 引导下载」，
 *    用户需将下载的 zip 解压覆盖原文件夹，再到 chrome://extensions 点「重新加载」。
 *
 * 发布前请把下面的 UPDATE_REPO 改成实际仓库路径，例如 'alice/bilibili-ai-summary'。
 */
(function (root) {
  // 发布前已替换为实际 GitHub 仓库路径
  const UPDATE_REPO = 'zanmeidalao/bilibili-ai-summary';
  const UPDATE_BRANCH = 'main';
  const UPDATE_RAW_URL = 'https://raw.githubusercontent.com/' + UPDATE_REPO + '/' + UPDATE_BRANCH + '/version.json';
  const UPDATE_RELEASE_URL = 'https://github.com/' + UPDATE_REPO + '/releases';

  const UPDATE_STORAGE_KEY = 'biliAiSummaryUpdateInfo';
  const UPDATE_ALARM = 'biliAiSummaryUpdateCheck';
  const UPDATE_CHECK_INTERVAL_MIN = 12 * 60; // 每 12 小时检查一次

  function parseVersion(v) {
    const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  function compareVersion(a, b) {
    const pa = parseVersion(a), pb = parseVersion(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
    }
    return 0;
  }

  function getCurrentVersion() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        return chrome.runtime.getManifest().version || '0.0.0';
      }
    } catch (e) { /* ignore */ }
    return '0.0.0';
  }

  async function fetchLatestVersion() {
    const resp = await fetch(UPDATE_RAW_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    if (!j || !j.version) throw new Error('version.json 格式异常');
    return j;
  }

  /** 检测更新：对比 manifest version 与远程 version.json，持久化结果并返回 */
  async function checkForUpdate() {
    const current = getCurrentVersion();
    const info = { updateAvailable: false, latest: current, current: current, notes: '', date: '', releaseUrl: UPDATE_RELEASE_URL, checkedAt: Date.now() };
    try {
      const remote = await fetchLatestVersion();
      info.updateAvailable = compareVersion(remote.version, current) > 0;
      info.latest = remote.version;
      info.notes = remote.notes || '';
      info.date = remote.date || '';
    } catch (e) {
      info.error = String((e && e.message) || e);
    }
    try { chrome.storage.local.set({ [UPDATE_STORAGE_KEY]: info }); } catch (e) { /* ignore */ }
    return info;
  }

  /** 读取已持久化的更新信息（无需重新联网） */
  function getUpdateInfo() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([UPDATE_STORAGE_KEY], (r) => resolve(r && r[UPDATE_STORAGE_KEY] ? r[UPDATE_STORAGE_KEY] : null));
      } catch (e) { resolve(null); }
    });
  }

  /** 注册周期检查闹钟（MV3 推荐方式，SW 可休眠） */
  function setupUpdateAlarm() {
    try { chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_CHECK_INTERVAL_MIN }); } catch (e) { /* ignore */ }
  }

  /** 最新版源码 zip 下载地址（按 tag vX.Y.Z） */
  function getUpdateZipUrl(version) {
    return 'https://github.com/' + UPDATE_REPO + '/archive/refs/tags/v' + version + '.zip';
  }
  function getReleaseUrl() { return UPDATE_RELEASE_URL; }

  // 暴露给 background.js（与 shared.js 的 root 挂载方式一致）
  root.checkForUpdate = checkForUpdate;
  root.getUpdateInfo = getUpdateInfo;
  root.setupUpdateAlarm = setupUpdateAlarm;
  root.getUpdateZipUrl = getUpdateZipUrl;
  root.getReleaseUrl = getReleaseUrl;
  root.UPDATE_ALARM = UPDATE_ALARM;
})(typeof self !== 'undefined' ? self : this);
