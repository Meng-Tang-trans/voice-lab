/*
 * 声线实验室 · DSP 核心
 * 与 Python 参考实现 voicelab/tools/dsp.py 逐函数对齐。
 * 全部在浏览器本地运行，不发起任何网络请求。
 */

export const SR = 16000;
export const NOISE_SEC = 1.5;

/* ---------------------------------------------------------------- WAV */

export function parseWav(buffer) {
  const view = new DataView(buffer);
  const rd = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (rd(0) !== 'RIFF' || rd(8) !== 'WAVE') throw new Error('不是 WAV 文件');
  const fs = view.getUint32(24, true);
  let pos = 12, off = 44, len = buffer.byteLength - 44;
  while (pos + 8 <= buffer.byteLength) {
    const id = rd(pos);
    const sz = view.getUint32(pos + 4, true);
    if (id === 'data') { off = pos + 8; len = Math.min(sz, buffer.byteLength - off); break; }
    pos += 8 + sz + (sz & 1);
  }
  const n = len >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(off + i * 2, true) / 32768;
  return { x: out, fs };
}

export function resampleLinear(x, fsIn, fsOut) {
  if (fsIn === fsOut) return x;
  const nOut = Math.round(x.length * fsOut / fsIn);
  const out = new Float32Array(nOut);
  for (let i = 0; i < nOut; i++) {
    const t = i * fsIn / fsOut;
    const i0 = Math.floor(t), i1 = Math.min(i0 + 1, x.length - 1);
    out[i] = x[i0] + (x[i1] - x[i0]) * (t - i0);
  }
  return out;
}

/* ---------------------------------------------------------------- YIN */

export function yinTrack(x, fs = SR, fmin = 60, fmax = 500, winS = 0.04, hopS = 0.01, thresh = 0.15) {
  const W = Math.round(winS * fs);
  const H = Math.max(1, Math.round(hopS * fs));
  const tauMin = Math.max(2, Math.floor(fs / fmax));
  const tauMax = Math.ceil(fs / fmin);
  if (x.length < W + tauMax) return new Float32Array(0);

  const nFrames = Math.floor((x.length - W - tauMax) / H) + 1;
  const out = new Float32Array(nFrames).fill(NaN);
  const d = new Float64Array(tauMax + 1);
  const cm = new Float64Array(tauMax + 1);

  for (let fi = 0; fi < nFrames; fi++) {
    const s = fi * H;
    d[0] = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let acc = 0;
      for (let j = 0; j < W; j++) {
        const diff = x[s + j] - x[s + j + tau];
        acc += diff * diff;
      }
      d[tau] = acc;
    }
    let cum = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      cum += d[tau];
      cm[tau] = (tau < tauMin || cum <= 1e-12) ? 1 : (d[tau] * tau) / cum;
    }
    let cand = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cm[tau] < thresh) {
        while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
        cand = tau;
        break;
      }
    }
    if (cand < 0) {
      let best = tauMin;
      for (let t = tauMin; t <= tauMax; t++) if (cm[t] < cm[best]) best = t;
      if (cm[best] >= 0.30) continue;
      cand = best;
    }
    let delta = 0;
    if (cand >= 1 && cand < tauMax) {
      const a = cm[cand - 1], b = cm[cand], c = cm[cand + 1];
      const denom = a - 2 * b + c;
      if (Math.abs(denom) > 1e-12) delta = (0.5 * (a - c)) / denom;
    }
    const period = cand + Math.max(-1, Math.min(1, delta));
    if (period > 0) out[fi] = fs / period;
  }
  return out;
}

export function medianFilter(x, k = 5) {
  if (k < 3) return x;
  const half = Math.floor(k / 2);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const vals = [];
    for (let j = Math.max(0, i - half); j < Math.min(x.length, i + half + 1); j++) {
      if (!Number.isNaN(x[j])) vals.push(x[j]);
    }
    if (vals.length) {
      vals.sort((a, b) => a - b);
      const m = vals.length >> 1;
      out[i] = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
    } else out[i] = NaN;
  }
  return out;
}

