// auto-play-playwright.js
const { chromium } = require('playwright');

const USER_DATA_DIR = "/Users/vayo/chrome-profile-pc";// 请根据需要修改路径
const COURSE_URL_SUBSTR = 'lms.hactcm.edu.cn/venus/study/activity/video/study.do';
const START_URL = 'https://cjmanager.hactcm.edu.cn/';
// 从头播放(每个视频从最开始的时候播放)
const BEGIN_0_START = true;

(async () => {
    // ------------------ 启动浏览器（使用你给的配置） ------------------
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        slowMo: 50,
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-infobars",
            "--disable-dev-shm-usage",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
            "--start-maximized"
        ],
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9" },
        viewport: null
    });

    // 伪装常见自动化特征，尽量让页面看到更接近真实浏览器的环境
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
    });

    // 取得或创建一个页面，并打开起始页（方便你开始手动登录）
    const pages = context.pages();
    const firstPage = pages.length > 0 ? pages[0] : await context.newPage();
    await firstPage.goto(START_URL);
    console.log('请在打开的浏览器中手动登录并进入课程（跳到播放页）— 脚本会自动侦测播放页并接管。');

    // 监听 context 中新打开页面，一旦检测到播放页则处理
    context.on('page', async (p) => {
        try {
            // 等待该 page 的第一次加载（防止立即检查到空 URL）
            await p.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
            const url = p.url();
            if (url.includes(COURSE_URL_SUBSTR)) {
                console.log('检测到新页面播放页 -> 接管：', url);
                await handleCoursePage(p, context);
            }
        } catch (e) {
            console.warn('page 事件处理异常：', e);
        }
    });

    // 也轮询当前已有的所有 page，若某个已在播放页则直接接管
    for (const p of context.pages()) {
        try {
            const url = p.url();
            if (url.includes(COURSE_URL_SUBSTR)) {
                console.log('检测到已存在播放页 -> 接管：', url);
                await handleCoursePage(p, context);
                break; // 优先接管第一个找到的
            }
        } catch (e) {}
    }

    // 如果还没有播放页，则持续轮询直到你打开一个播放页
    (async function waitForCoursePageLoop() {
        while (true) {
            const found = context.pages().find(p => p.url().includes(COURSE_URL_SUBSTR));
            if (found) {
                console.log('轮询发现播放页 -> 接管：', found.url());
                await handleCoursePage(found, context);
                break;
            }
            await sleep(1000);
        }
    })();

    // ------------------ 结束主流程（保持进程运行） ------------------
})();

