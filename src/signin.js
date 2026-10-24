'use strict';
// 签到流程 —— 移植自 Kuro-autosignin 的 game_sign_in.py / forum_sign_in.py
// 每个函数返回「面向人的消息数组」，便于直接在界面上展示
const { API, GAMES, CODE, KuroClient } = require('./bbs.js');

const TASK_NAME = {
  SIGN_IN: '用户签到',
  VIEW_POSTS: '浏览3篇帖子',
  LIKE_POSTS: '点赞5次',
  SHARE_POST: '分享1次帖子',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** token 失效或用户信息异常时抛出，上层据此禁用账号 */
class TokenExpiredError extends Error {
  constructor(msg) {
    super(msg || '登录已过期');
    this.kind = 'expired';
  }
}
class UserInfoError extends Error {
  constructor(msg) {
    super(msg || '用户信息异常');
    this.kind = 'userinfo';
  }
}

/* ---------------- 账号信息补全 ---------------- */

/** 拉 userId + 两款游戏的 roleId（对应 config_manager.fill_config） */
async function fetchAccountInfo(client) {
  const mine = await client.userPost(API.USER_MINE);
  if (mine.code === CODE.LOGIN_EXPIRED) throw new TokenExpiredError();
  if (!mine.ok) throw new Error(`获取用户信息失败: ${mine.msg}`);

  const userId = mine.data?.mine?.userId;
  if (!userId) throw new Error('接口未返回 userId');

  const out = { userId, gameInfo: {} };

  for (const gameId of [3, 2]) {
    try {
      const r = await client.userPost(API.USER_ROLE_LIST, { gameId: String(gameId) });
      if (r.code === CODE.LOGIN_EXPIRED) throw new TokenExpiredError();
      if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
        const role = r.data[0];
        out.gameInfo[gameId === 3 ? 'wwroleId' : 'eeeroleId'] = role.roleId;
        if (!out.nickname && role.roleName) out.nickname = role.roleName;
      }
    } catch (e) {
      if (e instanceof TokenExpiredError) throw e;
      // 单款游戏查不到不影响整体
    }
  }

  return out;
}

/* ---------------- 游戏签到 ---------------- */

async function signGame(client, gameId, roleId, userId, { autoReplenish = false } = {}) {
  const game = GAMES[gameId];
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  const base = {
    gameId: String(gameId),
    serverId: game.serverId,
    roleId: String(roleId),
    userId: String(userId),
  };

  const r = await client.gamePost(API.GAME_SIGN_IN, { ...base, reqMonth: month });

  if (r.code === CODE.LOGIN_EXPIRED) throw new TokenExpiredError(`${game.name} 签到：登录已过期`);
  if (r.code === CODE.USER_INFO_ERROR) throw new UserInfoError(`${game.name} 签到：用户信息异常`);

  let msg;
  if (r.code === CODE.SUCCESS || r.code === CODE.ALREADY_SIGNED) {
    const reward = await gameReward(client, gameId, base);
    msg = `${game.name}${r.code === CODE.SUCCESS ? '签到成功' : '今天已签到'}`;
    if (reward) msg += `，奖励：${reward}`;
  } else {
    return { ok: false, msg: `${game.name}签到失败：${r.msg}（${r.code}）` };
  }

  if (autoReplenish) {
    try {
      const init = await client.gamePost(API.GAME_SIGN_INIT, base);
      const omission = init.ok ? Number(init.data?.omissionNum || 0) : 0;
      if (omission > 0) {
        const rp = await client.gamePost(API.GAME_REPLENISH_SIGN, { ...base, reqMonth: month });
        if (rp.code === CODE.SUCCESS) {
          const reward = await gameReward(client, gameId, base);
          msg += `；已补签 ${omission} 天${reward ? `（${reward}）` : ''}`;
        } else {
          msg += `；补签失败：${rp.msg}`;
        }
      }
    } catch {
      // 补签是尽力而为，失败不阻断
    }
  }

  return { ok: true, msg };
}

async function gameReward(client, gameId, base) {
  try {
    const r = await client.gamePost(API.GAME_SIGN_RECORD, base);
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
      return r.data[0].goodsName || '未知奖励';
    }
  } catch {
    /* 拿不到奖励名不影响签到结果 */
  }
  return null;
}

/* ---------------- 论坛任务 ---------------- */