export function f0Stats(f0) {
  const v = Array.from(f0).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  const pct = (p) => {
    const idx = (p / 100) * (v.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] * (hi - idx) + v[hi] * (idx - lo);
  };
  if (v.length < 10) return { n: v.length, median: null, rangeSt: null };
  const p10 = pct(10), p90 = pct(90);
  return {
    n: v.length,
    median: pct(50),
    p10, p90,
    rangeSt: p10 > 0 ? 12 * Math.log2(p90 / p10) : null,
    voicedRatio: v.length / f0.length,
  };
}

/* ---------------------------------------------------------------- LPC */

function levinson(r, order) {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let e = r[0];
  if (e <= 0) return a;
  const tmp = new Float64Array(order + 1);
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    tmp.set(a);
    for (let j = 1; j < i; j++) tmp[j] = a[j] + k * a[i - j];
    tmp[i] = k;
    a.set(tmp);
    e *= 1 - k * k;
    if (e <= 1e-12) break;
  }
  return a;
}

export function lpcPeaks(frame, fs = SR, order = 16, nfft = 1024, preemph = 0.97, maxFormant = 5500) {
  const n = frame.length;
  if (n < order + 2) return [];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;
  const x = new Float64Array(n);
  x[0] = frame[0] - mean;
  for (let i = 1; i < n; i++) {
    const cur = frame[i] - mean, prev = frame[i - 1] - mean;
    x[i] = cur - preemph * prev;
  }
  for (let i = 0; i < n; i++) x[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));

  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += x[i] * x[i + lag];
    r[lag] = s;
  }
  if (r[0] <= 0) return [];
  const a = levinson(r, order);
  for (let i = 0; i <= order; i++) if (Number.isNaN(a[i])) return [];

  const env = new Float64Array(nfft);
  for (let bi = 0; bi < nfft; bi++) {
    const w = (Math.PI * bi) / (nfft - 1);
    let re = 0, im = 0;
    for (let k = 0; k <= order; k++) {
      re += a[k] * Math.cos(-w * k);
      im += a[k] * Math.sin(-w * k);
    }
    env[bi] = 1 / Math.max(Math.hypot(re, im), 1e-9);
  }
  const peaks = [];
  for (let i = 2; i < nfft - 2; i++) {
    const f = ((Math.PI * i) / (nfft - 1) * fs) / (2 * Math.PI);
    if (f <= 90 || f >= maxFormant) continue;
    if (env[i] > env[i - 1] && env[i] >= env[i + 1]) peaks.push([f, env[i]]);
  }
  peaks.sort((p, q) => q[1] - p[1]);
  const sel = [];
  for (const [f] of peaks) {
    if (sel.every((s) => Math.abs(s - f) > 60)) sel.push(f);
    if (sel.length === 4) break;
  }
  sel.sort((p, q) => p - q);
  return sel;
}

