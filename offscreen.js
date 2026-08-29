/**
 * B站AI总结助手 - offscreen document
 *
 * 为什么需要离屏页面：
 *  - MV3 Service Worker 没有 DOM API，URL.createObjectURL 不可用（会报
 *    "URL.createObjectURL is not a function"），无法把下载到的视频字节
 *    转成 blob URL 交给 chrome.downloads。
 *  - 离屏页面拥有完整 DOM 与扩展 host_permissions 特权：既能在里面 fetch
 *    视频流 CDN（绕过 CORS），也能 URL.createObjectURL 生成 blob URL。
 *
 * 职责：
 *  1. 接收 background 发来的分片 URL 列表（durl）
 *  2. 用 Range 分段 + 并发拉取视频字节（大分片切成多段同时下载，显著提速；
 *     首段成功即缓存防盗链请求头组合，后续段复用）
 *  3. 边拉边向 background 回报进度（供页面显示进度条）
 *  4. 全部分片拉取完成后，按序拼接成 blob，生成 blob URL，回传 background
 */
'use strict';

// ==================== 下载参数 ====================
const SEGMENT_SIZE = 4 * 1024 * 1024; // 每段 4MB（Range 分段粒度）
const CONCURRENCY = 5;                // 同时下载的段数（并发提速核心）
const lastProgressReport = {};        // 按 requestId 各自的进度上报节流时间戳（避免多任务并发互相抑制）

// ==================== 请求头组合（与播放器行为对齐） ====================
const VIDEO_FETCH_HEADER_CANDIDATES = [
  // 组合 0：播放器同款——Referer=bilibili + Range 分段 + 不带 Cookie
  { name: 'Range+Ref=bili', headers: { Referer: 'https://www.bilibili.com/', Range: 'bytes=0-' }, credentials: 'omit' },
  // 组合 1：仅 Range，无任何 Referer
  { name: 'Range仅', headers: { Range: 'bytes=0-' }, credentials: 'omit' },
  // 组合 2：Range + Origin + Referer（某些节点要求 Origin）
  { name: 'Range+Origin', headers: { Origin: 'https://www.bilibili.com', Referer: 'https://www.bilibili.com/', Range: 'bytes=0-' }, credentials: 'omit' },
  // 组合 3：带 Cookie 的旧方式兜底（个别节点需要登录态才能拉流）
  { name: 'Ref=bili+Cookie', headers: { Referer: 'https://www.bilibili.com/' }, credentials: 'include' }
];

/**
 * 拉取单个 Range 段，边读边回调累计字节。
 * @param {string} url
 * @param {object} headerSet 请求头组合
 * @param {number|null} start 段起点（null 表示整段）
 * @param {number|null} end   段终点（含，null 表示到文件尾）
 * @param {(chunkBytes:number)=>void} onChunk
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchSegment(url, headerSet, start, end, onChunk) {
  const headers = Object.assign({}, headerSet.headers);
  headers.Range = (start == null) ? 'bytes=0-' : `bytes=${start}-${end}`;
  const resp = await fetch(url, {
    credentials: headerSet.credentials || 'omit',
    headers
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onChunk) onChunk(value.byteLength);
  }
  // 合并 chunks 成单个 ArrayBuffer
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(new Uint8Array(c), off);
    off += c.byteLength;
  }
  return out.buffer;
}

/**
 * 按已知大小把一个大分片切成若干 Range 段。
 * size 未知或过小时返回单个整段。
 */
function planSegments(size) {
  const n = Math.max(1, Math.ceil((Number(size) || 0) / SEGMENT_SIZE));
  const segs = [];
  for (let i = 0; i < n; i++) {
    const start = i * SEGMENT_SIZE;
    const end = (n === 1 || !size) ? null : Math.min(start + SEGMENT_SIZE - 1, size - 1);
    segs.push({ start, end });
  }
  return segs;
}

/** 多段/多分片按数组顺序拼接成一个 ArrayBuffer */
function concatBuffers(buffers) {
  const total = buffers.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), off);
    off += b.byteLength;
  }
  return out.buffer;
}

/**
 * 主下载流程（由 background 触发）。
 * @param msg { type:'DOWNLOAD_START', requestId, durl:[{url,size}], filename }
 */
