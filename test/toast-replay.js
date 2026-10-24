'use strict';
// 模拟「通知弹出 → 页面被冻结 → 滚动恢复」这条路径，
// 确认残留动画不会重播。
// 用最小 DOM 桩 + 真实 anime.js v4 引擎手动 tick 来复现。

const { animate, createTimeline, utils, engine } = require('../public/lib/anime.v4.min.js');

// ---- 最小 DOM 桩 ----
class El {
  constructor() {
    this.style = {};
    this.hidden = false;
    this.__anims = [];
    this.__gen = 0;
  }
}
const node = new El();
const check = new El();

let visibleWrites = 0;
const origSet = utils.set.bind(utils);
function trackSet(t, p) { visibleWrites++; return origSet(t, p); }

// ---- 复刻 app.js 里 fx.toast 的核心逻辑（含 stop / track / guard） ----
function stop(n) {
  if (!n) return;
  (n.__anims || []).forEach((a) => { try { a.cancel(); } catch {} });
  n.__anims.length = 0;
  n.__gen = (n.__gen || 0) + 1;
  clearTimeout(n.__guard);
  clearTimeout(n.__dismiss);
  n.__guard = n.__dismiss = null;
  n.__dismissDeadline = 0;
}

function track(n, a) {
  const list = (n.__anims = n.__anims || []);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].completed || list[i].cancelled) list.splice(i, 1);
  }
  list.push(a);
  return a;
}

let completeCount = 0;

function toast(text) {
  stop(node);
  stop(check);
  node.hidden = false;
  node.style.opacity = '';
  node.style.transform = '';
  trackSet(check, { strokeDasharray: 40, strokeDashoffset: 40 });

  const gen = node.__gen;
  const isCurrent = () => (node.__gen || 0) === gen;

  const d = { in: 560, check: 360, hold: 2400, out: 420 };

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

  const deadline = Date.now() + d.in + d.check + d.hold + d.out + 400;
  node.__dismissDeadline = deadline;
  node.__dismiss = setTimeout(() => { node.__dismissDeadline = 0; hide(); }, d.in + d.check + d.hold + d.out + 400);

  const tl = createTimeline({
    onComplete: () => { completeCount++; hide(); },
  });
  tl.add(node, { opacity: [0, 1], duration: d.in }, 0)
    .add(check, { strokeDashoffset: [40, 0], duration: d.check }, d.in)
    .add(node, { opacity: [1, 0], duration: d.out, delay: d.hold }, d.in + d.check);

  track(node, tl);
  return tl;
}

// ---- 场景 1：正常播完 ----
const tl1 = toast('验证码已发送');
tl1.complete();
console.log('场景1 播完 -> completed:', tl1.completed, '| onComplete 次数:', completeCount);

// ---- 场景 2：播完后再弹一次，旧实例必须彻底失效 ----
const tl2 = toast('验证码已发送');
console.log('场景2 新实例 currentTime:', tl2.currentTime, '| 旧实例 cancelled:', tl1.cancelled);
console.log('       旧实例若被唤醒会不会触发 onComplete:', completeCount, '(应仍为 1)');

// 模拟"滚动恢复"：引擎里若还有旧实例，会继续推进
const zombie = tl1;
zombie.play();
for (let i = 0; i < 200; i++) {
  try { engine.update && engine.update(); } catch {}
}
console.log('       唤醒旧实例后 onComplete 次数:', completeCount, '(应仍为 1)');
console.log('       旧实例 cancelled 仍为:', zombie.cancelled);

// ---- 场景 3：cancel 后引擎推进不应再写样式 ----
const before = visibleWrites;
const tl3 = toast('验证码已发送');
stop(node);
const mid = visibleWrites;
for (let i = 0; i < 100; i++) { try { engine.update && engine.update(); } catch {} }
console.log('场景3 cancel 后写入次数增量:', visibleWrites - mid, '(应为 0)');

process.exit(0);