export function stableFormants(x, fs = SR) {
  const W = Math.round(0.025 * fs);
  const H = Math.max(1, Math.round(0.01 * fs));
  if (x.length <= W) return null;
  const rows = [];
  for (let s = 0; s < x.length - W; s += H) rows.push(lpcPeaks(x.subarray(s, s + W), fs));
  if (rows.length < 5) return null;
  const lo = Math.floor(rows.length * 0.2);
  const hi = Math.max(lo + 1, Math.floor(rows.length * 0.8));
  const sel = rows.slice(lo, hi);
  const minN = Math.min(...sel.map((r) => r.length));
  if (minN < 1) return null;
  const med = (i) => {
    const v = sel.map((r) => r[i]).sort((p, q) => p - q);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  return {
    F1: med(0),
    F2: minN > 1 ? med(1) : null,
    F3: minN > 2 ? med(2) : null,
    nFormants: minN,
  };
}

/* ---------------------------------------------------------------- FFT / CPP */

function fft(re, im) {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j |= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export function cppTrack(x, fs = SR, winS = 0.03, hopS = 0.01, qLoHz = 400, qHiHz = 60) {
  const W = Math.round(winS * fs);
  const H = Math.max(1, Math.round(hopS * fs));
  const qmin = Math.max(2, Math.floor(fs / qLoHz));
  const qmax = Math.floor(fs / qHiHz);
  const nfft = 512;
  const out = [];
  for (let s = 0; s < x.length - W; s += H) {
    let rms = 0;
    for (let i = 0; i < W; i++) rms += x[s + i] * x[s + i];
    rms = Math.sqrt(rms / W);
    if (rms < 1e-4) { out.push(NaN); continue; }

    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < W; i++) re[i] = x[s + i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (W - 1)));
    fft(re, im);
    const logMag = new Float64Array(nfft);
    for (let i = 0; i < nfft; i++) logMag[i] = Math.log(Math.max(Math.hypot(re[i], im[i]), 1e-12));
    const zeroIm = new Float64Array(nfft);
    fft(logMag, zeroIm);
    const ceps = new Float64Array(nfft);
    for (let i = 0; i < nfft; i++) ceps[i] = logMag[i] / nfft;

    const hi = Math.min(qmax, nfft / 2);
    if (hi - qmin < 4) { out.push(NaN); continue; }
    const cnt = hi - qmin;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = qmin; i < hi; i++) { sx += i; sy += ceps[i]; sxx += i * i; sxy += i * ceps[i]; }
    const denom = cnt * sxx - sx * sx;
    const slope = Math.abs(denom) < 1e-12 ? 0 : (cnt * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / cnt;
    let best = -Infinity;
    for (let i = qmin; i < hi; i++) {
      const v = ceps[i] - (slope * i + intercept);
      if (v > best) best = v;
    }
    out.push((best * 20) / Math.LN10);
  }
  return new Float32Array(out);
}

export function cppMedian(cpp) {
  const v = Array.from(cpp).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/* ---------------------------------------------------------------- 质量闸门 */

export function qualityGate(x, fs = SR, noiseSec = NOISE_SEC) {
  const dur = x.length / fs;
  let peak = 0, clipped = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (a > 0.99) clipped++;
  }
  const reasons = [];
  if (dur < noiseSec + 1.0) reasons.push('时长不足');
  if (clipped > x.length * 1e-3) reasons.push('削波');
  if (peak < 0.02) reasons.push('音量过低');

  const nNoise = Math.floor(noiseSec * fs);
  let snr = null;
  if (x.length > nNoise + fs / 2) {
    let acc = 0;
    for (let i = 0; i < nNoise; i++) acc += x[i] * x[i];
    const noiseRms = Math.sqrt(acc / nNoise);
    const frame = Math.floor(0.02 * fs);
    const rmsList = [];
    for (let s = nNoise; s < x.length - frame; s += frame) {
      let a2 = 0;
      for (let i = 0; i < frame; i++) a2 += x[s + i] * x[s + i];
      rmsList.push(Math.sqrt(a2 / frame));
    }
    if (rmsList.length) {
      rmsList.sort((a, b) => a - b);
      const speech = rmsList[Math.min(rmsList.length - 1, Math.floor(rmsList.length * 0.9))];
      if (noiseRms > 1e-9) {
        snr = 20 * Math.log10(speech / noiseRms);
        if (snr < 15) reasons.push(`信噪比偏低（${snr.toFixed(1)} dB）`);
      } else if (speech > 1e-6) {
        snr = 99;
      }
    }
  }
  return { ok: reasons.length === 0, reasons, durationS: dur, peak, snrDb: snr };
}

/* ---------------------------------------------------------------- 声调 */

const TONE_NAMES = { 1: '阴平', 2: '阳平', 3: '上声', 4: '去声' };
const TEMPLATES = {
  1: [0, 0, 0, 0, 0],
  2: [-1, -0.5, 0, 0.5, 1],
  3: [0, -1.2, -1.6, -0.9, 0.6],
  4: [1.5, 0.6, -0.3, -1.3, -2],
};

