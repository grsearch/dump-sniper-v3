'use strict';

/**
 * Beijing Time (UTC+8) helpers.
 * BJT 不实行夏令时，固定 UTC+8。
 */

const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;

function nowBjt() {
  return new Date(Date.now() + BJT_OFFSET_MS);
}

function bjtIsoString(date = new Date()) {
  const bjt = new Date(date.getTime() + BJT_OFFSET_MS);
  return bjt.toISOString().replace('Z', '+08:00').replace('T', ' ').slice(0, 19);
}

function bjtDateString(date = new Date()) {
  const bjt = new Date(date.getTime() + BJT_OFFSET_MS);
  return bjt.toISOString().slice(0, 10);
}

/**
 * 给定一个 UTC 时间戳，返回它对应的 BJT 自然日范围 [startMs, endMs)。
 */
function bjtDayRange(date = new Date()) {
  const bjtNow = new Date(date.getTime() + BJT_OFFSET_MS);
  const y = bjtNow.getUTCFullYear();
  const m = bjtNow.getUTCMonth();
  const d = bjtNow.getUTCDate();
  // BJT 当天 00:00 = UTC 当天 00:00 - 8h
  const bjtMidnightUtc = Date.UTC(y, m, d) - BJT_OFFSET_MS;
  return {
    startMs: bjtMidnightUtc,
    endMs: bjtMidnightUtc + 24 * 60 * 60 * 1000,
    dateStr: bjtDateString(date),
  };
}

module.exports = { nowBjt, bjtIsoString, bjtDateString, bjtDayRange };
