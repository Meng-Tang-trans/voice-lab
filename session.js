/*
 * 会话编排：一句话录音 → 报告卡。
 * 与旧版 9 段协议的区别：不再要求固定元音，直接分析整句话里的有声帧。
 */
import * as dsp from './dsp.js';

export const LEAD_SEC = 1.0;
export const SPEAK_SEC = 6.0;
export const TOTAL_SEC = LEAD_SEC + SPEAK_SEC;

/**
 * @param {Float32Array} x  16 kHz PCM，开头 1 秒是环境声
 * @returns {{report: object, meta: object}}
 */
export function analyzeSentence(x) {
  const lead = Math.floor(LEAD_SEC * dsp.SR);
  const y = x.length > lead ? x.subarray(lead) : x;

  const f0 = dsp.medianFilter(dsp.yinTrack(y), 5);
  const stats = dsp.f0Stats(f0);
  const formants = dsp.speechFormants(y, f0);
  const cpp = dsp.cppMedian(dsp.cppTrack(y));
  const rhythm = dsp.speechRhythm(y);

  const report = dsp.buildSpeechReport({
    f0Median: stats.median,
    f0RangeSt: stats.rangeSt,
    formants,
    cppMedian: cpp,
    rhythm,
  });

  return {
    report,
    meta: {
      f0: stats.median,
      rangeSt: stats.rangeSt,
      formants,
      cpp,
      rhythm,
    },
  };
}