function sampleContour(f0, points = 5) {
  const valid = [];
  for (let i = 0; i < f0.length; i++) if (!Number.isNaN(f0[i])) valid.push(i);
  if (valid.length < 3) return null;
  const x = new Float64Array(f0.length);
  for (let i = 0; i < f0.length; i++) if (!Number.isNaN(f0[i])) x[i] = f0[i];
  let last = valid[0];
  for (let i = 0; i < f0.length; i++) {
    if (Number.isNaN(f0[i])) {
      const next = valid.find((v) => v > i);
      if (next === undefined) x[i] = x[last];
      else {
        const t = (i - last) / (next - last);
        x[i] = x[last] * (1 - t) + x[next] * t;
      }
    } else last = i;
  }
  const out = new Float64Array(points);
  for (let p = 0; p < points; p++) {
    const lo = Math.floor((x.length * p) / points);
    const hi = Math.max(lo + 1, Math.floor((x.length * (p + 1)) / points));
    let s = 0, n = 0;
    for (let i = lo; i < Math.min(hi, x.length); i++) { s += x[i]; n++; }
    out[p] = n ? s / n : 0;
  }
  return out;
}

export function toneMatch(f0, expected, refHz) {
  const tpl = TEMPLATES[expected];
  const name = TONE_NAMES[expected];
  const c = sampleContour(f0);
  if (!c) return { tone: expected, name, ok: false, reason: '有效发声不足' };

  const st = Array.from(c).map((v) => 12 * Math.log2(Math.max(v, 1e-6) / refHz));
  const mean = st.reduce((a, b) => a + b, 0) / st.length;
  const centered = st.map((v) => v - mean);

  if (expected === 1) {
    const sd = Math.sqrt(centered.reduce((a, v) => a + v * v, 0) / centered.length);
    return {
      tone: 1, name, ok: true, score: Math.max(0, Math.min(1, 1 - sd / 2)),
      value: sd, detail: `轮廓标准差 ${sd.toFixed(2)} 半音`,
    };
  }
  const tm = tpl.reduce((a, b) => a + b, 0) / tpl.length;
  const tc = tpl.map((v) => v - tm);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < centered.length; i++) {
    num += centered[i] * tc[i];
    da += centered[i] * centered[i];
    db += tc[i] * tc[i];
  }
  const denom = Math.sqrt(da * db);
  if (denom < 1e-9) return { tone: expected, name, ok: false, reason: '轮廓无变化' };
  const r = num / denom;
  return {
    tone: expected, name, ok: true, score: Math.max(0, Math.min(1, (r + 1) / 2)),
    value: r, detail: `与${name}模板相关系数 r=${r.toFixed(2)}`,
  };
}

/* ---------------------------------------------------------------- 报告 */

export const F0_MEAN = 274.0;
export const F0_SD = 21.0;

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function f0Percentile(hz) {
  return 0.5 * (1 + erf((hz - F0_MEAN) / F0_SD / Math.SQRT2)) * 100;
}

const FORMANT_REF = {
  i: { F1: [311, 28], F2: [2871, 172] },
  a: { F1: [952, 124], F2: [1371, 137] },
  u: { F1: [354, 46], F2: [762, 91] },
};

function interval(vowel, which, level = 0.9) {
  const [m, sd] = FORMANT_REF[vowel][which];
  const z = level === 0.9 ? 1.6449 : 1.96;
  return [m - z * sd, m + z * sd];
}

