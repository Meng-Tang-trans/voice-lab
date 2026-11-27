/*
 * 声线实验室 · 前端逻辑
 * 录音 → 解码 → 重采样到 16 kHz → 本地 DSP → 报告卡
 * 没有任何 fetch / XHR / 上传。
 */

import * as dsp from './dsp.js';
import { MAX_SEC, analyzeSentence } from './session.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(id).classList.remove('hidden');
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------ 方向 */

const DIR_KEY = 'voicelab.dir';
let direction = localStorage.getItem(DIR_KEY) === 'ftm' ? 'ftm' : 'mtf';

const DIR_HINT = {
  mtf: '参照成人女声：说话 F0 常见 165–255 Hz，声道长度 13–16 cm。',
  ftm: '参照成人男声：说话 F0 常见 100–150 Hz（Cao & Lei 2017，n=100），声道长度 16.5–19.5 cm。睾酮会降低音高，但基本不改变声道长度。',
};

function applyDirection() {
  for (const btn of document.querySelectorAll('.mode-btn')) {
    btn.classList.toggle('active', btn.dataset.dir === direction);
  }
  $('mode-hint').textContent = DIR_HINT[direction];
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec * 10) % 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
}

/* ------------------------------------------------------------ 录音 */

let audioCtx = null;
let micStream = null;
let cancelled = false;
let activeStop = null;

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

async function ensureMic() {
  if (micStream) return micStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('当前浏览器不支持麦克风，或页面不是 HTTPS。');
  }
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  return micStream;
}

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  if (!window.MediaRecorder) return '';
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

/**
 * 手动录音：用户按停止才结束；到 MAX_SEC 自动停。
 */
function recordManual(onTick) {
  return new Promise(async (resolve, reject) => {
    try {
      const stream = await ensureMic();
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { rec.onstop = r; });

      const ctx = getCtx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);

      let done = false;
      const t0 = performance.now();
      let timer = 0;

      const finish = async () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        try { rec.stop(); } catch (e) {}
        await stopped;
        try { src.disconnect(); } catch (e) {}
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const arr = await blob.arrayBuffer();
        const audio = await ctx.decodeAudioData(arr);
        const raw = audio.getChannelData(0);
        resolve({
          x: dsp.resampleLinear(raw, audio.sampleRate, dsp.SR),
          durationS: audio.duration,
        });
      };

      activeStop = finish;
      timer = setInterval(() => {
        const sec = (performance.now() - t0) / 1000;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        onTick(sec, Math.min(1, rms * 3));
        if (sec >= MAX_SEC) finish();
      }, 100);

      rec.start(200);
    } catch (e) {
      reject(e);
    }
  });
}

/* ------------------------------------------------------------ 会话 */

async function runSession() {
  cancelled = false;
  $('step-title').textContent = '说一句话';
  $('step-prompt').textContent = '想说什么就说什么，说完按「停止并分析」';
  $('rec-time').textContent = '00:00.0';
  $('level-fill').style.width = '0%';
  $('status').textContent = '准备好就开始';
  show('screen-record');

  let data;
  try {
    data = await recordManual((sec, level) => {
      $('rec-time').textContent = fmtTime(sec);
      $('level-fill').style.width = `${Math.round(level * 100)}%`;
    });
  } catch (e) {
    $('perm-warn').textContent = e.message || String(e);
    $('perm-warn').classList.remove('hidden');
    show('screen-home');
    return;
  }
  activeStop = null;
  if (cancelled) return;

  const dur = data.x.length / dsp.SR;
  if (dur < 2) {
    $('perm-warn').textContent = '太短了，至少说 2 秒。';
    $('perm-warn').classList.remove('hidden');
    show('screen-home');
    return;
  }

  $('status').textContent = '分析中…';
  show('screen-analyzing');
  await sleep(60);

  const { report, meta } = analyzeSentence(data.x, direction);
  renderReport(report, []);
  $('report-mode').textContent = direction === 'ftm'
    ? '参照：成人男声（FtM 男性化）'
    : '参照：成人女声（MtF 女性化）';
  saveHistory(meta);
  show('screen-report');
}

/* ------------------------------------------------------------ 渲染 */