// -------------------- 处理播放页的核心逻辑 --------------------
async function handleCoursePage(page, context) {
    console.log('[handler] 开始处理播放页：', page.url());
    await page.bringToFront();

    // 避免对话框阻塞
    page.on('dialog', async dialog => {
        console.log('[dialog] 自动接受对话：', dialog.message());
        try { await dialog.dismiss(); } catch (e) {}
    });

    // 主循环：在当前页面反复处理“当前节 -> 播放到结束 -> 点击下一节（可能刷新/新页）”
    while (true) {
        try {
            // 等待 DOM 加载，以便查找 li 列表与 cur 元素
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

            // 取得页面上所有课程 li 信息（id, title）
            const lis = await page.$$eval('ul.activity li', nodes =>
                nodes.map(n => ({ id: n.id || null, title: n.getAttribute('title') || n.textContent.trim() }))
            );

            if (!lis || lis.length === 0) {
                console.log('[handler] 未在页面找到任何 ul.activity li，稍后重试...');
                await sleep(5000);
                // 如果点了下一节后页面是别的结构，可能需要重新等待
                continue;
            }

            // 尝试读取当前被选中的 li.cur 的 id
            const curId = await page.$eval('li.cur', el => el.id).catch(() => null);
            let currentIndex = curId ? lis.findIndex(x => x.id === curId) : -1;
            if (currentIndex === -1) {
                // 如果没有 cur，默认取第一个（你说“点开课程后会有 cur”，但兜底）
                currentIndex = 0;
            }

            const current = lis[currentIndex];
            console.log(`[handler] 当前节：index=${currentIndex}, id=${current.id}, title=${current.title}`);

            // 1) 等待并尝试让 video 播放
            const started = await waitForVideoAndPlay(page);
            if (!started) {
                await page.reload({ waitUntil: 'domcontentloaded' });
                // 无法启动播放（或页面导航），直接回到外层循环，让外层重新检测页面结构
                console.log('[handler] 无法启动播放或页面已导航，外层会重试/接管新的页面');
                continue;
            }

            // 2) 等待播放结束（或接近结束）；若检测到页面导航则返回 false 并由外层接管
            const finished = await waitForVideoEndSafe(page);
            if (!finished) {
                await page.reload({ waitUntil: 'domcontentloaded' });
                console.log('[handler] 播放等待被打断（页面导航/刷新），外层会继续处理新页面。');
                continue;
            }



            console.log('[handler] 本节播放完成，准备切换下一节...');

            // 重新抓取一次 lis（有可能课程列表在页面上更新）
            const lis2 = await page.$$eval('ul.activity li', nodes =>
                nodes.map(n => ({ id: n.id || null, title: n.getAttribute('title') || n.textContent.trim() }))
            );

            // 找当前在新列表中的索引（以 curId 为准优先）
            const curIdAfter = await page.$eval('li.cur', el => el.id).catch(() => current.id);
            let idx = lis2.findIndex(x => x.id === curIdAfter);
            if (idx === -1) idx = lis2.findIndex(x => x.id === current.id);
            const nextIndex = idx + 1;
            if (nextIndex >= lis2.length) {
                console.log('🎉 已经是最后一节，全部播放完毕。');
                break;
            }

            const nextId = lis2[nextIndex].id;
            const nextTitle = lis2[nextIndex].title;
            console.log(`➡️ 将跳转到下一节 index=${nextIndex}, id=${nextId}, title=${nextTitle}`);

            // 点击下一节（并处理可能的导航或 popup）
            const navOrPopup = await clickNextAndWait(page, nextId);
            if (navOrPopup && navOrPopup.type === 'popup') {
                // 如果打开了新页面（popup），切换控制权到新页面
                page = navOrPopup.page;
                console.log('[handler] 已切换到弹出页（popup）进行后续操作：', page.url());
                await page.waitForLoadState('load').catch(() => {});
            } else {
                // navigation in same page or no nav: ensure page is loaded
                await page.waitForLoadState('load').catch(() => {});
                // page remains same
                console.log('[handler] 在同一页面完成导航或无导航，继续处理当前页面：', page.url());
            }

            // loop - 页面可能刷新（但 Playwright 仍持有 page 对象），下次循环会继续处理
        } catch (err) {
            console.error('[handler] 处理播放页异常：', err);
            // 小退让，避免死循环太快
            await sleep(2000);
        }
    } // end while

    console.log('[handler] 循环结束，暂停接管（可手动关闭脚本）');
}

// -------------------- 辅助函数 --------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitForVideoAndPlay(page, options = {}) {
    const maxAttempts = options.maxAttempts || 12; // 重试次数
    const attemptInterval = options.attemptInterval || 2000; // 每次重试间隔(ms)

    // 等待 video 元素出现
    try {
        await page.waitForSelector('video', { timeout: 20000 });
    } catch (e) {
        console.warn('waitForVideoAndPlay: 未检测到 video 元素（timeout 20s）');
        return false;
    }

    for (let i = 0; i < maxAttempts; i++) {
        try {
            // 尝试静音并调用 play()
            await page.evaluate(() => {
                const v = document.querySelector('video');
                if (!v) return;
                try {
                    v.muted = true;
                    // 如果需要从头播放
                    if (BEGIN_0_START) {
                        v.currentTime = 0;
                    }
                    v.volume = 0;
                } catch (e) {}
                try { if (v.paused) v.play().catch(() => {}); } catch (e) {}
            });

            // 检查是否已经开始播放
            const status = await page.evaluate(() => {
                const v = document.querySelector('video');
                if (!v) return { exists: false };
                return { exists: true, paused: !!v.paused, currentTime: Number(v.currentTime || 0), readyState: v.readyState || 0 };
            });

            if (!status.exists) {
                // video 突然不见了（页面可能导航），返回 false 让上层继续处理
                return false;
            }

            if (!status.paused && status.currentTime > 0) {
                console.log('waitForVideoAndPlay: 视频已在播放，currentTime=', status.currentTime.toFixed(1));
                return true;
            }

            // 如果还没播放，尝试模拟用户手势：把 video 滚入视口并点击中心
            const vidHandle = await page.$('video');
            if (vidHandle) {
                try {
                    await vidHandle.scrollIntoViewIfNeeded();
                } catch (e) {}
                const box = await vidHandle.boundingBox();
                if (box) {
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                } else {
                    // 兜底：尝试点击常见播放按钮选择器
                    await page.evaluate(() => {
                        const btn = document.querySelector('.vjs-big-play-button, .vjs-play-control, button.play, button[aria-label="Play"]');
                        if (btn) try { btn.click(); } catch(e) {}
                    });
                }
            }

            // 等短时间再检查
            await page.waitForTimeout(attemptInterval);
        } catch (err) {
            // 可能是页面导航导致的错误，直接返回 false 由上层循环重新检测页面
            const msg = (err && err.message) ? err.message : '';
            if (/Target page, context or browser has been closed|Page closed|Navigation|Cannot find context/.test(msg)) {
                console.warn('waitForVideoAndPlay: page 已关闭或导航，返回 false。', msg);
                return false;
            }
            console.warn('waitForVideoAndPlay 单次尝试出错，继续重试：', err && err.message);
            await page.waitForTimeout(attemptInterval);
        }
    }

    console.warn('waitForVideoAndPlay: 重试用尽，仍未启动播放（可能被 autoplay 限制），继续后续逻辑。');
    return false;
}