export function buildReport({ f0Median, f0RangeSt, formants, cppMedian, tones }) {
  const sections = [];
  const priority = [];

  if (f0Median != null) {
    const pct = f0Percentile(f0Median);
    const items = [{
      label: '阴平 F0 中位数', value: `${f0Median.toFixed(0)} Hz`, kind: 'percentile',
      text: `位于女声参照分布的第 ${pct.toFixed(0)} 百分位`,
    }];
    if (f0RangeSt != null) {
      items.push({
        label: 'F0 半音范围', value: `${f0RangeSt.toFixed(1)} 半音`, kind: 'self_only',
        text: '无人群参照，仅与自己的历史比较',
      });
    }
    sections.push({ title: '音高', items });
    const dev = Math.abs((f0Median - F0_MEAN) / F0_SD);
    if (dev > 0.5) priority.push(['音高（远离参照分布中心）', dev]);
  }

  const items = [];
  const i = formants.i;
  if (i && i.F2) {
    const [lo, hi] = interval('i', 'F2');
    const inside = i.F2 >= lo && i.F2 <= hi;
    items.push({
      label: '/i/ 的 F2', value: `${i.F2.toFixed(0)} Hz`, kind: 'interval',
      text: `参考区间 ${lo.toFixed(0)}–${hi.toFixed(0)} Hz（${inside ? '区间内' : '区间外'}）`,
    });
    if (!inside) priority.push(['共振（/i/ 的 F2）', Math.abs((i.F2 - 2871) / 172)]);
  }
  const a = formants.a;
  if (a && a.F1 != null && a.F2 != null && i && i.F1 != null && i.F2 != null) {
    items.push({
      label: '元音空间质心（/a/+/i/）',
      value: `F1 ${((a.F1 + i.F1) / 2).toFixed(0)} / F2 ${((a.F2 + i.F2) / 2).toFixed(0)} Hz`,
      kind: 'self_only', text: '弱参照，主要看自身随时间的变化',
    });
  }
  if (items.length) sections.push({ title: '共振', items });

  if (cppMedian != null) {
    sections.push({
      title: '音质',
      items: [{
        label: 'CPP', value: `${cppMedian.toFixed(1)} dB`, kind: 'self_only',
        text: '无人群参照（软件与设备差异大于性别差异），仅与同设备历史比较',
      }],
    });
  }

  const okTones = tones.filter((t) => t.ok);
  if (okTones.length) {
    sections.push({
      title: '自然性（声调轮廓）',
      items: okTones.map((t, idx) => ({
        label: `${t.name} #${idx + 1}`, value: t.score.toFixed(2), kind: 'absolute',
        text: t.detail + (t.score >= 0.7 ? '（吻合）' : '（偏离模板）'),
      })),
    });
    const worst = Math.min(...okTones.map((t) => t.score));
    if (worst < 0.7) priority.push(['声调轮廓（有音节偏离模板）', (1 - worst) * 3]);
  }

  priority.sort((p, q) => q[1] - p[1]);
  return {
    sections,
    priority: priority.slice(0, 2).map((p) => p[0]),
    disclaimer: '本报告表示与参考人群的统计距离，不代表他人对你的性别判断。所有数值不构成医疗建议。',
  };
}

/* ---------------------------------------------------------------- 任意语句 */

function median(arr) {
  if (!arr.length) return null;
  const v = arr.slice().sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function frameRms(x, fs = SR, winS = 0.025, hopS = 0.01) {
  const W = Math.round(winS * fs);
  const H = Math.max(1, Math.round(hopS * fs));
  const n = Math.max(0, Math.floor((x.length - W) / H) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < W; j++) { const v = x[i * H + j]; s += v * v; }
    out[i] = Math.sqrt(s / W);
  }
  return out;
}

/**
 * 在整句话里取「发声帧」的共振峰中位数。
 * 元音不固定，所以不给人群区间，只用于和自己比。
 */
export function speechFormants(x, f0, fs = SR) {
  const W = Math.round(0.04 * fs);
  const H = Math.max(1, Math.round(0.01 * fs));
  const F1 = [], F2 = [], F3 = [];
  const n = Math.min(f0.length, Math.floor((x.length - W) / H) + 1);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(f0[i])) continue;
    const s = i * H;
    const p = lpcPeaks(x.subarray(s, s + W), fs);
    if (p.length >= 2) { F1.push(p[0]); F2.push(p[1]); if (p[2]) F3.push(p[2]); }
  }
  return {
    F1: median(F1), F2: median(F2), F3: median(F3),
    nFrames: F1.length,
    spread: F2.length > 1 ? Math.max(...F2) - Math.min(...F2) : null,
  };
}

