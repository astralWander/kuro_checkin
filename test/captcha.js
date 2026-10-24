const { solveCaptcha } = require('../src/geetest.js');
(async () => {
  let ok = 0, tries = 0;
  for (let i = 1; i <= 6; i++) {
    const t0 = Date.now();
    try {
      const r = await solveCaptcha({ maxAttempts: 3 });
      ok++; tries += r.attempts;
      console.log(`#${i} OK  attempts=${r.attempts} dist=${r.distance} y=${r.y} score=${r.score.toFixed(3)} ${Date.now()-t0}ms`);
    } catch (e) { console.log(`#${i} FAIL ${e.message.slice(0,90)}`); tries += 3; }
  }
  console.log(`pass ${ok}/6, avg attempts ${(tries/6).toFixed(2)}`);
})();