async function clickNextAndWait(page, nextLiId) {
    // 准备等待导航或 popup
    const navPromise = page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).then(() => ({ type: 'nav' })).catch(() => null);
    const popupPromise = page.waitForEvent('popup', { timeout: 30000 }).then(p => ({ type: 'popup', page: p })).catch(() => null);

    // 发出点击（通过 DOM 调用 h3.click()，更接近原生 onclick）
    await page.evaluate((id) => {
        const li = document.getElementById(id);
        if (!li) return;
        const h3 = li.querySelector('h3');
        if (h3) {
            // 先尝试触发 onclick 函数（如果存在）
            try {
                if (typeof h3.onclick === 'function') {
                    h3.onclick();
                    return;
                }
            } catch (e) {}
            // fallback：模拟 click
            h3.click();
        }
    }, nextLiId);

    // race 等待 navigation 或 popup（30s 超时后继续）
    const res = await Promise.race([navPromise, popupPromise]);
    return res; // 可能为 null 或 {type:'nav'} 或 {type:'popup', page: Page}
}

async function waitForVideoEndSafe(page, checkInterval = 2000) {
    try {
        while (true) {
            // 每次尝试读取 video 状态
            const status = await page.evaluate(() => {
                const v = document.querySelector('video');
                if (!v) return { exists: false };
                return {
                    exists: true,
                    ended: !!v.ended,
                    paused: !!v.paused,
                    currentTime: Number(v.currentTime || 0),
                    duration: Number(v.duration || 0)
                };
            }).catch(err => {
                // 读取过程中如果页面导航（EvaluationFailed），抛出到外层
                throw err;
            });

            // 🚨 video 元素突然消失，可能是课程系统在自动切换/刷新播放器
            if (!status.exists) {
                console.log('⚠️ 检测到 video 消失，可能是页面在刷新或播放器重载，等待恢复...');
                let recovered = false;

                // 最多等待 10 秒检测是否有新 video 出现
                for (let i = 0; i < 10; i++) {
                    await page.waitForTimeout(1000);
                    const existsAgain = await page.evaluate(() => !!document.querySelector('video'));
                    if (existsAgain) {
                        console.log('✅ video 元素重新出现，恢复播放检测');
                        recovered = true;
                        break;
                    }
                }

                if (!recovered) {
                    console.log('❌ 10 秒内未检测到新视频，视为页面刷新或导航');
                    return false; // 让上层重新接管
                } else {
                    continue; // 继续等待播放
                }
            }

            // 如果 ended，直接返回 true
            if (status.ended) {
                console.log('waitForVideoEndSafe: 检测到 v.ended = true');
                return true;
            }

            // 如果 duration 可用并且播放进度接近结尾（>=98%），也认为结束
            if (status.duration > 0 && status.currentTime / status.duration >= 0.99) {
                console.log('waitForVideoEndSafe: 进度 >= 99%，视为结束');
                return true;
            }

            // 如果处于 paused 状态，尝试恢复播放（防止中途被平台暂停）
            if (status.paused) {
                try {
                    await page.evaluate(() => {
                        const v = document.querySelector('video');
                        if (v && v.paused) v.play().catch(() => {});
                    });
                } catch (e) {}
            }

            // 等待一段时间再检查
            await page.waitForTimeout(checkInterval);
        }
    } catch (err) {
        const msg = err && err.message ? err.message : '';
        if (/Target page, context or browser has been closed|Page closed|Navigation|Cannot find context/.test(msg)) {
            console.warn('waitForVideoEndSafe: page 已关闭或导航，返回 false。', msg);
            return false;
        }
        console.error('waitForVideoEndSafe 遇到异常，抛出：', err);
        throw err;
    }
}