/** 时长、有效发声占比、句中停顿次数 */
export function speechRhythm(x, fs = SR) {
  const rms = frameRms(x, fs);
  if (!rms.length) return null;
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.1)] || 1e-9;
  const peak = sorted[sorted.length - 1] || 0;
  const th = Math.max(noise * 2.5, peak * 0.08, 1e-4);

  let first = -1, last = -1, activeCount = 0;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] > th) { if (first < 0) first = i; last = i; activeCount++; }
  }
  if (first < 0) return { durationS: 0, activeS: 0, activeRatio: 0, pauses: 0, noiseRms: noise, peakRms: peak };

  let pauses = 0, silentRun = 0;
  for (let i = first; i <= last; i++) {
    if (rms[i] <= th) {
      silentRun++;
    } else {
      if (silentRun >= 25) pauses++;   // ≥0.25 s 算一次停顿
      silentRun = 0;
    }
  }
  const frames = last - first + 1;
  return {
    durationS: frames * 0.01,
    activeS: activeCount * 0.01,
    activeRatio: activeCount / frames,
    pauses,
    noiseRms: noise,
    peakRms: peak,
  };
}

export function buildSpeechReport({ f0Median, f0RangeSt, formants, cppMedian, rhythm }) {
  const sections = [];
  const priority = [];

  if (f0Median != null) {
    const pct = f0Percentile(f0Median);
    const items = [{
      label: '说话 F0 中位数', value: `${f0Median.toFixed(0)} Hz`, kind: 'percentile',
      text: `位于女声参照分布的第 ${pct.toFixed(0)} 百分位`,
    }];
    if (f0RangeSt != null) {
      items.push({
        label: 'F0 半音范围（P10–P90）', value: `${f0RangeSt.toFixed(1)} 半音`, kind: 'self_only',
        text: '一整句话里的音高起伏，仅与自己的历史比较',
      });
    }
    sections.push({ title: '音高', items });
    if (Math.abs((f0Median - F0_MEAN) / F0_SD) > 0.5) priority.push(['音高（远离参照分布中心）', 1]);
  }

  if (formants && formants.F1 != null) {
    const items = [{
      label: 'F1 中位数（发声帧）', value: `${formants.F1.toFixed(0)} Hz`, kind: 'self_only',
      text: `取自 ${formants.nFrames} 个有声帧；整句话元音不固定，只看自身变化`,
    }];
    if (formants.F2 != null) {
      items.push({
        label: 'F2 中位数（发声帧）', value: `${formants.F2.toFixed(0)} Hz`, kind: 'self_only',
        text: '反映口腔前部的共鸣位置，仅与自己的历史比较',
      });
    }
    if (formants.F1 != null && formants.F2 != null) {
      items.push({
        label: 'F2–F1 距离', value: `${(formants.F2 - formants.F1).toFixed(0)} Hz`, kind: 'self_only',
        text: '越大通常表示舌位越前；同样只做自比',
      });
    }
    sections.push({ title: '共振', items });
  }

  if (cppMedian != null) {
    sections.push({
      title: '音质',
      items: [{
        label: 'CPP', value: `${cppMedian.toFixed(1)} dB`, kind: 'self_only',
        text: '无人群参照（设备差异大于性别差异），仅与同设备历史比较',
      }],
    });
  }

  if (rhythm && rhythm.durationS > 0) {
    sections.push({
      title: '节奏',
      items: [
        {
          label: '有效发声', value: `${rhythm.activeS.toFixed(1)} 秒`, kind: 'self_only',
          text: `这句里真正出声的部分；发声占比 ${(rhythm.activeRatio * 100).toFixed(0)}%`,
        },
        {
          label: '句中停顿', value: `${rhythm.pauses} 次`, kind: 'self_only',
          text: '≥0.25 秒的静音段；停顿多不一定是问题，只记录',
        },
      ],
    });
  }

  if (!sections.length) {
    sections.push({
      title: '没有测到有效声音',
      items: [{
        label: '结果', value: '—', kind: 'self_only',
        text: '这句话里没有检测到稳定的有声段。换个安静的地方，正常音量再说一次。',
      }],
    });
  }

  priority.sort((p, q) => q[1] - p[1]);
  return {
    sections,
    priority: priority.slice(0, 2).map((p) => p[0]),
    disclaimer: '本报告基于一整句话，元音不固定，共振数值只适合与自己的历史比较，不适合与人群区间对照。所有数值不构成医疗建议。',
  };
}
