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
const SEGMENT_SIZE = 4 * 1024 * 1024;   // 每段 4MB（Range 分段粒度）
const CONCURRENCY = 5;                  // 同时下载的段数（并发提速核心）
const lastProgressReport = {};          // 按 requestId 各自的进度上报节流时间戳（避免多任务并发互相抑制）

// ==================== 请求头组合（与播放器行为对齐，优先带登录态） ====================
// Range 由 fetchSegment 统一附加，这里只列 Referer/Origin/Cookie/UA 组合。
// 顺序：先试「带 Cookie + player 页 Referer」（B站 CDN 防盗链最常接受），
// 再退到仅 Referer，最后仅 UA。全部失败再由 background(SW) 兜底拉流。
const VIDEO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VIDEO_FETCH_HEADER_CANDIDATES = [
  { name: 'Cookie+Ref=player', headers: { Referer: 'https://player.bilibili.com/', 'User-Agent': VIDEO_UA }, credentials: 'include' },
  { name: 'Cookie+Ref=www',    headers: { Referer: 'https://www.bilibili.com/',  'User-Agent': VIDEO_UA }, credentials: 'include' },
  { name: 'Ref=player',        headers: { Referer: 'https://player.bilibili.com/', 'User-Agent': VIDEO_UA }, credentials: 'omit' },
  { name: 'Ref=www',           headers: { Referer: 'https://www.bilibili.com/',  'User-Agent': VIDEO_UA }, credentials: 'omit' },
  { name: 'Origin+Ref',        headers: { Origin: 'https://www.bilibili.com', Referer: 'https://www.bilibili.com/', 'User-Agent': VIDEO_UA }, credentials: 'omit' },
  { name: 'UA仅',              headers: { 'User-Agent': VIDEO_UA }, credentials: 'omit' }
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
 * 经 background(Service Worker) 拉取单个 Range 段（SW 拥有 host_permissions，可绕过 CDN 的 CORS/防盗链拦截）。
 * 用于离屏页本地请求头组合全部失败时兜底：万一离屏页 fetch 没吃到扩展权限，SW 这层是稳的。
 */
function fetchSegmentViaSw(url, headerSet, start, end) {
  const headers = Object.assign({}, headerSet.headers);
  headers.Range = (start == null) ? 'bytes=0-' : `bytes=${start}-${end}`;
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_SEGMENT', url, headers, credentials: headerSet.credentials || 'omit' }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error('SW 通信失败：' + chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'SW 拉流失败'));
        resolve(resp.arrayBuffer);
      });
    } catch (e) { reject(e); }
  });
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
async function runDownload(msg, onProgress) {
  const { durl, filename } = msg;
  const totalSize = durl.reduce((s, d) => s + (Number(d.size) || 0), 0);

  const diag = [];
  let receivedBytes = 0;      // 全局已收字节（并发下各段累加）
  let winningHeader = null;   // 首个成功的请求头组合（缓存复用，避免每段重试）
  const allParts = [];        // 每个 durl 分片拼接后的 buffer

  // 进度回调：端口模式走 onProgress（结构化克隆回传），否则走 sendMessage（DOWNLOAD_PROGRESS）
  const reportFn = onProgress
    ? (received, total, segDone, segCount) => { try { onProgress({ received, total, segDone, segCount }); } catch (e) { /* ignore */ } }
    : (received, total, segDone, segCount) => reportProgress(msg, received, total, segDone, segCount);

  // 先回报一次让页面立刻进入"拉取中"
  reportFn(0, totalSize || 1, 0, durl.length);

  for (let i = 0; i < durl.length; i++) {
    const segUrl = durl[i].url;
    const segSize = Number(durl[i].size) || 0;
    const parts = planSegments(segSize);
    const segBuffers = new Array(parts.length);

    const report = () => reportFn(receivedBytes, totalSize || receivedBytes || 1, i + 1, durl.length);

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
        // 本地所有请求头组合均失败 → 退回 Service Worker 拉流（SW 拥有 host_permissions，CORS 绕过最稳）
        if (buf === null) {
          try {
            buf = await fetchSegmentViaSw(segUrl, winningHeader || VIDEO_FETCH_HEADER_CANDIDATES[0], part.start, part.end);
            diag.push(`分片${i + 1}/${durl.length} 段${idx + 1}/${parts.length}:SW-FALLBACK:ok(${buf.byteLength}B)`);
          } catch (e) {
            lastErr = e;
            diag.push(`分片${i + 1}/${durl.length} 段${idx + 1}/${parts.length}:SW-FALLBACK:${(e && e.message) || e}`);
          }
        }
        if (buf === null) {
          let host = '';
          try { host = new URL(segUrl).hostname; } catch (e) { host = segUrl; }
          const err = new Error(`视频流分片 ${i + 1}/${durl.length} 下载失败（${host}）；本地与 SW 回退均失败，最后结果：${(lastErr && lastErr.message) || lastErr}。多见于 B站 CDN 防盗链或网络被拦截`);
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

  // 全部拉取完成 → 拼接成最终字节（交给离屏页/页面落盘，不再自己生成 blob URL）。
  // 注意：chrome.downloads.download 无法解析扩展 blob URL（下载网络服务跨进程取不到），
  // 所以这里只产出裸字节，由 DOWNLOAD_START 处理器按 saveMode 选择可靠的落盘方式。
  const finalBuf = allParts.length === 1 ? allParts[0] : concatBuffers(allParts);

  return {
    finalBuf,
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

// ==================== 落盘辅助 ====================
/** 默认文件夹：在离屏页本地下锚点下载（渲染进程读取自有 blob，可靠） */
function anchorDownload(filename, finalBuf, onDone) {
  try {
    const blob = new Blob([finalBuf], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 60000);
  } catch (e) { /* 交由 onDone 回报失败 */ }
  onDone(true, filename, '');
}

// ==================== 消息入口（sendMessage：默认文件夹模式） ====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;
  if (msg.type === 'DOWNLOAD_START') {
    runDownload(msg)
      .then((r) => {
        // sendMessage 链路走默认文件夹锚点下载（句柄无法经 JSON 传递，故询问模式走端口）
        anchorDownload(r.filename, r.finalBuf, (ok, filename, error) => {
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_DONE',
            requestId: msg.requestId,
            ok,
            filename,
            error: ok ? '' : error
          });
        });
        sendResponse({ ok: true, result: { started: true, totalBytes: r.totalBytes, filename: r.filename, diagnostic: r.diagnostic } });
      })
      .catch((e) => chrome.runtime.sendMessage({
        type: 'DOWNLOAD_DONE',
        requestId: msg.requestId,
        ok: false,
        error: String((e && e.message) || e)
      }));
    return true; // 异步 sendResponse
  }
  return undefined;
});

