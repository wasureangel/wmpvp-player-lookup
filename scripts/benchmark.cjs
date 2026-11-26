// Use the real page in Chromium. A live run requires login in the same running local service.
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const synthetic = process.argv[2] === '--fixture';
const url = process.argv[2] || 'http://127.0.0.1:8765';
const names = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8').trim().split(/\r?\n/) :
  Array.from({length:10}, (_,i) => 'bench-' + i);

(async () => {
  if (names.length !== 10 || new Set(names).size !== 10) throw Error('Provide ten distinct names');
  const browser = await chromium.launch({channel:process.env.CHROME_PATH ? undefined : 'chrome',
    executablePath:process.env.CHROME_PATH, headless:synthetic});
  let fixture;
  try {
    if (synthetic) fixture=await (await import('../tests/node-benchmark.mjs')).fixture();
    for (const run of synthetic?['cold','warm']:['live']) {
    const page = await browser.newPage();
    if (fixture) await page.context().addCookies([fixture.cookie]);
    await page.goto(fixture?.origin || url);
    if (!synthetic) console.log('请在测速窗口完成登录。');
    await page.waitForFunction(() => document.querySelector('#auth-badge').textContent === '已登录', { }, {timeout:synthetic?5000:180000});
    await page.fill('#players', names.join('\n'));
    await page.evaluate(() => {
      const root = document.querySelector('#results');
      document.querySelector('#query').addEventListener('click', () => {
        const start = performance.now(), samples = {first:null, basic:null, complete:null, cards:0, matches:0};
        window.samples = samples;
        function frame() {
          const now = Math.round(performance.now() - start);
          const articles = [...root.querySelectorAll('article')];
          const withGames = articles.filter(a => a.querySelector('tbody tr'));
          samples.cards = withGames.length;
          samples.matches = root.querySelectorAll('tbody tr').length;
          if (withGames.length && samples.first === null) samples.first = now;
          if (withGames.length === 10 && samples.basic === null) samples.basic = now;
          if (/查询完成|本批查询结束/.test(document.querySelector('#progress').textContent)) samples.complete = now;
          else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      }, {once:true, capture:true});
    });
    await page.click('#query');
    await page.waitForFunction(() => window.samples?.complete !== null && window.samples?.complete !== undefined,
                               null, {timeout:240000});
    const sample = await page.evaluate(() => window.samples);
    console.log(JSON.stringify({run,...sample}));
    if (sample.cards !== 10 || sample.matches < 10) process.exitCode = 2;
    await page.close();
    }
  } finally { await browser.close();fixture?.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
