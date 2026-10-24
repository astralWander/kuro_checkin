'use strict';
// 每日定时签到 —— 对应 Kuro-autosignin 的 task_scheduler.py（原版靠 cron）
// 这里用自校正的单次 setTimeout：每次触发后重新计算「下一个 HH:MM」，
// 不累积漂移，也能自然应对系统时间/时区变化与进程长时间挂起。
const { listAccounts, getSettings, updateAccount, appendSignLog } = require('./store.js');
const { signAccount } = require('./signin.js');

const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout 上限约 24.8 天

let timer = null;
let running = false;
let lastRun = null; // { at, results }
let nextRunAt = null;
const listeners = new Set();

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* 监听器异常不影响调度 */
    }
  }
}

/** 计算下一个 HH:MM 的时间戳（固定按指定时区解释，不依赖服务器系统时区） */
const TIMEZONE = process.env.TIMEZONE || 'Asia/Shanghai';

/** 取某个时间戳在指定时区的年月日时分 */
function zonedParts(ts, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ts))) p[part.type] = part.value;
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24, // 某些环境午夜会给 24
    mi: Number(p.minute),
    s: Number(p.second),
  };
}

/** 把「指定时区的某个本地时刻」换算成 UTC 时间戳（迭代收敛，含跨日/跨月） */
function zonedToTs(y, mo, d, h, mi, tz) {
  const desired = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = desired;
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(ts, tz);
    const actual = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const err = desired - actual;
    if (err === 0) break;
    ts += err;
  }
  return ts;
}

function nextOccurrence(hhmm, from = Date.now(), tz = TIMEZONE) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;

  const now = zonedParts(from, tz);
  let target = zonedToTs(now.y, now.mo, now.d, hh, mm, tz);
  if (target <= from) {
    target = zonedToTs(now.y, now.mo, now.d + 1, hh, mm, tz);
  }
  return target;
}

/** 依次签所有启用的账号，返回结果数组 */
async function runAll(trigger = 'manual') {
  if (running) return { skipped: true, reason: '已有签到任务在执行' };
  running = true;
  emit({ type: 'start', trigger });

  const results = [];
  try {
    for (const acc of listAccounts()) {
      if (!acc.enable) {
        results.push({ id: acc.id, name: acc.name, ok: false, skipped: true, msgs: ['已停用，跳过'] });
        continue;
      }
      const r = await signAccount({
        token: acc.token,
        devcode: acc.devcode,
        distinctId: acc.distinctId,
        userId: acc.userId,
        wwroleId: acc.wwroleId,
        eeeroleId: acc.eeeroleId,
        autoReplenish: acc.autoReplenish,
      });

      const record = {
        at: Date.now(),
        ok: r.ok,
        msgs: r.msgs,
        trigger,
        fatal: r.fatal || null,
      };
      // 追加到历史日志（同时更新 lastSign）
      appendSignLog(acc.id, record);
      updateAccount(acc.id, {
        // 顺手回填补全到的信息
        ...(r.userId && !acc.userId ? { userId: r.userId } : {}),
        ...(r.ww && !acc.wwroleId ? { wwroleId: r.ww } : {}),
        ...(r.ee && !acc.eeeroleId ? { eeeroleId: r.ee } : {}),
      });

      results.push({ id: acc.id, name: acc.name, ok: r.ok, msgs: r.msgs, fatal: r.fatal });
      emit({ type: 'account', id: acc.id, name: acc.name, ok: r.ok, msgs: r.msgs });
    }
  } finally {
    running = false;
    lastRun = { at: Date.now(), results, trigger };
    emit({ type: 'done', results, trigger });
  }
  return { results };
}

/** 重排下一次触发（设置变更时调用） */
function reschedule() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const s = getSettings();
  if (!s.autoSign) {
    nextRunAt = null;
    emit({ type: 'schedule', nextRunAt: null });
    return;
  }
  const next = nextOccurrence(s.time);
  if (!next) {
    nextRunAt = null;
    emit({ type: 'schedule', nextRunAt: null, error: '时间格式不正确' });
    return;
  }
  nextRunAt = next;

  const delay = Math.min(Math.max(next - Date.now(), 0), MAX_TIMEOUT);
  timer = setTimeout(async () => {
    timer = null;
    // 到点了：先重排（保证即使签到抛错也不会停摆），再执行
    reschedule();
    await runAll('schedule');
  }, delay);
  if (timer.unref) timer.unref(); // 别拖住进程退出

  emit({ type: 'schedule', nextRunAt });
}

function status() {
  const s = getSettings();
  return {
    autoSign: s.autoSign,
    time: s.time,
    nextRunAt,
    nextRunLabel: nextRunAt ? formatLabel(nextRunAt) : null,
    timezone: TIMEZONE,
    lastRun,
    running,
  };
}

/** 生成「今天/明天 HH:MM」标签，按调度时区计算 */
function formatLabel(ts) {
  const t = zonedParts(ts, TIMEZONE);
  const n = zonedParts(Date.now(), TIMEZONE);
  const p = (x) => String(x).padStart(2, '0');
  const todayKey = `${n.y}-${n.mo}-${n.d}`;
  const targetKey = `${t.y}-${t.mo}-${t.d}`;
  let day;
  if (targetKey === todayKey) day = '今天';
  else {
    // 判断是不是明天：把今天的日期 +1 再比较
    const tomorrow = zonedParts(zonedToTs(n.y, n.mo, n.d + 1, 0, 0, TIMEZONE) + 12 * 3600e3, TIMEZONE);
    day = `${tomorrow.y}-${tomorrow.mo}-${tomorrow.d}` === targetKey ? '明天' : `${t.mo}月${t.d}日`;
  }
  return `${day} ${p(t.h)}:${p(t.mi)}`;
}

module.exports = { runAll, reschedule, status, onChange, nextOccurrence };