// ==================== 端口入口（"每次询问位置"模式：拉流后把字节回传页面） ====================
// 关键教训（历经多轮调试）：
//  1) 离屏页写盘(File System Access)不可靠 → 0 字节；
//  2) 经端口用裸 ArrayBuffer 回传页面，在两跳结构化克隆中继里字节会被清空 → 0 字节。
// 故这里**只拉流**，并把完整视频字节**以 base64 文本**分片回传（base64 是普通字符串，
// 不受任何 ArrayBuffer 克隆/转移影响），由页面(普通 renderer) 解码后写到用户选好的位置——最可靠。
// 对 Uint8Array（或子视图）做 base64 编码，严格按视图边界，不会把底层整段 buffer 都编码进去
function bytesToBase64(u8) {
  const len = u8.length;
  let binary = '';
  const step = 8192;
  for (let i = 0; i < len; i += step) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + step, len)));
  }
  return btoa(binary);
}
function arrayBufferToBase64(ab) { return bytesToBase64(new Uint8Array(ab)); }

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'bili-dl-off') return;
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'START') return;
    try {
      try { port.postMessage({ type: 'DL_LOG', requestId: msg.requestId, text: 'offscreen收到START，分片数=' + ((msg.durl && msg.durl.length) || 0) }); } catch (e) { /* ignore */ }
      const r = await runDownload(msg, (p) => {
        try { port.postMessage({ type: 'PROGRESS', requestId: msg.requestId, ...p }); } catch (e) { /* ignore */ }
      });
      const finalBuf = r.finalBuf;
      const totalLen = finalBuf.byteLength;
      const CHUNK = 256 * 1024; // 256KB 原始/片 → 约 341KB base64，单条端口消息稳妥
      const count = Math.max(1, Math.ceil(totalLen / CHUNK));
      const view = new Uint8Array(finalBuf);
      // 诊断用：明确记录「离屏页到底拉到了多少字节」，便于定位是拉流问题还是传输问题
      console.log('[字幕助手-offscreen] 拉流完成，fetchedBytes=' + totalLen + '，receivedBytes=' + r.totalBytes + '，base64分片数=' + count);
      try { port.postMessage({ type: 'DL_LOG', requestId: msg.requestId, text: 'offscreen拉流完成，总字节=' + totalLen + '，base64分片数=' + count }); } catch (e) { /* ignore */ }
      // 分片回传：同步连发 277 条大消息会挤爆端口队列，改为异步逐条+每次让出事件循环
      let chunkErr = null;
      for (let i = 0; i < count; i++) {
        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, totalLen);
        const slice = view.subarray(start, end);
        try {
          const b64 = bytesToBase64(slice); // 只编码当前 256KB 分片，不会把整个 buffer 发出去
          port.postMessage({
            type: 'DL_CHUNK',
            requestId: msg.requestId,
            index: i,
            count,
            b64,
            filename: r.filename
          });
        } catch (e) {
          chunkErr = e;
          try { port.postMessage({ type: 'DL_END', requestId: msg.requestId, ok: false, error: '分片传输失败：' + String((e && e.message) || e) }); } catch (e2) { /* ignore */ }
          break;
        }
        // 让出事件循环，避免消息队列积压导致端口断开；最后一条不用再等
        if (i < count - 1) await new Promise((r) => setTimeout(r, 0));
      }
      if (!chunkErr) {
        try { port.postMessage({ type: 'DL_LOG', requestId: msg.requestId, text: 'offscreen全部' + count + '个分片已发出，总字节=' + totalLen }); } catch (e) { /* ignore */ }
        try { port.postMessage({ type: 'DL_END', requestId: msg.requestId, ok: true, totalBytes: totalLen, fetchedBytes: totalLen, filename: r.filename }); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      try { port.postMessage({ type: 'DL_END', requestId: msg.requestId, ok: false, error: String((e && e.message) || e) }); } catch (e2) { /* ignore */ }
    }
  });
});

