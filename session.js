/*
 * 会话编排：把 9 条录音变成报告卡。
 * 与 Python 的 analyze_session.py 一一对应，可在 Node 里单独测试。
 */
import * as dsp from './dsp.js';

export const SILENCE_SEC = 1.5;
export const SPEAK_SEC = 2.5;
export const TOTAL_SEC = SILENCE_SEC + SPEAK_SEC;

export const STEPS = [
  { key: 'a', title: '持续元音 /a/', prompt: '啊—— 保持 2.5 秒，平稳，不要用力' },
  { key: 'i', title: '持续元音 /i/', prompt: '衣—— 保持 2.5 秒，感觉声音在口腔前部' },
  { key: 'u', title: '持续元音 /u/', prompt: '乌—— 保持 2.5 秒' },
  { key: 'tone1_1', tone: 1, title: '阴平 #1', prompt: '妈（mā）—— 高而平' },
  { key: 'tone1_2', tone: 1, title: '阴平 #2', prompt: '天（tiān）—— 高而平' },
  { key: 'tone1_3', tone: 1, title: '阴平 #3', prompt: '高（gāo）—— 高而平' },
  { key: 'tone4_1', tone: 4, title: '去声 #1', prompt: '骂（mà）—— 从高往低降' },
  { key: 'tone4_2', tone: 4, title: '去声 #2', prompt: '大（dà）—— 从高往低降' },
  { key: 'tone4_3', tone: 4, title: '去声 #3', prompt: '去（qù）—— 从高往低降' },
];

const strip = (x) => x.subarray(Math.floor(dsp.NOISE_SEC * dsp.SR));

/**
 * @param {Record<string, Float32Array>} recs  每条录音的 16 kHz PCM
 * @returns {{report: object, meta: object}}
 */
export function analyzeRecordings(recs) {
  const formants = {};
  for (const v of ['a', 'i', 'u']) {
    const x = recs[v];
    if (!x) continue;
    const f = dsp.stableFormants(strip(x));
    if (f) formants[v] = f;
  }

  const toneSteps = STEPS.filter((s) => s.tone);
  const perTone = [];
  for (const s of toneSteps) {
    const x = recs[s.key];
    if (!x) continue;
    const tr = dsp.medianFilter(dsp.yinTrack(strip(x)), 5);
    perTone.push({ tone: s.tone, tr, stats: dsp.f0Stats(tr) });
  }

  const medians = perTone
    .filter((t) => t.tone === 1 && t.stats.median != null)
    .map((t) => t.stats.median)
    .sort((a, b) => a - b);
  const refHz = medians.length ? medians[Math.floor(medians.length / 2)] : 200;

  const tones = perTone.map((t) => dsp.toneMatch(t.tr, t.tone, refHz));
  const ranges = perTone.map((t) => t.stats.rangeSt).filter((v) => v != null);
  const rangeSt = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null;

  const cpp = recs.a ? dsp.cppMedian(dsp.cppTrack(strip(recs.a))) : null;

  const report = dsp.buildReport({
    f0Median: medians.length ? refHz : null,
    f0RangeSt: rangeSt,
    formants,
    cppMedian: cpp,
    tones,
  });

  return { report, meta: { refHz, formants, cpp, rangeSt } };
}
