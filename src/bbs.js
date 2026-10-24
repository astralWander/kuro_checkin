'use strict';
// 库街区签到 API 客户端 —— 移植自 Kuro-autosignin 的 constants.py / http_client.py
//
// 注意：Python 版同时发 Cookie: user_token=xxx 和 token 头。Node 的 fetch 会
// 静默丢弃 Cookie（WHATWG 禁止修改），实测只发 token 头即可正常鉴权 ——
// 假 token 返回 220「登录已过期」而不是「访问令牌不能为空」，说明令牌送达了。
const os = require('node:os');

const API = {
  USER_MINE: 'https://api.kurobbs.com/user/mineV2',
  USER_SIGN_IN: 'https://api.kurobbs.com/user/signIn',
  USER_ROLE_LIST: 'https://api.kurobbs.com/user/role/findRoleList',

  FORUM_LIST: 'https://api.kurobbs.com/forum/list',
  FORUM_POST_DETAIL: 'https://api.kurobbs.com/forum/getPostDetail',
  FORUM_LIKE: 'https://api.kurobbs.com/forum/like',

  TASK_PROCESS: 'https://api.kurobbs.com/encourage/level/getTaskProcess',
  TASK_SHARE: 'https://api.kurobbs.com/encourage/level/shareTask',
  GOLD_TOTAL: 'https://api.kurobbs.com/encourage/gold/getTotalGold',

  GAME_SIGN_IN: 'https://api.kurobbs.com/encourage/signIn/v2',
  GAME_SIGN_RECORD: 'https://api.kurobbs.com/encourage/signIn/queryRecordV2',
  GAME_SIGN_INIT: 'https://api.kurobbs.com/encourage/signIn/initSignInV2',
  GAME_REPLENISH_SIGN: 'https://api.kurobbs.com/encourage/signIn/repleSigInV2',
};

/** gameId → 名称与 serverId（对应 constants.py 的 GameType） */
const GAMES = {
  3: { name: '鸣潮', serverId: '76402e5b20be2c39f095a152090afddc' },
  2: { name: '战双', serverId: '1000' },
};

const CODE = {
  SUCCESS: 200,
  ALREADY_SIGNED: 1511,
  USER_INFO_ERROR: 1513,
  LOGIN_EXPIRED: 220,
};

const COMMON = {
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
};

const BBS_HEADERS = {
  ...COMMON,
  Host: 'api.kurobbs.com',
  source: 'ios',
  lang: 'zh-Hans',
  'User-Agent': 'KuroGameBox/48 CFNetwork/1492.0.1 Darwin/23.3.0',
  channelId: '1',
  channel: 'appstore',
  version: '2.2.0',
  model: 'iPhone15,2',
  osVersion: '17.3',
  'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
};

const GAME_HEADERS = {
  ...COMMON,
  Host: 'api.kurobbs.com',
  Accept: 'application/json, text/plain, */*',
  'Sec-Fetch-Site': 'same-site',
  source: 'ios',
  'Sec-Fetch-Mode': 'cors',
  Origin: 'https://web-static.kurobbs.com',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) KuroGameBox/2.2.0',
  'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
};

const USER_HEADERS = {
  osversion: 'Android',
  countrycode: 'CN',
  ip: '10.0.2.233',
  model: '2211133C',
  source: 'android',
  lang: 'zh-Hans',
  version: '1.0.9',
  versioncode: '1090',
  'content-type': 'application/x-www-form-urlencoded',
  'accept-encoding': 'gzip',
  'user-agent': 'okhttp/3.10.0',
};

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) KuroGameBox/2.2.0';

/** 本机局域网 IPv4（对应 Python 的 get_ip_address，沙箱里取不到时回落到 127.0.0.1） */
function localIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

class KuroClient {
  constructor({ token, devcode, distinctId } = {}) {
    this.token = token || '';
    this.devcode = devcode || '';
    this.distinctId = distinctId || '';
    this.ip = localIp();
  }

  bbsHeaders() {
    return {
      ...BBS_HEADERS,
      Ip: this.ip,
      devCode: this.devcode,
      distinct_id: this.distinctId,
      token: this.token,
    };
  }

  gameHeaders() {
    return {
      ...GAME_HEADERS,
      devCode: `${this.ip}, ${UA_IPHONE}`,
      token: this.token,
    };
  }

  userHeaders() {
    return {
      ...USER_HEADERS,
      devcode: this.devcode,
      distinct_id: this.distinctId,
      token: this.token,
    };
  }

  async post(url, headers, data = {}, timeoutMs = 20000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: new URLSearchParams(data).toString(),
        signal: ac.signal,
      });
    } catch (e) {
      throw new Error(
        e.name === 'AbortError' ? `请求超时 [${url}]` : `网络请求失败 [${url}]: ${e.message}`
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`接口返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 120)}`);
    }
    return {
      code: json.code,
      msg: json.msg || '',
      data: json.data,
      ok: json.code === CODE.SUCCESS,
    };
  }

  bbsPost(url, data) {
    return this.post(url, this.bbsHeaders(), data);
  }
  gamePost(url, data) {
    return this.post(url, this.gameHeaders(), data);
  }
  userPost(url, data) {
    return this.post(url, this.userHeaders(), data);
  }
}

module.exports = { API, GAMES, CODE, KuroClient, localIp };
