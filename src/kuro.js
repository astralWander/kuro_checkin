'use strict';
// 库街区（Kuro BBS）登录 API 客户端 —— 对应原仓库 modules/api/
const crypto = require('node:crypto');

const LOGIN_HEADER = {
  osversion: 'Android',
  countrycode: 'CN',
  model: 'MIX 2',
  source: 'android',
  lang: 'zh-Hans',
  version: '2.2.0',
  versioncode: '2200',
  channelid: '4',
  'content-type': 'application/x-www-form-urlencoded',
  'user-agent': 'okhttp/3.11.0',
};

const API = {
  sms: 'https://api.kurobbs.com/user/getSmsCode',
  login: 'https://api.kurobbs.com/user/sdkLogin',
  game3: 'https://api.kurobbs.com/gamer/widget/game3/getData',
};

/** 40 位大写十六进制设备号（对应原 generate_random_device） */
function generateRandomDevice() {
  return crypto.randomBytes(40).toString('hex').toUpperCase().slice(0, 40);
}

function distinctId() {
  return crypto.randomUUID();
}

/**
 * 组装请求头。
 *
 * 关于 token：原版 Python 用 cookies={"token": ...} 传递，但 Node 的 fetch
 * 遵循 WHATWG 规范会**静默丢弃** Cookie header（实测 headers.Cookie 和
 * Headers.set 都无效，服务端回「访问令牌不能为空」）。好在库街区也认
 * `token` 请求头，所以这里改用 header 传递。
 */
function buildHeaders({ token, devcode } = {}) {
  const h = { ...LOGIN_HEADER, devcode: devcode || generateRandomDevice() };
  if (token) h.token = token;
  return h;
}

async function postForm(url, data, { token, devcode } = {}) {
  const headers = buildHeaders({ token, devcode });

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(data).toString() });
  } catch (e) {
    throw new Error(`网络请求失败 [${url}]: ${e.message}`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`);
  }

  if (json.code !== 200) {
    const err = new Error(json.msg || '未知错误');
    err.code = json.code;
    err.traceId = json.traceId;
    throw err;
  }
  return json;
}

/** 发送短信验证码。geeTestData 为极验 seccode 的 JSON 字符串 */
async function sendSmsCode(mobile, geeTestData, opts = {}) {
  await postForm(API.sms, { mobile, geeTestData }, opts);
  return '验证码发送成功';
}

/** 手机号 + 短信验证码登录，返回 { token, userId, raw } */
async function sdkLogin(mobile, code, opts = {}) {
  const json = await postForm(API.login, { code, gameList: '', mobile }, opts);
  const data = json.data || {};
  if (!data.token) throw new Error('登录成功但未返回 token');
  return { token: data.token, userId: data.userId, raw: data };
}

/** 用 token 拉取角色信息，返回 { roleId, roleName, serverId, raw } */
async function fetchRoleSession(token, opts = {}) {
  const json = await postForm(API.game3, { type: '1', sizeType: '2' }, { ...opts, token });
  const data = json.data || {};
  return { roleId: data.roleId, roleName: data.roleName, serverId: data.serverId, raw: data };
}

/** 完整流程：登录 + 取角色，组装成 login_info.json 的内容 */
async function fetchLoginInfo(mobile, code) {
  const devcode = generateRandomDevice();
  const distinct = distinctId();

  const session = await sdkLogin(mobile, code, { devcode });
  const role = await fetchRoleSession(session.token, { devcode });

  const meta = {
    token: session.token,
    user_id: session.userId,
    role_id: role.roleId,
    role_name: role.roleName,
    server_id: role.serverId,
    device_id: generateRandomDevice(),
    distinct_id: distinct,
  };
  return { meta, session: session.raw, role: role.raw, devcode };
}

module.exports = {
  generateRandomDevice,
  distinctId,
  sendSmsCode,
  sdkLogin,
  fetchRoleSession,
  fetchLoginInfo,
  buildHeaders,
  LOGIN_HEADER,
  API,
};
