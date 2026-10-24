'use strict';
// 极验 v4 滑块（库街区登录用）纯 Node 实现：
// load 取题 -> PoW 签名 -> 求缺口距离 -> 组装 track -> AES+RSA 生成 w -> verify 拿 seccode
//
// 对外暴露两层：
//   fetchChallenge()  取一道题（含图片），可自动求解也可交给人工滑
//   submitDistance()  用指定距离提交验证
//   solveCaptcha()    自动求解封装（失败时抛错，由上层决定是否转人工）
const crypto = require('node:crypto');

const CAPTCHA_ID = '3f7e2d848ce0cb7e7d019d621e556ce2';
const RSA_N = BigInt('0x' + '00C1E3934D1614465B33053E7F48EE4EC87B14B95EF88947713D25EECBFF7E74C7977D02DC1D9451F79DD5D1C10C29ACB6A9B4D6FB7D0A0279B6719E1772565F09AF627715919221AEF91899CAE08C0D686D748B20A3603BE2318CA6BC2B59706592A9219D0BF05C9F65023A21D2330807252AE0066D59CEEFA5F2748EA80BAB81');
const RSA_E_HEX = '010001'; // 注意：不能写 '10001'，奇数长度的 hex 会被 Buffer.from 截断
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const { matchTemplate } = require('./imagematch.js');

const nowMs = () => Date.now();

function randomString(len, alphabet = ALPHABET) {
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

// ---------- 极简 cookie jar ----------
class CookieJar {
  constructor() { this.store = new Map(); }
  update(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.store.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function httpGet(url, { jar } = {}) {
  const h = { 'User-Agent': UA, Accept: '*/*' };
  if (jar && jar.store.size) h.Cookie = jar.header();
  const res = await fetch(url, { headers: h, redirect: 'follow' });
  if (jar) jar.update(res);
  return res.text();
}

async function httpGetBinary(url, { jar } = {}) {
  const h = { 'User-Agent': UA, Accept: '*/*' };
  if (jar && jar.store.size) h.Cookie = jar.header();
  const res = await fetch(url, { headers: h });
  if (jar) jar.update(res);
  return Buffer.from(await res.arrayBuffer());
}

function parseJsonp(text) {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end < 0) throw new Error(`极验返回非 jsonp: ${text.slice(0, 160)}`);
  return JSON.parse(text.slice(start + 1, end));
}

// ---------- PoW / w 生成 ----------
function powSign(info, captchaId) {
  const d = info.pow_detail;
  const guid = randomString(16);
  const msg = [String(d.version), String(d.bits), d.hashfunc, d.datetime, String(captchaId), info.lot_number, guid].join('|');
  const sign = crypto.createHash(d.hashfunc).update(msg, 'utf8').digest('hex');
  return { msg, sign };
}

function rsaEncryptHex(plain) {
  const key = crypto.createPublicKey({
    key: {
      kty: 'RSA',
      n: Buffer.from(RSA_N.toString(16), 'hex').toString('base64url'),
      e: Buffer.from(RSA_E_HEX, 'hex').toString('base64url'),
    },
    format: 'jwk',
  });
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plain, 'utf8')).toString('hex');
}

function geetestW(track) {
  const key = randomString(16);
  const rsa = rsaEncryptHex(key);
  // 注意：极验的 IV 是 16 个 ASCII 字符 '0'（0x30），不是 16 个零字节
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from('0000000000000000', 'utf8'));
  const enc = Buffer.concat([cipher.update(JSON.stringify(track), 'utf8'), cipher.final()]).toString('hex');
  return enc + rsa;
}

// ---------- 取一道题 ----------
/**
 * 拉取一道极验题，返回挑战上下文。可重复用于提交不同距离。
 * 返回 { info, bgPng, slicePng, jar, callback, captchaId }
 */
