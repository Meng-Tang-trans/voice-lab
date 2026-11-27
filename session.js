/*
 * 会话编排：用户自定时长的一句话 → 报告卡。
 * 录音长度由用户按「停止」决定，上限 60 秒。
 */
import * as dsp from './dsp.js';

export const MAX_SEC = 60;
export const MIN_SEC = 2;

/**
 * @param {Float32Array} x  16 kHz PCM，长度由用户决定
 * @returns {{report: object, meta: object}}
 */
export function analyzeSentence(x, direction = 'mtf') {
  const f0 = dsp.medianFilter(dsp.yinTrack(x), 5);
  const stats = dsp.f0Stats(f0);
  const formants = dsp.speechFormants(x, f0);
  const vtl = dsp.speechVTL(x, f0);
  const cpp = dsp.cppMedian(dsp.cppTrack(x));
  const rhythm = dsp.speechRhythm(x);

  const durationS = x.length / dsp.SR;
  const voicedS = rhythm ? rhythm.activeS : 0;
  const lowConf = voicedS < 3;

  const report = dsp.buildSpeechReport({
    f0Median: stats.median,
    f0RangeSt: stats.rangeSt,
    formants,
    cppMedian: cpp,
    rhythm,
    vtl,
    lowConf,
    durationS,
    voicedS,
    direction,
  });

  return {
    report,
    meta: {
      f0: stats.median,
      rangeSt: stats.rangeSt,
      formants,
      vtl,
      cpp,
      rhythm,
      durationS,
      voicedS,
      lowConf,
    },
  };
}
