/*
 * 声线实验室 · 前端逻辑
 * 录音 → 解码 → 重采样到 16 kHz → 本地 DSP → 报告卡
 * 没有任何 fetch / XHR / 上传。
 */

import * as dsp from './dsp.js';
import { STEPS, SILENCE_SEC, TOTAL_SEC, analyzeRecordings } from './session.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(id).classList.remove('hidden');
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------ 录音 */

let audioCtx = null;
let micStream = null;
let cancelled = false;

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
      // 必须关掉这三个：AGC 会改音量、降噪会削掉气声、回声消除会改变频谱
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

async function recordOnce(onProgress) {
  const stream = await ensureMic();
  const mime = pickMime();
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  const t0 = performance.now();
  rec.start();
  let raf = 0;
  const tick = () => {
    const el = (performance.now() - t0) / 1000;
    onProgress(Math.min(el, TOTAL_SEC));
    if (el < TOTAL_SEC) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  await sleep(TOTAL_SEC * 1000);
  cancelAnimationFrame(raf);
  onProgress(TOTAL_SEC);
  rec.stop();
  await stopped;

  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
  const buf = await blob.arrayBuffer();
  const ctx = getCtx();
  const audio = await ctx.decodeAudioData(buf);
  const raw = audio.getChannelData(0);
  return dsp.resampleLinear(raw, audio.sampleRate, dsp.SR);
}

/* ------------------------------------------------------------ 会话 */

async function runSession() {
  cancelled = false;
  const recs = {};
  const failed = [];

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    let attempt = 0;
    let accepted = null;

    while (attempt < 2 && !accepted) {
      attempt++;
      $('step-index').textContent = `${i + 1} / ${STEPS.length}`;
      $('step-title').textContent = step.title;
      $('step-prompt').textContent = step.prompt;
      $('progress-fill').style.width = '0%';
      $('status').textContent = '准备中…';
      show('screen-record');

      const x = await recordOnce((elapsed) => {
        $('progress-fill').style.width = `${(elapsed / TOTAL_SEC) * 100}%`;
        $('status').textContent = elapsed < SILENCE_SEC
          ? `保持安静… ${(SILENCE_SEC - elapsed).toFixed(1)} 秒`
          : `现在发声：${step.prompt}`;
      });

      if (cancelled) return;

      const gate = dsp.qualityGate(x);
      if (gate.ok) accepted = { x, gate };
      else if (attempt === 1) {
        $('status').textContent = `这次没通过（${gate.reasons.join('、')}），重录一次…`;
        await sleep(1200);
      } else {
        failed.push({ step: step.title, reasons: gate.reasons });
        accepted = { x, gate };
      }
    }
    if (accepted) recs[step.key] = accepted.x;
  }

  $('status').textContent = '分析中…';
  show('screen-analyzing');
  await sleep(60);

  const { report, meta } = analyzeRecordings(recs);
  renderReport(report, failed);
  saveHistory(meta);
  show('screen-report');
}

/* ------------------------------------------------------------ 渲染 */

function renderReport(report, failed) {
  const root = $('report-body');
  root.innerHTML = '';

  for (const sec of report.sections) {
    const h = document.createElement('div');
    h.className = 'sec-title';
    h.textContent = sec.title;
    root.appendChild(h);

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

      body.append(head, text);
      wrap.append(bar, body);
      root.appendChild(wrap);
    }
  }

  if (report.priority.length) {
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
    root.append(h, ul);
  }

  if (failed.length) {
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
    root.append(h, ul);
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
    f0: m.refHz ? Math.round(m.refHz) : null,
    f2: m.formants.i && m.formants.i.F2 ? Math.round(m.formants.i.F2) : null,
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
    if (it.f0) parts.push(`阴平 F0 ${it.f0} Hz`);
    if (it.f2) parts.push(`/i/ F2 ${it.f2} Hz`);
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

$('btn-cancel').addEventListener('click', () => {
  cancelled = true;
  show('screen-home');
});

$('btn-again').addEventListener('click', () => show('screen-home'));

$('btn-history').addEventListener('click', () => {
  renderHistory();
  show('screen-history');
});

$('btn-back').addEventListener('click', () => show('screen-home'));

if (!window.isSecureContext) {
  $('perm-warn').textContent = '当前页面不是 HTTPS，浏览器会拒绝麦克风访问。请用 localhost 或 https 打开。';
  $('perm-warn').classList.remove('hidden');
}
