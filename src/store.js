'use strict';
// 账号与设置持久化 —— 对应 Kuro-autosignin 的 config/*.yaml
// 改成一个 JSON 文件，前端直接读写，不必手工编辑 YAML
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'accounts.json');

const DEFAULT = {
  settings: {
    autoSign: true,
    time: '08:30', // 每天自动签到的时刻 HH:MM
    autoReplenish: true, // 是否自动补签
    lastScheduleAt: 0, // 上一次定时签到实际执行的时间戳，用于判断是否漏跑
  },
  accounts: [],
};

let cache = null;
let cacheMtime = 0;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 带 mtime 校验的加载：文件被外部改过（手动编辑 / 另一个进程）时自动重读，
 * 避免长期运行的服务守着过期缓存。
 */
function load() {
  ensureDir();
  let mtime = 0;
  try {
    mtime = fs.statSync(FILE).mtimeMs;
  } catch {
    /* 文件还不存在 */
  }
  if (cache && mtime === cacheMtime) return cache;
  cacheMtime = mtime;
  if (!fs.existsSync(FILE)) {
    cache = JSON.parse(JSON.stringify(DEFAULT));
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = {
      settings: { ...DEFAULT.settings, ...(raw.settings || {}) },
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    };
  } catch {
    // 文件损坏时保留备份，避免静默丢数据
    try {
      fs.renameSync(FILE, `${FILE}.broken-${Date.now()}`);
    } catch {
      /* ignore */
    }
    cache = JSON.parse(JSON.stringify(DEFAULT));
  }
  return cache;
}

function save() {
  ensureDir();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
  try {
    cacheMtime = fs.statSync(FILE).mtimeMs;
  } catch {
    /* ignore */
  }
  return cache;
}

function listAccounts() {
  return load().accounts;
}

function getAccount(id) {
  return load().accounts.find((a) => a.id === id) || null;
}

/** 对外输出时脱敏 token；history 单独走 /logs 接口，不塞进列表 */
function publicAccount(a) {
  const t = a.token || '';
  const { history, ...rest } = a;
  return {
    ...rest,
    token: t ? `${t.slice(0, 6)}…${t.slice(-4)}` : '',
    hasToken: Boolean(t),
    logCount: Array.isArray(history) ? history.length : 0,
  };
}

function addAccount(data) {
  const db = load();
  const acc = {
    id: crypto.randomUUID(),
    name: (data.name || '').trim() || '未命名账号',
    token: data.token,
    devcode: data.devcode || crypto.randomUUID(),
    distinctId: data.distinctId || crypto.randomUUID(),
    userId: data.userId || '',
    wwroleId: data.wwroleId || '',
    eeeroleId: data.eeeroleId || '',
    autoReplenish: data.autoReplenish !== false,
    enable: true,
    createdAt: Date.now(),
    lastSign: null,
    history: [],
  };
  db.accounts.push(acc);
  save();
  return acc;
}

function updateAccount(id, patch) {
  const db = load();
  const acc = db.accounts.find((a) => a.id === id);
  if (!acc) return null;
  const allowed = [
    'name',
    'enable',
    'autoReplenish',
    'token',
    'userId',
    'wwroleId',
    'eeeroleId',
    'devcode',
    'distinctId',
    'lastSign',
    'history',
  ];
  for (const k of allowed) {
    if (k in patch) acc[k] = patch[k];
  }
  save();
  return acc;
}

/**
 * 追加一条签到日志。
 * 同时更新 lastSign（卡片摘要用）与 history（日志弹窗用），
 * history 只保留最近 MAX_HISTORY 条，避免文件无限膨胀。
 */
const MAX_HISTORY = 60;

function appendSignLog(id, record) {
  const db = load();
  const acc = db.accounts.find((a) => a.id === id);
  if (!acc) return null;
  acc.lastSign = record;
  if (!Array.isArray(acc.history)) acc.history = [];
  acc.history.unshift(record);
  if (acc.history.length > MAX_HISTORY) acc.history.length = MAX_HISTORY;
  save();
  return acc;
}

function removeAccount(id) {
  const db = load();
  const i = db.accounts.findIndex((a) => a.id === id);
  if (i < 0) return false;
  db.accounts.splice(i, 1);
  save();
  return true;
}

/** 对外返回的设置（内部字段不暴露给前端） */
function getSettings() {
  const s = load().settings;
  return {
    autoSign: s.autoSign,
    time: s.time,
    autoReplenish: s.autoReplenish,
  };
}

/** 内部读取，含 lastScheduleAt 等调度状态 */
function getSettingsInternal() {
  return load().settings;
}

function updateSettings(patch) {
  const db = load();
  db.settings = { ...db.settings, ...patch };
  save();
  return db.settings;
}

module.exports = {
  DATA_DIR,
  FILE,
  listAccounts,
  getAccount,
  publicAccount,
  addAccount,
  updateAccount,
  removeAccount,
  appendSignLog,
  getSettings,
  getSettingsInternal,
  updateSettings,
  save,
  load,
};
