'use strict';
// 与 OpenCV cv2.Canny(100,200) + matchTemplate(TM_CCOEFF_NORMED) 等价的纯 JS 实现
const { PNG } = require('pngjs');

function decodePng(buf) {
  return PNG.sync.read(buf);
}

// RGBA -> 灰度（模拟 cv2.imdecode(IMREAD_COLOR)：直接丢弃 alpha）
function grayOf(img) {
  const { width: w, height: h, data } = img;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    gray[i] = 0.114 * data[p] + 0.587 * data[p + 1] + 0.299 * data[p + 2];
  }
  return gray;
}

/** Canny 边缘检测，返回 Uint8Array（0/1） */
function canny(gray, w, h, low = 100, high = 200) {
  const mag = new Float32Array(w * h);
  const gxA = new Float32Array(w * h);
  const gyA = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
      const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
      const gx =
        -gray[ym * w + xm] + gray[ym * w + xp] +
        -2 * gray[y * w + xm] + 2 * gray[y * w + xp] +
        -gray[yp * w + xm] + gray[yp * w + xp];
      const gy =
        -gray[ym * w + xm] - 2 * gray[ym * w + x] - gray[ym * w + xp] +
        gray[yp * w + xm] + 2 * gray[yp * w + x] + gray[yp * w + xp];
      gxA[y * w + x] = gx;
      gyA[y * w + x] = gy;
      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  // 非极大值抑制
  const nms = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m === 0) continue;
      const ang = Math.atan2(gyA[i], gxA[i]) * 180 / Math.PI;
      let a = ((ang % 180) + 180) % 180;
      let n1, n2;
      if (a < 22.5 || a >= 157.5) { n1 = mag[i - 1]; n2 = mag[i + 1]; }
      else if (a < 67.5) { n1 = mag[i - w - 1]; n2 = mag[i + w + 1]; }
      else if (a < 112.5) { n1 = mag[i - w]; n2 = mag[i + w]; }
      else { n1 = mag[i - w + 1]; n2 = mag[i + w - 1]; }
      if (m >= n1 && m >= n2) nms[i] = m;
    }
  }

  // 双阈值 + 滞后连接
  const edges = new Uint8Array(w * h);
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (nms[i] >= high) { edges[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!edges[j] && nms[j] >= low) { edges[j] = 1; stack.push(j); }
      }
    }
  }
  return edges;
}

/** 积分图（用于快速求矩形区域的和、平方和） */
function integral(src, w, h) {
  const s = new Float64Array((w + 1) * (h + 1));
  const s2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      rs += v; rs2 += v * v;
      s[(y + 1) * (w + 1) + (x + 1)] = s[y * (w + 1) + (x + 1)] + rs;
      s2[(y + 1) * (w + 1) + (x + 1)] = s2[y * (w + 1) + (x + 1)] + rs2;
    }
  }
  return { s, s2, w: w + 1 };
}
function rectSum(I, x0, y0, w, h) {
  const { s, w: iw } = I;
  return s[(y0 + h) * iw + (x0 + w)] - s[y0 * iw + (x0 + w)] - s[(y0 + h) * iw + x0] + s[y0 * iw + x0];
}
function rectSum2(I, x0, y0, w, h) {
  const { s2, w: iw } = I;
  return s2[(y0 + h) * iw + (x0 + w)] - s2[y0 * iw + (x0 + w)] - s2[(y0 + h) * iw + x0] + s2[y0 * iw + x0];
}

/**
 * 求滑块缺口左边缘 x（等价 cv2.matchTemplate(bgEdges, sliceEdges, TM_CCOEFF_NORMED)）
 * 返回 { distance, y, score }
 */
function matchTemplate(bgBuf, sliceBuf) {
  const bgImg = decodePng(bgBuf);
  const slImg = decodePng(sliceBuf);
  const bw = bgImg.width, bh = bgImg.height;
  const sw = slImg.width, sh = slImg.height;

  const bgEdges = canny(grayOf(bgImg), bw, bh, 100, 200);
  const slEdges = canny(grayOf(slImg), sw, sh, 100, 200);

  // 模板统计（整块矩形，与 cv2 一致）
  const n = sw * sh;
  let sumT = 0, sumT2 = 0;
  const pts = [];
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = slEdges[y * sw + x];
      sumT += v; sumT2 += v * v;
      if (v) pts.push([x, y, v]);
    }
  }
  if (sumT === 0) return { distance: 0, y: 0, score: -1 };
  const meanT = sumT / n;
  const varT = sumT2 - n * meanT * meanT;

  const I = integral(bgEdges, bw, bh);
  const maxX = bw - sw, maxY = bh - sh;
  if (maxX < 0 || maxY < 0) throw new Error('切片尺寸异常');

  let best = { x: 0, y: 0, score: -Infinity };
  for (let y0 = 0; y0 <= maxY; y0++) {
    for (let x0 = 0; x0 <= maxX; x0++) {
      let sumTI = 0;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        sumTI += bgEdges[(y0 + p[1]) * bw + (x0 + p[0])] * p[2];
      }
      const sumI = rectSum(I, x0, y0, sw, sh);
      const sumI2 = sumI; // edges 为 0/1，平方和即自身
      const meanI = sumI / n;
      const varI = sumI2 - n * meanI * meanI;
      if (varI <= 0 || varT <= 0) continue;
      const num = sumTI - n * meanT * meanI;
      const score = num / Math.sqrt(varT * varI);
      if (score > best.score) best = { x: x0, y: y0, score };
    }
  }
  return { distance: best.x, y: best.y, score: best.score };
}

module.exports = { matchTemplate, canny, grayOf, decodePng };
