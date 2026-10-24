'use strict';
// 库街区账号管家 —— 首页账号列表 + 弹窗登录 + 每日自动签到
// 动效沿用 anime.js v4 的既有封装（含"僵尸动画"防护）
(() => {
  const $ = (s) => document.querySelector(s);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const { animate, createTimeline, stagger, utils, engine } = window.anime;

  /**
   * 关掉 v4 内置的「页面隐藏就暂停引擎」。
   * resume() 只翻转 paused 标志、不重算时间基准 → 后台冻结的动画会在
   * 滚动/切回时"欠账补播"。显隐由我们自己处理。
   */
  if (engine) engine.pauseOnDocumentHidden = false;

  const el = {
    headSub: $('#headSub'),

    swAuto: $('#swAuto'),
    signTime: $('#signTime'),
    nextRun: $('#nextRun'),
    swReplenish: $('#swReplenish'),

    accCount: $('#accCount'),
    accounts: $('#accounts'),
    empty: $('#empty'),
    btnSignAll: $('#btnSignAll'),
    btnAdd: $('#btnAdd'),

    // 登录弹窗
    loginBackdrop: $('#loginBackdrop'),
    loginWrap: $('#loginWrap'),
    loginModal: $('#loginModal'),
    form: $('#form'),
    mobile: $('#mobile'),
    btnSend: $('#btnSend'),
    code: $('#code'),
    btnLogin: $('#btnLogin'),
    btnLoginClose: $('#btnLoginClose'),
    msg: $('#msg'),

    // 日志弹窗
    logBackdrop: $('#logBackdrop'),
    logWrap: $('#logWrap'),
    logModal: $('#logModal'),
    logSub: $('#logSub'),
    logBody: $('#logBody'),
    btnLogClose: $('#btnLogClose'),

    // 手动滑块
    backdrop: $('#sheetBackdrop'),
    sheetWrap: $('#sheetWrap'),
    sheet: $('#sheet'),
    sheetMsg: $('#sheetMsg'),
    canvas: $('#captchaCanvas'),
    captchaBg: $('#captchaBg'),
    captchaPiece: $('#captchaPiece'),
    slider: $('#slider'),
    sliderHint: $('#sliderHint'),
    sliderTrack: $('#sliderTrack'),
    sliderThumb: $('#sliderThumb'),
    btnRetryAuto: $('#btnRetryAuto'),
    btnSheetClose: $('#btnSheetClose'),

    toast: $('#toast'),
    toastText: $('#toastText'),
  };

  const state = {
    accounts: [],
    settings: { autoSign: true, time: '08:30', autoReplenish: true },
    status: {},
    manual: null,      // { id, mobile }
    dragging: false,
    submitting: false,
    signingAll: false,
    loggingIn: false,
  };

  // 极验背景图 300×200，切片 80×80
  const BG_W = 300, BG_H = 200, SLICE_W = 80;
  const MAX_DISTANCE = BG_W - SLICE_W;

  /* ============================================================
     动效层（anime.js v4）
     ============================================================ */
  const fx = {
    dur(ms) { return reduced ? 1 : ms; },

    track(node, anim) {
      if (!node || !anim) return anim;
      const list = (node.__anims = node.__anims || []);
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].completed || list[i].cancelled) list.splice(i, 1);
      }
      list.push(anim);
      return anim;
    },

    /** 彻底终止：只 pause() 不够，恢复时会续播，必须 cancel() */
    stop(node) {
      if (!node) return;
      if (node.__anims) {
        node.__anims.forEach((a) => { try { a.cancel(); } catch { /* 已失效 */ } });
        node.__anims.length = 0;
      }
      node.__gen = (node.__gen || 0) + 1;
      node.__dismissDeadline = 0;
      clearTimeout(node.__guard);
      clearTimeout(node.__dismiss);
      clearTimeout(node.__closeTimer);
      node.__guard = node.__dismiss = null;
      node.__closeTimer = null;
    },

    /** rAF 被节流时的兜底：到点直接写终值 */
    guard(node, ms, props) {
      if (!node) return;
      const gen = node.__gen || 0;
      clearTimeout(node.__guard);
      node.__guard = setTimeout(() => {
        if ((node.__gen || 0) !== gen) return;
        Object.assign(node.style, props);
      }, this.dur(ms) + 260);
    },

    intro() {
      const items = [el.headSub, $('.settings-card'), $('.list-head'), el.accounts, el.empty, el.btnAdd]
        .filter((n) => n && !n.hidden);
      items.forEach((n) => this.stop(n));

      const anim = animate(items, {
        opacity: [0, 1],
        translateY: reduced ? 0 : [14, 0],
        duration: this.dur(620),
        delay: stagger(this.dur(55)),
        ease: 'outQuad',
      });
      items.forEach((n) => {
        this.track(n, anim);
        this.guard(n, 900, { opacity: '1', transform: 'none' });
      });
    },

    toast(text) {
      const node = el.toast;
      const check = node.querySelector('.toast-check');

      this.stop(node);
      this.stop(check);

      el.toastText.textContent = text;
      node.hidden = false;
      node.style.opacity = '';
      node.style.transform = '';

      utils.set(check, { strokeDasharray: 40, strokeDashoffset: 40 });

      const gen = node.__gen;
      const isCurrent = () => (node.__gen || 0) === gen;

      const d = {
        in: this.dur(560),
        check: this.dur(360),
        hold: this.dur(2400),
        out: this.dur(420),
      };

      const hide = () => {
        if (!isCurrent()) return;
        node.hidden = true;
        node.style.opacity = '';
        node.style.transform = '';
      };

      node.__guard = setTimeout(() => {
        if (!isCurrent()) return;
        node.style.opacity = '1';
        node.style.transform = 'translateX(-50%) translateY(0)';
      }, d.in + 260);

      const deadline = performance.now() + d.in + d.check + d.hold + d.out + 400;
      node.__dismissDeadline = deadline;
      node.__dismiss = setTimeout(() => {
        node.__dismissDeadline = 0;
        hide();
      }, d.in + d.check + d.hold + d.out + 400);

      const tl = createTimeline({
        defaults: { ease: 'outQuad' },
        onComplete: hide,
      });
      tl.add(node, {
        translateY: reduced ? 0 : [-92, 0],
        translateX: '-50%',
        opacity: [0, 1],
        scale: reduced ? 1 : [.9, 1],
        duration: d.in,
      }, 0)
      .add(check, { strokeDashoffset: [40, 0], duration: d.check }, d.in)
      .add(node, {
        translateY: reduced ? 0 : [-92, 0],
        opacity: [1, 0],
        duration: d.out,
        delay: d.hold,
      }, d.in + d.check);

      this.track(node, tl);
    },

    shake(node) {
      if (reduced || !node) return;
      this.stop(node);
      this.track(node, animate(node, {
        translateX: [0, -7, 6, -4, 3, 0],
        duration: 420,
        ease: 'outQuad',
      }));
    },

    press(btn) {
      if (reduced || !btn) return;
      this.stop(btn);
      this.track(btn, animate(btn, {
        scale: [1, .975, 1],
        duration: 260,
        ease: 'outQuad',
      }));
    },

    modalIn() {
      this.stop(el.loginBackdrop);
      this.stop(el.loginModal);

      el.loginBackdrop.hidden = false;
      el.loginWrap.hidden = false;

      this.track(el.loginBackdrop, animate(el.loginBackdrop, {
        opacity: [0, 1], duration: this.dur(320), ease: 'outQuad',
      }));
      this.guard(el.loginBackdrop, 320, { opacity: '1' });

      this.track(el.loginModal, animate(el.loginModal, {
        opacity: [0, 1],
        translateY: reduced ? 0 : [40, 0],
        duration: this.dur(540),
        ease: 'outQuint',
      }));
      this.guard(el.loginModal, 540, { opacity: '1', transform: 'none' });
    },

    modalOut(done) {
      this.stop(el.loginBackdrop);
      this.stop(el.loginModal);

      const gen = el.loginModal.__gen;
      const finish = () => {
        if ((el.loginModal.__gen || 0) !== gen) return;
        el.loginBackdrop.hidden = true;
        el.loginWrap.hidden = true;
        el.loginModal.style.transform = '';
        el.loginModal.style.opacity = '';
        if (done) done();
      };
      clearTimeout(el.loginModal.__closeTimer);
      el.loginModal.__closeTimer = setTimeout(finish, this.dur(340) + 260);

      animate(el.loginBackdrop, {
        opacity: [1, 0], duration: this.dur(280), ease: 'outQuad',
        onComplete: () => { el.loginBackdrop.hidden = true; },
      });

      animate(el.loginModal, {
        opacity: [1, 0],
        translateY: reduced ? 0 : [0, 40],
        duration: this.dur(340),
        ease: 'inQuad',
        onComplete: finish,
      });
    },

    sheetIn() {
      this.stop(el.backdrop);
      this.stop(el.sheet);

      el.backdrop.hidden = false;
      el.sheetWrap.hidden = false;

      this.track(el.backdrop, animate(el.backdrop, {
        opacity: [0, 1], duration: this.dur(320), ease: 'outQuad',
      }));
      this.guard(el.backdrop, 320, { opacity: '1' });

      this.track(el.sheet, animate(el.sheet, {
        opacity: [0, 1],
        translateY: reduced ? 0 : [40, 0],
        duration: this.dur(540),
        ease: 'outQuint',
      }));
      this.guard(el.sheet, 540, { opacity: '1', transform: 'none' });
    },

    sheetOut(done) {
      this.stop(el.backdrop);
      this.stop(el.sheet);

      const gen = el.sheet.__gen;
      const finish = () => {
        if ((el.sheet.__gen || 0) !== gen) return;
        el.backdrop.hidden = true;
        el.sheetWrap.hidden = true;
        el.sheet.style.transform = '';
        el.sheet.style.opacity = '';
        if (done) done();
      };
      clearTimeout(el.sheet.__closeTimer);
      el.sheet.__closeTimer = setTimeout(finish, this.dur(340) + 260);

      animate(el.backdrop, {
        opacity: [1, 0], duration: this.dur(280), ease: 'outQuad',
        onComplete: () => { el.backdrop.hidden = true; },
      });

      animate(el.sheet, {
        opacity: [1, 0],
        translateY: reduced ? 0 : [0, 40],
        duration: this.dur(340),
        ease: 'inQuad',
        onComplete: finish,
      });
    },

    sliderReset(done) {
      this.stop(el.sliderThumb);
      this.stop(el.sliderTrack);

      animate(el.sliderThumb, { translateX: 0, duration: this.dur(480), ease: 'outQuint' });
      animate(el.sliderTrack, {
        scaleX: 0, duration: this.dur(480), ease: 'outQuint',
        onComplete: () => { if (done) done(); },
      });
    },

    snapPiece(px) {
      this.stop(el.captchaPiece);
      animate(el.captchaPiece, { translateX: px, duration: this.dur(420), ease: 'outBack' });
    },

    /** 日志弹窗弹入 */
    logIn() {
      this.stop(el.logBackdrop);
      this.stop(el.logModal);

      el.logBackdrop.hidden = false;
      el.logWrap.hidden = false;

      this.track(el.logBackdrop, animate(el.logBackdrop, {
        opacity: [0, 1], duration: this.dur(320), ease: 'outQuad',
      }));
      this.guard(el.logBackdrop, 320, { opacity: '1' });

      this.track(el.logModal, animate(el.logModal, {
        opacity: [0, 1],
        translateY: reduced ? 0 : [40, 0],
        duration: this.dur(540),
        ease: 'outQuint',
      }));
      this.guard(el.logModal, 540, { opacity: '1', transform: 'none' });
    },

    /** 日志弹窗收起 */
    logOut(done) {
      this.stop(el.logBackdrop);
      this.stop(el.logModal);

      // 兜底：rAF 停摆时 onComplete 永远不触发，面板会卡在打开状态
      const gen = el.logModal.__gen;
      const finish = () => {
        if ((el.logModal.__gen || 0) !== gen) return;
        el.logBackdrop.hidden = true;
        el.logWrap.hidden = true;
        el.logModal.style.transform = '';
        el.logModal.style.opacity = '';
        if (done) done();
      };
      clearTimeout(el.logModal.__closeTimer);
      el.logModal.__closeTimer = setTimeout(finish, this.dur(340) + 260);

      animate(el.logBackdrop, {
        opacity: [1, 0], duration: this.dur(280), ease: 'outQuad',
        onComplete: () => { el.logBackdrop.hidden = true; },
      });

      animate(el.logModal, {
        opacity: [1, 0],
        translateY: reduced ? 0 : [0, 40],
        duration: this.dur(340),
        ease: 'inQuad',
        onComplete: finish,
      });
    },

    /** 新卡片入场 */
    cardIn(node) {      if (!node) return;
      this.stop(node);
      this.track(node, animate(node, {
        opacity: [0, 1],
        translateY: reduced ? 0 : [16, 0],
        scale: reduced ? 1 : [.98, 1],
        duration: this.dur(480),
        ease: 'outQuad',
      }));
      this.guard(node, 480, { opacity: '1', transform: 'none' });
    },

    /** 卡片离场后移除 */
    cardOut(node, done) {
      if (!node) return done && done();
      this.stop(node);

      const gen = node.__gen;
      const finish = () => {
        if ((node.__gen || 0) !== gen) return;
        if (done) done();
      };
      clearTimeout(node.__closeTimer);
      node.__closeTimer = setTimeout(finish, this.dur(280) + 260);

      this.track(node, animate(node, {
        opacity: [1, 0],
        translateY: reduced ? 0 : [0, -8],
        duration: this.dur(280),
        ease: 'inQuad',
        onComplete: finish,
      }));
    },
  };

  /* ============================================================
     可见性守卫：切回页面时清理僵尸动画
     ============================================================ */
  const watched = [
    el.toast, el.sheet, el.backdrop, el.loginModal, el.loginBackdrop,
    el.logModal, el.logBackdrop,
    el.captchaPiece, el.sliderThumb, el.sliderTrack,
  ];

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    watched.forEach((node) => {
      if (!node || !node.__anims) return;
      node.__anims = node.__anims.filter((a) => {
        if (a.completed || a.cancelled) return false;
        if (typeof a.duration === 'number' && a.currentTime >= a.duration) {
          try { a.cancel(); } catch { /* 已失效 */ }
          return false;
        }
        return true;
      });
    });

    if (el.toast.__dismissDeadline && performance.now() > el.toast.__dismissDeadline) {
      el.toast.hidden = true;
      el.toast.style.opacity = '';
      el.toast.style.transform = '';
      el.toast.__dismissDeadline = 0;
    }
  });

  /* ============================================================
     基础工具
     ============================================================ */
  function say(text, kind) {
    el.msg.textContent = text || '';
    el.msg.dataset.kind = kind || '';
    if (kind === 'error') fx.shake(el.msg);
  }

  function sheetSay(text, kind) {
    el.sheetMsg.textContent = text || '';
    el.sheetMsg.dataset.kind = kind || '';
    if (kind === 'error') fx.shake(el.sheetMsg);
  }

  function busy(btn, on) {
    btn.disabled = on;
    btn.classList.toggle('loading', on);
  }

  async function req(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`服务异常（HTTP ${res.status}）`);
    }
    if (res.status >= 400) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
    return `${Math.floor(diff / 86400e3)} 天前`;
  }

  function clockText(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ============================================================
     渲染
     ============================================================ */
  function renderSettings() {
    const s = state.settings;
    const st = state.status || {};

    el.swAuto.setAttribute('aria-checked', String(Boolean(s.autoSign)));
    el.swReplenish.setAttribute('aria-checked', String(Boolean(s.autoReplenish)));
    if (document.activeElement !== el.signTime) el.signTime.value = s.time || '08:30';

    if (st.running) {
      el.nextRun.textContent = '正在签到…';
    } else if (!s.autoSign) {
      el.nextRun.textContent = '已关闭';
    } else if (st.nextRunAt) {
      const d = new Date(st.nextRunAt);
      const p = (n) => String(n).padStart(2, '0');
      const today = new Date();
      const isToday = d.toDateString() === today.toDateString();
      el.nextRun.textContent = `下次 ${isToday ? '今天' : '明天'} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } else {
      el.nextRun.textContent = '—';
    }

    // 副标题显示最近一次结果
    const lr = st.lastRun;
    if (lr && Array.isArray(lr.results) && lr.results.length) {
      const ok = lr.results.filter((r) => r.ok && !r.skipped).length;
      const total = lr.results.filter((r) => !r.skipped).length;
      el.headSub.textContent = `上次签到 ${timeAgo(lr.at)} · ${ok}/${total} 成功`;
    } else {
      el.headSub.textContent = '库街区每日自动签到';
    }
  }

  function accState(acc) {
    const ls = acc.lastSign;
    if (!ls) return { kind: '', text: acc.enable ? '未签到' : '已停用' };
    if (!acc.enable) return { kind: '', text: '已停用' };
    if (ls.ok) return { kind: 'ok', text: '已签到' };
    return { kind: 'bad', text: '签到失败' };
  }

  function accMeta(acc) {
    const parts = [];
    if (acc.wwroleId) parts.push('鸣潮');
    if (acc.eeeroleId) parts.push('战双');
    if (!parts.length) parts.push('未绑定游戏');
    const ls = acc.lastSign;
    if (ls) parts.push(clockText(ls.at));
    return parts.join(' · ');
  }

  function buildCard(acc) {
    const node = document.createElement('article');
    node.className = 'acc';
    node.dataset.id = acc.id;
    if (!acc.enable) node.classList.add('is-off');

    const st = accState(acc);
    const initial = (acc.name || '?').trim().charAt(0).toUpperCase();
    const msgs = (acc.lastSign && acc.lastSign.msgs) || [];

    node.innerHTML = `
      <div class="acc-top">
        <div class="acc-avatar" aria-hidden="true">${esc(initial)}</div>
        <div class="acc-main">
          <div class="acc-name">${esc(acc.name)}</div>
          <div class="acc-meta">${esc(accMeta(acc))}</div>
        </div>
        <span class="acc-state" data-kind="${st.kind}">
          <span class="dot"></span>${esc(st.text)}
        </span>
      </div>
      <div class="acc-log">${msgs
        .map((m) => `<div class="log-line${/失败|过期|异常|error/i.test(m) ? ' is-bad' : ''}">${esc(m)}</div>`)
        .join('')}</div>
      <div class="acc-actions">
        <button class="mini-btn" data-act="sign" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
            <path d="M21 3v5h-5"/>
          </svg>
          立即签到
        </button>
        <button class="mini-btn" data-act="toggle" type="button">
          ${acc.enable ? '停用' : '启用'}
        </button>
        <button class="mini-btn icon-only" data-act="logs" type="button"
                aria-label="查看签到日志" title="签到日志">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 4.5h9.5L19 9v10.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/>
            <path d="M14 4.5V9h4.5"/>
            <path d="M7.6 12.4h7M7.6 16h4.6"/>
          </svg>
        </button>
        <button class="mini-btn icon-only is-bad" data-act="del" type="button" aria-label="删除账号">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/>
          </svg>
        </button>
      </div>
    `;
    return node;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  let firstRender = true;

  function renderAccounts({ animateNew = false } = {}) {
    const list = state.accounts;
    el.accCount.textContent = String(list.length);
    el.empty.hidden = list.length > 0;
    el.btnSignAll.disabled = list.length === 0 || state.signingAll;

    // 保留已有节点，避免整表重绘导致动画重播
    const existing = new Map();
    for (const child of Array.from(el.accounts.children)) existing.set(child.dataset.id, child);

    const seen = new Set();
    list.forEach((acc, i) => {
      seen.add(acc.id);
      const old = existing.get(acc.id);
      const fresh = buildCard(acc);
      if (old) {
        old.replaceWith(fresh);
        fresh.style.opacity = '';
        fresh.style.transform = '';
      } else {
        el.accounts.appendChild(fresh);
        if (!firstRender || animateNew) fx.cardIn(fresh);
        else { fresh.style.opacity = ''; fresh.style.transform = ''; }
      }
      // 顺序校正
      if (el.accounts.children[i] !== fresh) {
        el.accounts.insertBefore(fresh, el.accounts.children[i] || null);
      }
    });

    for (const [id, node] of existing) {
      if (!seen.has(id)) node.remove();
    }

    firstRender = false;
  }

  async function refresh({ animateNew = false } = {}) {
    const data = await req('/api/accounts');
    state.accounts = data.accounts || [];
    state.settings = data.settings || state.settings;
    state.status = data.status || {};
    renderSettings();
    renderAccounts({ animateNew });
  }

  /* ============================================================
     账号操作
     ============================================================ */
  el.accounts.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.acc');
    const id = card && card.dataset.id;
    const acc = state.accounts.find((a) => a.id === id);
    if (!acc) return;

    const act = btn.dataset.act;

    if (act === 'sign') {
      fx.press(btn);
      const stateEl = card.querySelector('.acc-state');
      stateEl.dataset.kind = 'busy';
      stateEl.innerHTML = '<span class="dot"></span>签到中';
      btn.disabled = true;

      try {
        const r = await req(`/api/accounts/${id}/sign`, { method: 'POST' });
        fx.toast(r.ok ? `${acc.name} 签到完成` : `${acc.name} 签到失败`);
      } catch (err) {
        fx.toast(err.message);
      } finally {
        await refresh();
      }
      return;
    }

    if (act === 'toggle') {
      fx.press(btn);
      try {
        await req(`/api/accounts/${id}`, {
          method: 'PATCH',
          body: { enable: !acc.enable },
        });
        await refresh();
        fx.toast(acc.enable ? `已停用 ${acc.name}` : `已启用 ${acc.name}`);
      } catch (err) {
        fx.toast(err.message);
      }
      return;
    }

    if (act === 'logs') {
      fx.press(btn);
      await openLogs(acc);
      return;
    }

    if (act === 'del') {
      if (!confirm(`删除账号「${acc.name}」？\n删除后它的签到记录也会一起消失。`)) return;
      try {
        await req(`/api/accounts/${id}`, { method: 'DELETE' });
        fx.cardOut(card, () => card.remove());
        state.accounts = state.accounts.filter((a) => a.id !== id);
        renderAccounts();
        fx.toast(`已删除 ${acc.name}`);
      } catch (err) {
        fx.toast(err.message);
      }
    }
  });

  el.btnSignAll.addEventListener('click', async () => {
    if (state.signingAll || state.accounts.length === 0) return;
    fx.press(el.btnSignAll);
    state.signingAll = true;
    el.btnSignAll.disabled = true;
    el.btnSignAll.textContent = '签到中…';

    // 所有卡片先进入"签到中"态
    for (const card of el.accounts.children) {
      const s = card.querySelector('.acc-state');
      s.dataset.kind = 'busy';
      s.innerHTML = '<span class="dot"></span>排队中';
    }

    try {
      await req('/api/sign/all', { method: 'POST' });
      const ok = state.accounts.filter((a) => a.lastSign && a.lastSign.ok).length;
      fx.toast(`全部签到完成 · ${ok}/${state.accounts.length} 成功`);
    } catch (err) {
      fx.toast(err.message);
    } finally {
      state.signingAll = false;
      el.btnSignAll.textContent = '全部签到';
      await refresh();
    }
  });

  /* ============================================================
     设置
     ============================================================ */
  el.swAuto.addEventListener('click', async () => {
    const next = el.swAuto.getAttribute('aria-checked') !== 'true';
    el.swAuto.setAttribute('aria-checked', String(next));
    try {
      const r = await req('/api/settings', { method: 'PATCH', body: { autoSign: next } });
      state.settings = r.settings;
      state.status = r.status || {};
      renderSettings();
      fx.toast(next ? '已开启每日自动签到' : '已关闭每日自动签到');
    } catch (err) {
      el.swAuto.setAttribute('aria-checked', String(!next));
      fx.toast(err.message);
    }
  });

  el.swReplenish.addEventListener('click', async () => {
    const next = el.swReplenish.getAttribute('aria-checked') !== 'true';
    el.swReplenish.setAttribute('aria-checked', String(next));
    try {
      const r = await req('/api/settings', { method: 'PATCH', body: { autoReplenish: next } });
      state.settings = r.settings;
      renderSettings();
      fx.toast(next ? '已开启自动补签' : '已关闭自动补签');
    } catch (err) {
      el.swReplenish.setAttribute('aria-checked', String(!next));
      fx.toast(err.message);
    }
  });

  el.signTime.addEventListener('change', async () => {
    const t = el.signTime.value;
    if (!t) return;
    try {
      const r = await req('/api/settings', { method: 'PATCH', body: { time: t } });
      state.settings = r.settings;
      state.status = r.status || {};
      renderSettings();
      fx.toast(`签到时间已设为 ${t}`);
    } catch (err) {
      fx.toast(err.message);
      el.signTime.value = state.settings.time;
    }
  });

  /* ============================================================
     签到日志
     ============================================================ */
  const TRIGGER_LABEL = {
    new: '添加时',
    single: '手动',
    manual: '手动',
    schedule: '定时',
  };

  function fullTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const date = sameDay
      ? '今天'
      : `${d.getFullYear() === today.getFullYear() ? '' : d.getFullYear() + '-'}${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return `${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  async function openLogs(acc) {
    el.logSub.textContent = acc.name;
    el.logBody.innerHTML = '<div class="log-empty">读取中…</div>';
    fx.logIn();

    try {
      const data = await req(`/api/accounts/${acc.id}/logs`);
      const logs = data.logs || [];

      if (logs.length === 0) {
        el.logBody.innerHTML = '<div class="log-empty">还没有签到记录</div>';
        return;
      }

      el.logBody.innerHTML = logs
        .map((entry) => {
          const kind = entry.ok ? 'ok' : 'bad';
          const label = entry.ok ? '成功' : '失败';
          const trigger = TRIGGER_LABEL[entry.trigger] || entry.trigger || '';
          const lines = (entry.msgs || [])
            .map((m) => `<div class="log-line${/失败|过期|异常|error/i.test(m) ? ' is-bad' : ''}">${esc(m)}</div>`)
            .join('');
          return `
            <div class="log-entry">
              <div class="log-entry-top">
                <span class="log-when">${esc(fullTime(entry.at))}</span>
                <span class="log-tag" data-kind="${kind}">${label}</span>
                ${trigger ? `<span class="log-trigger">${esc(trigger)}</span>` : ''}
              </div>
              <div class="log-lines">${lines || '<div class="log-line">（无详情）</div>'}</div>
            </div>
          `;
        })
        .join('');
    } catch (err) {
      el.logBody.innerHTML = `<div class="log-empty">读取失败：${esc(err.message)}</div>`;
    }
  }

  function closeLogs() {
    fx.logOut();
  }

  el.btnLogClose.addEventListener('click', closeLogs);
  el.logBackdrop.addEventListener('click', closeLogs);

  /* ============================================================
     添加账号弹窗
     ============================================================ */
  function openLogin() {
    el.mobile.value = '';
    el.code.value = '';
    say('');
    fx.modalIn();
    setTimeout(() => el.mobile.focus(), reduced ? 0 : 380);
  }

  function closeLogin() {
    if (state.loggingIn) return;
    fx.modalOut(() => { state.manual = null; });
  }

  el.btnAdd.addEventListener('click', () => {
    fx.press(el.btnAdd);
    openLogin();
  });

  el.btnLoginClose.addEventListener('click', closeLogin);
  el.loginBackdrop.addEventListener('click', closeLogin);

  for (const input of [el.mobile, el.code]) {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '');
      input.removeAttribute('aria-invalid');
    });
  }

  // 获取验证码（服务端自动破滑块）
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mobile = el.mobile.value.trim();

    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      el.mobile.setAttribute('aria-invalid', 'true');
      say('请输入正确的 11 位手机号', 'error');
      el.mobile.focus();
      return;
    }
    el.mobile.removeAttribute('aria-invalid');

    fx.press(el.btnSend);
    busy(el.btnSend, true);
    say('正在发送…');

    try {
      const data = await req('/api/sms', { method: 'POST', body: { mobile } });

      if (data.needManual) {
        say('自动验证未通过，请手动完成滑块');
        await openManual(mobile);
        return;
      }

      say('');
      fx.toast('验证码已发送');
      el.code.focus();
    } catch (err) {
      say(err.message, 'error');
    } finally {
      busy(el.btnSend, false);
    }
  });

  // 登录并添加
  el.btnLogin.addEventListener('click', async () => {
    if (state.loggingIn) return;

    const mobile = el.mobile.value.trim();
    const code = el.code.value.trim();

    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      el.mobile.setAttribute('aria-invalid', 'true');
      say('请输入正确的 11 位手机号', 'error');
      el.mobile.focus();
      return;
    }
    if (!/^\d{4,8}$/.test(code)) {
      el.code.setAttribute('aria-invalid', 'true');
      say('请输入短信中的验证码', 'error');
      el.code.focus();
      return;
    }
    el.code.removeAttribute('aria-invalid');

    fx.press(el.btnLogin);
    state.loggingIn = true;
    busy(el.btnLogin, true);
    say('正在登录…');

    try {
      const data = await req('/api/accounts', { method: 'POST', body: { mobile, code } });

      state.loggingIn = false;
      busy(el.btnLogin, false);
      fx.modalOut();
      fx.toast(`已添加 ${data.account.name}，正在签到…`);

      await refresh({ animateNew: true });

      // 后台签到结果通过 SSE 回来，这里给个即时反馈占位
      const card = el.accounts.querySelector(`[data-id="${data.account.id}"]`);
      if (card) {
        const s = card.querySelector('.acc-state');
        s.dataset.kind = 'busy';
        s.innerHTML = '<span class="dot"></span>签到中';
      }
    } catch (err) {
      state.loggingIn = false;
      busy(el.btnLogin, false);
      say(err.message, 'error');
    }
  });

  /* ============================================================
     手动滑块兜底
     ============================================================ */
  async function openManual(mobile) {
    el.sliderThumb.style.transform = 'translateX(0px)';
    el.sliderTrack.style.transform = 'scaleX(0)';
    el.captchaPiece.style.transform = 'translateX(0px)';
    el.sliderHint.style.opacity = '1';
    sheetSay('');
    fx.sheetIn();

    try {
      const data = await req('/api/captcha/manual', { method: 'POST', body: {} });
      state.manual = { id: data.id, mobile, y: data.y };

      const bg = new Image();
      bg.onload = () => {
        el.captchaBg.src = bg.src;
        if (data.y != null) el.captchaPiece.style.top = `${(data.y / BG_H) * 100}%`;
      };
      bg.src = `/api/captcha/manual/${data.id}/bg.png`;
      el.captchaPiece.src = `/api/captcha/manual/${data.id}/slice.png`;
    } catch (err) {
      sheetSay(err.message, 'error');
    }
  }

  function closeManual() {
    fx.sheetOut(() => { state.manual = null; });
  }

  el.btnSheetClose.addEventListener('click', closeManual);
  el.backdrop.addEventListener('click', closeManual);

  el.btnRetryAuto.addEventListener('click', async () => {
    if (el.btnRetryAuto.disabled) return;
    const mobile = (state.manual && state.manual.mobile) || el.mobile.value.trim();
    fx.press(el.btnRetryAuto);
    busy(el.btnRetryAuto, true);
    sheetSay('正在重试自动验证…');

    try {
      const data = await req('/api/sms', { method: 'POST', body: { mobile } });
      if (data.needManual) {
        sheetSay('还是没过，请手动拖动滑块', 'error');
        return;
      }
      closeManual();
      fx.toast('验证码已发送');
      el.code.focus();
    } catch (err) {
      sheetSay(err.message, 'error');
    } finally {
      busy(el.btnRetryAuto, false);
    }
  });

  /* ---------- 拖动 ---------- */
  function travel() {
    const canvasW = el.canvas.getBoundingClientRect().width;
    const sliderW = el.slider.getBoundingClientRect().width;
    const thumbW = el.sliderThumb.offsetWidth;
    return {
      canvasW,
      maxThumbPx: Math.max(1, sliderW - thumbW - 6),
      maxPiecePx: canvasW * (MAX_DISTANCE / BG_W),
      thumbW,
    };
  }

  function applyRatio(ratio) {
    const r = Math.min(Math.max(ratio, 0), 1);
    const { maxThumbPx, maxPiecePx } = travel();
    el.sliderThumb.style.transform = `translateX(${r * maxThumbPx}px)`;
    el.sliderTrack.style.transform = `scaleX(${r})`;
    el.captchaPiece.style.transform = `translateX(${r * maxPiecePx}px)`;
    el.sliderThumb.setAttribute('aria-valuenow', String(Math.round(r * 100)));
    el.sliderHint.style.opacity = r > 0.01 ? '0' : '1';
    return r;
  }

  function currentRatio() {
    const { maxThumbPx } = travel();
    const m = el.sliderThumb.style.transform.match(/translateX\(([-\d.]+)px\)/);
    const px = m ? parseFloat(m[1]) : 0;
    return Math.min(Math.max(px / maxThumbPx, 0), 1);
  }

  async function onDragEnd(ratio) {
    if (!state.manual || state.submitting) return;
    state.submitting = true;

    const distance = Math.round(ratio * MAX_DISTANCE);
    sheetSay('正在校验…');

    try {
      const data = await req('/api/captcha/submit', {
        method: 'POST',
        body: { id: state.manual.id, distance, mobile: state.manual.mobile },
      });

      if (!data.ok) {
        sheetSay(data.error || '位置不对，再试一次', 'error');
        fx.sliderReset(() => {
          el.captchaPiece.style.transform = 'translateX(0px)';
          el.sliderHint.style.opacity = '1';
        });
        return;
      }

      fx.snapPiece(ratio * travel().maxPiecePx);
      sheetSay('验证通过');

      setTimeout(() => {
        closeManual();
        fx.toast('验证码已发送');
        el.code.focus();
      }, reduced ? 60 : 560);
    } catch (err) {
      sheetSay(err.message, 'error');
      fx.sliderReset(() => {
        el.captchaPiece.style.transform = 'translateX(0px)';
        el.sliderHint.style.opacity = '1';
      });
    } finally {
      state.submitting = false;
    }
  }

  function pointerRatio(clientX) {
    const rect = el.slider.getBoundingClientRect();
    const { maxThumbPx, thumbW } = travel();
    const offset = clientX - rect.left - thumbW / 2 - 3;
    return Math.min(Math.max(offset / maxThumbPx, 0), 1);
  }

  el.slider.addEventListener('pointerdown', (e) => {
    if (state.submitting) return;
    e.preventDefault();
    state.dragging = true;
    el.slider.setPointerCapture(e.pointerId);
    applyRatio(pointerRatio(e.clientX));
  });

  el.slider.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    e.preventDefault();
    applyRatio(pointerRatio(e.clientX));
  });

  function endDrag(e) {
    if (!state.dragging) return;
    state.dragging = false;
    if (e && el.slider.hasPointerCapture?.(e.pointerId)) {
      el.slider.releasePointerCapture(e.pointerId);
    }
    onDragEnd(currentRatio());
  }

  el.slider.addEventListener('pointerup', endDrag);
  el.slider.addEventListener('pointercancel', endDrag);

  el.sliderThumb.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.025;
    let r = currentRatio();

    if (e.key === 'ArrowRight') r = Math.min(r + step, 1);
    else if (e.key === 'ArrowLeft') r = Math.max(r - step, 0);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onDragEnd(r);
      return;
    } else return;

    e.preventDefault();
    applyRatio(r);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.sheetWrap.hidden) closeManual();
    else if (!el.logWrap.hidden) closeLogs();
    else if (!el.loginWrap.hidden) closeLogin();
  });

  /* ============================================================
     SSE 实时进度
     ============================================================ */
  let es = null;

  function connectEvents() {
    if (es) es.close();
    es = new EventSource('/api/events');

    es.onmessage = async (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }

      if (data.type === 'hello') {
        state.status = data.status || state.status;
        renderSettings();
        return;
      }

      if (data.type === 'start') {
        state.status = { ...state.status, running: true };
        renderSettings();
        if (data.trigger === 'single' && data.id) {
          const card = el.accounts.querySelector(`[data-id="${data.id}"]`);
          const s = card && card.querySelector('.acc-state');
          if (s) { s.dataset.kind = 'busy'; s.innerHTML = '<span class="dot"></span>签到中'; }
        }
        return;
      }

      if (data.type === 'account') {
        // 单个账号完成：刷新列表（结果已落盘）
        await refresh();
        return;
      }

      if (data.type === 'done') {
        state.status = { ...state.status, running: false };
        await refresh();
        if (data.trigger === 'schedule') {
          const ok = (data.results || []).filter((r) => r.ok && !r.skipped).length;
          const total = (data.results || []).filter((r) => !r.skipped).length;
          fx.toast(`自动签到完成 · ${ok}/${total} 成功`);
        }
        return;
      }

      if (data.type === 'schedule') {
        state.status = { ...state.status, nextRunAt: data.nextRunAt };
        renderSettings();
      }
    };

    es.onerror = () => {
      // 断线后由浏览器自动重连；这里只是清掉"进行中"态
      state.status = { ...state.status, running: false };
      renderSettings();
    };
  }

  /* ============================================================
     启动
     ============================================================ */
  (async function init() {
    fx.intro();
    try {
      await refresh();
    } catch (err) {
      fx.toast(`加载失败：${err.message}`);
    }
    connectEvents();
  })();
})();
