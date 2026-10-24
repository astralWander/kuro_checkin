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

/** 计算下一个 HH:MM 的时间戳（本地时区） */
function nextOccurrence(hhmm, from = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;

  const d = new Date(from);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
  if (target.getTime() <= from) target.setDate(target.getDate() + 1);
  return target.getTime();
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
    lastRun,
    running,
  };
}

module.exports = { runAll, reschedule, status, onChange, nextOccurrence };