async function runDownload(msg) {
  const { durl, filename } = msg;
  const totalSize = durl.reduce((s, d) => s + (Number(d.size) || 0), 0);

  const diag = [];
  let receivedBytes = 0;      // 全局已收字节（并发下各段累加）
  let winningHeader = null;   // 首个成功的请求头组合（缓存复用，避免每段重试）
  const allParts = [];        // 每个 durl 分片拼接后的 buffer

  // 先回报一次让页面立刻进入"拉取中"
  reportProgress(msg, 0, totalSize || 1, 0, durl.length);

  for (let i = 0; i < durl.length; i++) {
    const segUrl = durl[i].url;
    const segSize = Number(durl[i].size) || 0;
    const parts = planSegments(segSize);
    const segBuffers = new Array(parts.length);

    const report = () => reportProgress(msg, receivedBytes, totalSize || receivedBytes || 1, i + 1, durl.length);

    // 并发拉取各段：worker 池，同时最多 CONCURRENCY 个
    let cursor = 0;
    const worker = async () => {
      while (cursor < parts.length) {
        const idx = cursor++;
        const part = parts[idx];
        let buf = null;
        let lastErr = null;
        // 请求头组合：优先缓存组合，否则按候选顺序试
        const candidates = winningHeader
          ? [winningHeader, ...VIDEO_FETCH_HEADER_CANDIDATES.filter((c) => c !== winningHeader)]
          : VIDEO_FETCH_HEADER_CANDIDATES;
        for (const cand of candidates) {
          try {
            buf = await fetchSegment(segUrl, cand, part.start, part.end, (chunkBytes) => {
              receivedBytes += chunkBytes;
              report();
            });
            if (!winningHeader) winningHeader = cand;
            diag.push(`分片${i + 1}/${durl.length} 段${idx + 1}/${parts.length}:${cand.name}:ok(${buf.byteLength}B)`);
            break;
          } catch (e) {
            lastErr = e;
            diag.push(`分片${i + 1}/${durl.length} 段${idx + 1}/${parts.length}:${cand.name}:${(e && e.message) || e}`);
          }
        }
        if (buf === null) {
          let host = '';
          try { host = new URL(segUrl).hostname; } catch (e) { host = segUrl; }
          const err = new Error(`视频流分片 ${i + 1}/${durl.length} 下载失败（${host}，最后尝试结果：${(lastErr && lastErr.message) || lastErr}）`);
          err.diagnostic = diag;
          throw err;
        }
        segBuffers[idx] = buf;
      }
    };
    const workerCount = Math.min(CONCURRENCY, parts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // 该分片按段序拼接
    const segFinal = segBuffers.length === 1 ? segBuffers[0] : concatBuffers(segBuffers);
    allParts.push(segFinal);
    report();
  }

  // 全部拉取完成 → 合成 blob → 生成 blob URL
  const finalBuf = allParts.length === 1 ? allParts[0] : concatBuffers(allParts);
  const blob = new Blob([finalBuf], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);

  return {
    blobUrl,
    totalBytes: receivedBytes,
    filename,
    diagnostic: diag
  };
}

/** 向 background 回报进度（background 再转发给页面 content script 显示进度条）
 * 高频分片进度每 ≥200ms 才上报一次，避免 100MB 视频产生上千条跨上下文消息卡顿；
 * 但完成态（received>=total）必发，保证进度条能到 100%。 */
function reportProgress(msg, received, total, segDone, segCount) {
  const now = Date.now();
  const last = lastProgressReport[msg.requestId] || 0;
  if (now - last < 200 && !(total > 0 && received >= total)) return;
  lastProgressReport[msg.requestId] = now;
  try {
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      requestId: msg.requestId,
      received,
      total,
      segDone,
      segCount
    });
  } catch (e) { /* background 可能已休眠，忽略 */ }
}

// ==================== 消息入口 ====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;
  if (msg.type === 'REVOKE_BLOB') {
    // background 在下载落盘完成后回调，释放 blob URL，避免离屏页内存泄漏（P0-1）
    try { URL.revokeObjectURL(msg.blobUrl); } catch (e) { /* ignore */ }
    return undefined;
  }
  if (msg.type === 'DOWNLOAD_START') {
    runDownload(msg)
      .then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步 sendResponse
  }
  return undefined;
});