function renderReport(report, failed) {
  const root = $('report-body');
  root.innerHTML = '';

  if (report.conclusion) {
    const box = document.createElement('div');
    box.className = 'conclusion' + (report.conclusion.lowConf ? ' low' : '');
    const kicker = document.createElement('div');
    kicker.className = 'conclusion-kicker';
    kicker.textContent = '分析结论';
    const head = document.createElement('div');
    head.className = 'conclusion-head';
    head.textContent = report.conclusion.headline;
    const text = document.createElement('p');
    text.className = 'conclusion-text';
    text.textContent = report.conclusion.text;
    box.append(kicker, head, text);

    if (report.conclusion.points && report.conclusion.points.length) {
      const ul = document.createElement('ul');
      ul.className = 'priority';
      for (const pt of report.conclusion.points) {
        const li = document.createElement('li');
        li.textContent = pt;
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    root.appendChild(box);
  }

  for (const sec of report.sections) {
    const box = document.createElement('div');
    box.className = 'sec';

    const h = document.createElement('div');
    h.className = 'sec-title';
    h.textContent = sec.title;
    box.appendChild(h);

    for (const item of sec.items) {
      const wrap = document.createElement('div');
      wrap.className = 'item';

      const bar = document.createElement('div');
      bar.className = `bar ${item.kind}`;

      const body = document.createElement('div');
      body.className = 'item-body';

      const head = document.createElement('div');
      head.className = 'item-head';
      const label = document.createElement('span');
      label.className = 'item-label';
      label.textContent = item.label;
      const value = document.createElement('span');
      value.className = `item-value ${item.kind}`;
      value.textContent = item.value;
      head.append(label, value);

      const text = document.createElement('div');
      text.className = 'item-text';
      text.textContent = item.text;

      if (item.viz) {
        const viz = document.createElement('div');
        viz.className = `viz ${item.viz.state}`;
        const track = document.createElement('div');
        track.className = 'viz-track';
        const band = document.createElement('div');
        band.className = 'viz-band';
        const mid = document.createElement('div');
        mid.className = 'viz-mid';
        const dot = document.createElement('div');
        dot.className = 'viz-dot';
        dot.style.left = `${50 + (item.viz.p / 4) * 100}%`;
        track.append(band, mid, dot);
        const note = document.createElement('div');
        note.className = 'viz-note';
        const word = item.viz.p > 0 ? item.viz.posWord : item.viz.negWord;
        if (item.viz.dev < 0.15) note.textContent = '在参考带中心';
        else if (item.viz.state === 'in') note.textContent = `区间内 · ${word} ${item.viz.dev.toFixed(1)} 个带宽`;
        else if (item.viz.state === 'out') note.textContent = `偏${word} · ${item.viz.dev.toFixed(1)} 个带宽（区间外）`;
        else note.textContent = `远超 · ${item.viz.dev.toFixed(1)} 个带宽`;
        viz.append(track, note);
        body.append(head, viz, text);
      } else {
        body.append(head, text);
      }
      wrap.append(bar, body);
      box.appendChild(wrap);
    }
    root.appendChild(box);
  }

  if (report.priority.length) {
    const box = document.createElement('div');
    box.className = 'sec wide';
    const h = document.createElement('div');
    h.className = 'sec-title';
    h.textContent = '优先级';
    const ul = document.createElement('ul');
    ul.className = 'priority';
    for (const p of report.priority) {
      const li = document.createElement('li');
      li.textContent = p;
      ul.appendChild(li);
    }
    box.append(h, ul);
    root.appendChild(box);
  }

  if (failed.length) {
    const box = document.createElement('div');
    box.className = 'sec wide';
    const h = document.createElement('div');
    h.className = 'sec-title';
    h.textContent = '质量提示';
    const ul = document.createElement('ul');
    ul.className = 'priority';
    for (const f of failed) {
      const li = document.createElement('li');
      li.textContent = `${f.step}：${f.reasons.join('、')}（已降级使用）`;
      ul.appendChild(li);
    }
    box.append(h, ul);
    root.appendChild(box);
  }

  const d = document.createElement('p');
  d.className = 'disclaimer';
  d.textContent = report.disclaimer;
  root.appendChild(d);
}

/* ------------------------------------------------------------ 历史 */

const KEY = 'voicelab.sessions.v1';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

function saveHistory(m) {
  const list = loadHistory();
  list.unshift({
    ts: Date.now(),
    dir: direction,
    f0: m.f0 ? Math.round(m.f0) : null,
    f2: m.formants && m.formants.F2 ? Math.round(m.formants.F2) : null,
    cpp: m.cpp != null ? Math.round(m.cpp * 10) / 10 : null,
  });
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
}

function renderHistory() {
  const root = $('history-body');
  root.innerHTML = '';
  const list = loadHistory();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'lede';
    p.textContent = '还没有记录。';
    root.appendChild(p);
    return;
  }
  for (const it of list) {
    const d = document.createElement('div');
    d.className = 'hist';
    const t = new Date(it.ts);
    const parts = [`${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`];
    parts.unshift(it.dir === 'ftm' ? 'FtM' : 'MtF');
    if (it.f0) parts.push(`说话 F0 ${it.f0} Hz`);
    if (it.f2) parts.push(`F2 ${it.f2} Hz`);
    if (it.cpp != null) parts.push(`CPP ${it.cpp} dB`);
    d.innerHTML = `<div class="t">${parts[0]}</div><div>${parts.slice(1).join('　·　')}</div>`;
    root.appendChild(d);
  }
}

/* ------------------------------------------------------------ 事件 */

$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try {
    await runSession();
  } catch (e) {
    $('perm-warn').textContent = e.message || String(e);
    $('perm-warn').classList.remove('hidden');
    show('screen-home');
  } finally {
    $('btn-start').disabled = false;
  }
});