async function forumTasks(client) {
  const msgs = [];

  // 任务列表（先取一次，已完成的不再重复做）
  const taskList = await client.bbsPost(API.TASK_PROCESS, { gameId: '0' });
  if (taskList.code === CODE.LOGIN_EXPIRED) throw new TokenExpiredError();

  const tasks = taskList.ok ? taskList.data?.dailyTask || [] : [];
  const pending = tasks.filter((t) => Number(t.process) !== 1);

  let posts = null;
  const getPosts = async () => {
    if (posts) return posts;
    const r = await client.bbsPost(API.FORUM_LIST, {
      forumId: '9',
      gameId: '3',
      pageIndex: '1',
      pageSize: '20',
      searchType: '3',
      timeType: '0',
    });
    if (r.code === CODE.LOGIN_EXPIRED) throw new TokenExpiredError();
    posts = r.ok ? r.data?.postList || [] : [];
    return posts;
  };

  for (const task of pending) {
    const remark = task.remark || '';
    try {
      if (remark === TASK_NAME.SIGN_IN) {
        const r = await client.bbsPost(API.USER_SIGN_IN, { gameId: '2' });
        if (r.code === CODE.LOGIN_EXPIRED) throw new TokenExpiredError();
        msgs.push(`论坛签到：${r.ok ? '成功' : r.msg || '失败'}`);
      } else if (remark === TASK_NAME.VIEW_POSTS) {
        const list = await getPosts();
        let n = 0;
        for (const p of list.slice(0, 3)) {
          const r = await client.bbsPost(API.FORUM_POST_DETAIL, {
            isOnlyPublisher: '0',
            postId: p.postId,
            showOrderTyper: '2',
          });
          if (r.ok) n += 1;
          await sleep(800);
        }
        msgs.push(`浏览帖子：${n}/3`);
      } else if (remark === TASK_NAME.LIKE_POSTS) {
        const list = await getPosts();
        let n = 0;
        for (const p of list.slice(0, 5)) {
          const r = await client.bbsPost(API.FORUM_LIKE, {
            forumId: 11,
            gameId: 3,
            likeType: 1,
            operateType: 1,
            postCommentId: '',
            postCommentReplyId: '',
            postId: p.postId,
            postType: 1,
            toUserId: p.userId,
          });
          if (r.ok) n += 1;
          await sleep(800);
        }
        msgs.push(`点赞：${n}/5`);
      } else if (remark === TASK_NAME.SHARE_POST) {
        const r = await client.bbsPost(API.TASK_SHARE, { gameId: 3 });
        msgs.push(`分享帖子：${r.ok ? '成功' : r.msg || '失败'}`);
      }
      await sleep(600);
    } catch (e) {
      if (e instanceof TokenExpiredError) throw e;
      msgs.push(`${remark}：异常 ${e.message}`);
    }
  }

  // 汇总金币
  try {
    const after = await client.bbsPost(API.TASK_PROCESS, { gameId: '0' });
    if (after.ok) {
      const list = after.data?.dailyTask || [];
      const gain = list
        .filter((t) => Number(t.process) === 1)
        .reduce((s, t) => s + Number(t.gainGold || 0), 0);
      const gold = await client.bbsPost(API.GOLD_TOTAL);
      let line = `今日任务金币：+${gain}`;
      if (gold.ok) line += `，余额 ${gold.data?.goldNum ?? '?'}`;
      msgs.push(line);
    }
  } catch {
    /* 汇总失败不影响签到 */
  }

  if (msgs.length === 0) msgs.push('论坛任务今天已完成');
  return msgs;
}

/* ---------------- 单账号完整签到 ---------------- */

/**
 * @param {object} account  { token, devcode, distinctId, userId, wwroleId, eeeroleId, autoReplenish }
 * @returns {{ok:boolean, msgs:string[], fatal?:string}}
 */
async function signAccount(account) {
  const client = new KuroClient({
    token: account.token,
    devcode: account.devcode,
    distinctId: account.distinctId,
  });

  const msgs = [];
  try {
    // 信息不全就先补全
    let userId = account.userId;
    let ww = account.wwroleId;
    let ee = account.eeeroleId;

    if (!userId || (!ww && !ee)) {
      const info = await fetchAccountInfo(client);
      userId = userId || info.userId;
      ww = ww || info.gameInfo.wwroleId;
      ee = ee || info.gameInfo.eeeroleId;
    }

    if (ww) {
      const r = await signGame(client, 3, ww, userId, { autoReplenish: account.autoReplenish });
      msgs.push(r.msg);
    }
    if (ee) {
      const r = await signGame(client, 2, ee, userId, { autoReplenish: account.autoReplenish });
      msgs.push(r.msg);
    }
    if (!ww && !ee) msgs.push('未绑定任何游戏角色，仅执行论坛任务');

    msgs.push(...(await forumTasks(client)));

    return { ok: true, msgs, userId, ww, ee };
  } catch (e) {
    if (e instanceof TokenExpiredError) {
      return { ok: false, msgs: [...msgs, '登录已过期，请重新登录该账号'], fatal: 'expired' };
    }
    if (e instanceof UserInfoError) {
      return { ok: false, msgs: [...msgs, '用户信息异常，请重新登录该账号'], fatal: 'userinfo' };
    }
    return { ok: false, msgs: [...msgs, `签到异常：${e.message}`], fatal: 'error' };
  }
}

module.exports = { signAccount, fetchAccountInfo, signGame, forumTasks, TokenExpiredError, UserInfoError };