async function fetchChallenge({ captchaId = CAPTCHA_ID } = {}) {
  const jar = new CookieJar();
  const callback = `geetest_${nowMs()}`;
  const url = `https://gcaptcha4.geetest.com/load?callback=${callback}`
    + `&captcha_id=${captchaId}&client_type=web&pt=1&lang=zho`;

  const loaded = parseJsonp(await httpGet(url, { jar }));
  if (loaded.status !== 'success' || !loaded.data) {
    throw new Error(`极验 load 失败: ${loaded.msg || loaded.status}`);
  }
  const info = loaded.data;
  if (info.captcha_type !== 'slide') {
    throw new Error(`不支持的验证码类型: ${info.captcha_type}`);
  }

  const [bgPng, slicePng] = await Promise.all([
    httpGetBinary(`https://static.geetest.com/${info.bg}`, { jar }),
    httpGetBinary(`https://static.geetest.com/${info.slice}`, { jar }),
  ]);

  return { info, bgPng, slicePng, jar, callback, captchaId };
}

// ---------- 用指定距离提交 ----------
/**
 * 提交一次滑块位置。
 * 返回 { ok, seccode?, reason?, raw }
 */
async function submitDistance(ctx, distance, { passtime = 1718 } = {}) {
  const { info, jar, callback, captchaId } = ctx;
  const { msg, sign } = powSign(info, captchaId);

  const track = {
    setLeft: distance,
    passtime,
    userresponse: distance / 1.0059466666666665 + 2,
    device_id: '',
    lot_number: info.lot_number,
    pow_msg: msg,
    pow_sign: sign,
    geetest: 'captcha',
    lang: 'zh',
    ep: '123',
    biht: '1426265548',
    dRjQ: '738u',
    em: { ph: 0, cp: 0, ek: '11', wd: 1, nt: 0, si: 0, sc: 0 },
  };

  const verifyUrl = 'https://gcaptcha4.geetest.com/verify?' + new URLSearchParams({
    callback,
    captcha_id: captchaId,
    client_type: 'web',
    lot_number: info.lot_number,
    payload: info.payload,
    process_token: info.process_token,
    payload_protocol: '1',
    pt: '1',
    w: geetestW(track),
  }).toString();

  const vr = parseJsonp(await httpGet(verifyUrl, { jar }));
  const data = vr.data || {};

  // 注意：极验的失败也是 status=success，必须看 data.result
  if (vr.status === 'success' && data.result === 'success' && data.seccode) {
    return { ok: true, seccode: JSON.stringify(data.seccode), raw: vr };
  }

  const reason = data.result === 'fail'
    ? `滑块位置不被接受（fail_count=${data.fail_count ?? 0}）`
    : (vr.msg || vr.status || '未知原因');
  return { ok: false, reason, raw: vr };
}

// ---------- 自动求解 ----------
/**
 * 自动破解一道题。maxAttempts 次内未通过则抛错（上层可转人工）。
 * onProgress 用于推送阶段状态。
 */
async function solveCaptcha({ captchaId = CAPTCHA_ID, onProgress = () => {}, maxAttempts = 3 } = {}) {
  let lastReason = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress({ stage: 'load', attempt });
    const ctx = await fetchChallenge({ captchaId });

    onProgress({ stage: 'solve', attempt });
    const solved = matchTemplate(ctx.bgPng, ctx.slicePng);

    onProgress({ stage: 'verify', attempt, distance: solved.distance });
    const result = await submitDistance(ctx, solved.distance);

    if (result.ok) {
      onProgress({ stage: 'done', attempt, distance: solved.distance });
      return {
        seccode: result.seccode,
        distance: solved.distance,
        y: solved.y,
        score: solved.score,
        bgPng: ctx.bgPng,
        slicePng: ctx.slicePng,
        lotNumber: ctx.info.lot_number,
        attempts: attempt,
        raw: result.raw,
      };
    }

    lastReason = result.reason;
    onProgress({ stage: 'retry', attempt, distance: solved.distance, msg: lastReason });
  }

  const err = new Error(`自动破解失败（${maxAttempts} 次）：${lastReason}`);
  err.code = 'CAPTCHA_FAILED';
  throw err;
}

module.exports = {
  solveCaptcha,
  fetchChallenge,
  submitDistance,
  matchTemplate,
  CookieJar,
  randomString,
  CAPTCHA_ID,
};
