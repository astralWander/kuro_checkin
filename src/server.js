'use strict';
// 库街区账号管家 —— 登录取 Token + 每日自动签到
//
// 接口：
//   POST   /api/sms                     手机号 → 服务端自动破滑块并发短信
//   POST   /api/captcha/manual          兜底：取题给前端人工滑
//   POST   /api/captcha/submit          兜底：提交人工滑动距离
//   POST   /api/accounts                登录 + 补全角色信息 + 入库 + 立即签到一次
//   GET    /api/accounts                账号列表（token 脱敏）
//   PATCH  /api/accounts/:id            改名 / 启停 / 自动补签
//   DELETE /api/accounts/:id            删除
//   POST   /api/accounts/:id/sign       单账号立即签到
//   POST   /api/sign/all                全部立即签到
//   GET    /api/status                  调度状态 + 最近一次结果
//   GET    /api/settings  PATCH         自动签到开关与时间
//   GET    /api/events                  SSE 实时进度
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { solveCaptcha, fetchChallenge, submitDistance } = require('./geetest.js');
const kuro = require('./kuro.js');
const store = require('./store.js');
const scheduler = require('./scheduler.js');
const { signAccount, fetchAccountInfo } = require('./signin.js');
const { KuroClient } = require('./bbs.js');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MOBILE_RE = /^1[3-9]\d{9}$/;
const MANUAL_TTL_MS = 5 * 60 * 1000;

/** 人工兜底的挑战上下文：id -> { ctx, bg, slice, createdAt } */
const manualSessions = new Map();

/** SSE 连接池 */
const sseClients = new Set();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of manualSessions) {
    if (now - s.createdAt > MANUAL_TTL_MS) manualSessions.delete(id);
  }
}, 60_000).unref();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------------- SSE ---------------- */
function sseBroadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// 调度器的事件直接转发给前端
scheduler.onChange(sseBroadcast);

/* ---------------- 静态资源 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

/* ---------------- 工具 ---------------- */
function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new HttpError(413, '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getManual(id) {
  const s = manualSessions.get(id);
  if (!s) throw new HttpError(404, '验证码已过期，请重新获取');
  if (Date.now() - s.createdAt > MANUAL_TTL_MS) {
    manualSessions.delete(id);
    throw new HttpError(410, '验证码已过期，请重新获取');
  }
  return s;
}