$('btn-stop').addEventListener('click', () => {
  if (activeStop) activeStop();
});

$('btn-cancel').addEventListener('click', () => {
  cancelled = true;
  if (activeStop) activeStop();
  show('screen-home');
});

$('btn-again').addEventListener('click', () => show('screen-home'));

$('btn-history').addEventListener('click', () => {
  renderHistory();
  show('screen-history');
});

$('btn-back').addEventListener('click', () => show('screen-home'));

/* ------------------------------------------------------------ 爱心 */
/* 本地状态 + 全局计数。计数走第三方计数器 abacus.jasoncameron.dev，
   只在页脚进入视口时请求一次，失败就不显示数字，不影响其它功能。 */

const LIKED_KEY = 'voicelab.liked';
const heart = $('btn-heart');
const countEl = $('like-count');

const COUNTER_API = 'https://abacus.jasoncameron.dev';
const COUNTER_NS = 'voice-lab-mengtang';
const COUNTER_KEY = 'heart';

async function counterFetch(path, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${COUNTER_API}/${path}/${COUNTER_NS}/${COUNTER_KEY}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (r.status === 404) return { value: 0 };
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.value === 'number' ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function renderCount(n) {
  countEl.textContent = n == null ? '' : `${n} 人喜欢`;
}

async function loadCount() {
  const j = await counterFetch('get');
  renderCount(j ? j.value : null);
}

function applyLiked() {
  const liked = localStorage.getItem(LIKED_KEY) === '1';
  heart.classList.toggle('liked', liked);
  heart.setAttribute('aria-pressed', liked ? 'true' : 'false');
}

heart.addEventListener('click', async () => {
  if (localStorage.getItem(LIKED_KEY) === '1') return; // 一次性，避免重复计数
  localStorage.setItem(LIKED_KEY, '1');
  applyLiked();
  const j = await counterFetch('hit');
  if (j) renderCount(j.value);
});

applyLiked();

/* 懒加载：页脚进入视口才请求，没滚到这里的人不会发出任何请求 */
const footerEl = document.querySelector('.footer');
if (footerEl && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      loadCount();
    }
  }, { rootMargin: '160px' });
  io.observe(footerEl);
} else if (footerEl) {
  loadCount();
}

for (const btn of document.querySelectorAll('.mode-btn')) {
  btn.addEventListener('click', () => {
    direction = btn.dataset.dir;
    localStorage.setItem(DIR_KEY, direction);
    applyDirection();
  });
}
applyDirection();

if (!window.isSecureContext) {
  $('perm-warn').textContent = '当前页面不是 HTTPS，浏览器会拒绝麦克风访问。请用 localhost 或 https 打开。';
  $('perm-warn').classList.remove('hidden');
}