/** 后台跑一次签到，结果通过 SSE 推送 */
async function signInBackground(account, trigger = 'new') {
  const r = await signAccount({
    token: account.token,
    devcode: account.devcode,
    distinctId: account.distinctId,
    userId: account.userId,
    wwroleId: account.wwroleId,
    eeeroleId: account.eeeroleId,
    autoReplenish: account.autoReplenish,
  });

  const record = {
    at: Date.now(),
    ok: r.ok,
    msgs: r.msgs,
    trigger,
    fatal: r.fatal || null,
  };
  // 追加到历史日志（同时更新 lastSign）
  store.appendSignLog(account.id, record);
  store.updateAccount(account.id, {
    ...(r.userId && !account.userId ? { userId: r.userId } : {}),
    ...(r.ww && !account.wwroleId ? { wwroleId: r.ww } : {}),
    ...(r.ee && !account.eeeroleId ? { eeeroleId: r.ee } : {}),
  });

  sseBroadcast({ type: 'account', id: account.id, name: account.name, ok: r.ok, msgs: r.msgs });
  return r;
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, urlPath) {
  /* ---- 登录取 token（原登录页逻辑） ---- */
  if (urlPath === '/api/sms' && req.method === 'POST') {
    const { mobile } = await readBody(req);
    if (!MOBILE_RE.test(String(mobile || ''))) {
      throw new HttpError(400, '请输入正确的 11 位手机号');
    }
    try {
      const solved = await solveCaptcha({ maxAttempts: 3 });
      await kuro.sendSmsCode(mobile, solved.seccode);
      return sendJson(res, 200, {
        ok: true,
        mode: 'auto',
        captcha: {
          distance: solved.distance,
          y: solved.y,
          score: Number(solved.score.toFixed(4)),
          attempts: solved.attempts,
        },
      });
    } catch (err) {
      if (err.code !== 'CAPTCHA_FAILED') throw err;
      return sendJson(res, 200, { ok: false, needManual: true, error: '自动验证未通过，请手动完成滑块' });
    }
  }

  if (urlPath === '/api/captcha/manual' && req.method === 'POST') {
    const ctx = await fetchChallenge();
    const id = crypto.randomBytes(12).toString('hex');
    manualSessions.set(id, { ctx, bg: ctx.bgPng, slice: ctx.slicePng, createdAt: Date.now() });
    return sendJson(res, 200, { ok: true, id, y: ctx.info.ypos ?? null });
  }

  const imgMatch = urlPath.match(/^\/api\/captcha\/manual\/([0-9a-f]+)\/(bg|slice)\.png$/);
  if (imgMatch && req.method === 'GET') {
    const s = getManual(imgMatch[1]);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    return res.end(imgMatch[2] === 'bg' ? s.bg : s.slice);
  }

  if (urlPath === '/api/captcha/submit' && req.method === 'POST') {
    const { id, distance, mobile } = await readBody(req);
    const s = getManual(id);
    const d = Number(distance);
    if (!Number.isFinite(d) || d < 0 || d > 300) throw new HttpError(400, '滑块位置无效');

    const result = await submitDistance(s.ctx, Math.round(d));
    if (!result.ok) return sendJson(res, 200, { ok: false, error: result.reason });
    manualSessions.delete(id);

    if (mobile && MOBILE_RE.test(String(mobile))) {
      await kuro.sendSmsCode(mobile, result.seccode);
      return sendJson(res, 200, { ok: true, sent: true });
    }
    return sendJson(res, 200, { ok: true, sent: false });
  }

  /* ---- 账号管理 ---- */
  if (urlPath === '/api/accounts' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      accounts: store.listAccounts().map(store.publicAccount),
      settings: store.getSettings(),
      status: scheduler.status(),
    });
  }

  // 登录 → 补全信息 → 入库 → 立即签到一次
  if (urlPath === '/api/accounts' && req.method === 'POST') {
    const { mobile, code, name } = await readBody(req);
    if (!MOBILE_RE.test(String(mobile || ''))) throw new HttpError(400, '请输入正确的 11 位手机号');
    if (!/^\d{4,8}$/.test(String(code || ''))) throw new HttpError(400, '请输入收到的短信验证码');

    const { meta } = await kuro.fetchLoginInfo(mobile, code);

    // 用新 token 补齐 userId 与两款游戏的角色 ID
    const client = new KuroClient({
      token: meta.token,
      devcode: meta.device_id,
      distinctId: meta.distinct_id,
    });
    let info = { userId: meta.user_id || '', gameInfo: {}, nickname: '' };
    try {
      info = await fetchAccountInfo(client);
    } catch (e) {
      if (e.kind === 'expired') throw new HttpError(401, '登录已过期，请重新获取验证码');
      // 补全失败不阻断添加，之后签到时还会再试
    }

    // 重名自动加后缀，避免列表里分不清
    const nickname = (name || info.nickname || `账号${mobile.slice(-4)}`).trim();
    const existing = new Set(store.listAccounts().map((a) => a.name));
    let finalName = nickname;
    let n = 2;
    while (existing.has(finalName)) finalName = `${nickname} ${n++}`;

    const account = store.addAccount({
      name: finalName,
      token: meta.token,
      devcode: meta.device_id,
      distinctId: meta.distinct_id,
      userId: info.userId || meta.user_id,
      wwroleId: info.gameInfo?.wwroleId || (meta.role_id || ''),
      eeeroleId: info.gameInfo?.eeeroleId || '',
      autoReplenish: store.getSettings().autoReplenish,
    });

    // 先返回，签到在后台跑（结果走 SSE）
    setImmediate(() => {
      signInBackground(account).catch((e) =>
        sseBroadcast({ type: 'account', id: account.id, name: account.name, ok: false, msgs: [e.message] })
      );
    });

    return sendJson(res, 200, {
      ok: true,
      account: store.publicAccount(account),
      meta,
      signing: true,
    });
  }

  const accMatch = urlPath.match(/^\/api\/accounts\/([0-9a-zA-Z-]+)$/);
  if (accMatch) {
    const id = accMatch[1];
    if (req.method === 'PATCH') {
      const patch = await readBody(req);
      const acc = store.updateAccount(id, patch);
      if (!acc) throw new HttpError(404, '账号不存在');
      return sendJson(res, 200, { ok: true, account: store.publicAccount(acc) });
    }
    if (req.method === 'DELETE') {
      if (!store.removeAccount(id)) throw new HttpError(404, '账号不存在');
      return sendJson(res, 200, { ok: true });
    }
  }

  const signMatch = urlPath.match(/^\/api\/accounts\/([0-9a-zA-Z-]+)\/sign$/);
  if (signMatch && req.method === 'POST') {
    const acc = store.getAccount(signMatch[1]);
    if (!acc) throw new HttpError(404, '账号不存在');
    sseBroadcast({ type: 'start', trigger: 'single', id: acc.id, name: acc.name });
    const r = await signInBackground(acc, 'single');
    sseBroadcast({ type: 'done', results: [{ id: acc.id, name: acc.name, ok: r.ok, msgs: r.msgs }] });
    return sendJson(res, 200, { ok: r.ok, msgs: r.msgs, account: store.publicAccount(store.getAccount(acc.id)) });
  }

  // 签到日志
  const logMatch = urlPath.match(/^\/api\/accounts\/([0-9a-zA-Z-]+)\/logs$/);
  if (logMatch && req.method === 'GET') {
    const acc = store.getAccount(logMatch[1]);
    if (!acc) throw new HttpError(404, '账号不存在');
    const history = Array.isArray(acc.history) ? acc.history : [];
    return sendJson(res, 200, {
      ok: true,
      name: acc.name,
      logs: history,
      total: history.length,
    });
  }

  if (urlPath === '/api/sign/all' && req.method === 'POST') {
    const out = await scheduler.runAll('manual');
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (urlPath === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, status: scheduler.status() });
  }

  if (urlPath === '/api/settings') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, settings: store.getSettings(), status: scheduler.status() });
    }
    if (req.method === 'PATCH' || req.method === 'POST') {
      const patch = await readBody(req);
      const clean = {};
      if ('autoSign' in patch) clean.autoSign = Boolean(patch.autoSign);
      if ('autoReplenish' in patch) clean.autoReplenish = Boolean(patch.autoReplenish);
      if ('time' in patch) {
        if (!scheduler.nextOccurrence(patch.time)) throw new HttpError(400, '时间格式应为 HH:MM');
        clean.time = String(patch.time);
      }
      const settings = store.updateSettings(clean);
      scheduler.reschedule();
      return sendJson(res, 200, { ok: true, settings, status: scheduler.status() });
    }
  }

  if (urlPath === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', status: scheduler.status() })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* 连接已断 */
      }
    }, 25_000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  throw new HttpError(404, '接口不存在');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      if (!(err instanceof HttpError)) console.error('[api]', err);
      if (!res.headersSent) {
        sendJson(res, status, { ok: false, error: err.message || '服务异常', code: err.code });
      }
    }
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  scheduler.reschedule();
  console.log(`库街区账号管家已启动: http://${HOST}:${PORT}`);
  const s = store.getSettings();
  console.log(
    s.autoSign
      ? `自动签到已开启，每天 ${s.time}`
      : '自动签到未开启'
  );
});
