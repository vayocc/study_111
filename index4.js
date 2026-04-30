// auto-play-playwright.js
const { chromium } = require("playwright");

const USER_DATA_DIR = "/Users/vayo/chrome-profile-pc"; // 换成你的
const COURSE_URL_SUBSTR = "rspcourse.chinaedu.net";
const START_URL = "https://cjmanager.hactcm.edu.cn/";

const handledPages = new WeakSet(); // 防止重复接管

(async () => {
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        slowMo: 50,
        executablePath:
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-infobars",
            "--disable-dev-shm-usage",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
            "--start-maximized",
        ],
        userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9" },
        viewport: null,
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4] });
        Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh"] });
    });

    const firstPage =
        context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    await firstPage.goto(START_URL);

    console.log("请手动登录并进入课程页面… 脚本将自动接管播放页。");

    // 监听新打开页面
    context.on("page", async (p) => {
        await safeTry(async () => {
            await p.waitForLoadState("domcontentloaded").catch(() => {});

            if (await isRealCoursePage(p)) {
                handleCoursePage(p);
            }
        });
    });

    // 检查当前已经打开的页面
    for (const p of context.pages()) {
        if (await isRealCoursePage(p)) {
            handleCoursePage(p);
            break;
        }
    }

    // 循环等待播放页
    (async function waitForCoursePage() {
        while (true) {
            for (const p of context.pages()) {
                if (await isRealCoursePage(p)) {
                    handleCoursePage(p);
                    return;
                }
            }
            await sleep(1000);
        }
    })();
})();

// ------------------ 工具方法 ------------------

function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

async function safeTry(fn) {
    try {
        await fn();
    } catch (err) {
        console.log("异常忽略：", err);
    }
}

// ------------------ 播放页识别 ------------------

async function isRealCoursePage(page) {
    if (!page.url().includes(COURSE_URL_SUBSTR)) return false;

    const frame = await getVideoFrame(page);
    if (!frame) return false;

    const video = await findVideoInsideFrame(frame);
    return !!video;
}
// iframe 获取函数
async function getVideoFrame(page) {
    const iframe = await page.$("#frameVideo");
    if (!iframe) return null;

    return await iframe.contentFrame();
}
// . 在 iframe 中查找 video
async function findVideoInsideFrame(frame) {
    // video.js 常用类名
    const selectors = [
        "video.vjs-tech",
        "video",
        "#videoFrame_video_html5_api"
    ];

    for (const sel of selectors) {
        const v = await frame.$(sel);
        if (v) return v;
    }

    return null;
}

// ------------------ 接管播放页 ------------------

async function handleCoursePage(page) {
    if (handledPages.has(page)) return; // 防止重复接管
    handledPages.add(page);

    console.log("🎬 接管真正播放页:", page.url());

    autoNextOnVideoEnd(page); // 不 await（后台运行）
}

// ------------------ 视频处理逻辑 ------------------
// 自动监听视频结束（iframe 内）
async function waitForVideoEndInFrame(frame, video) {
    console.log("监听 iframe 内视频结束事件…");

    return frame.evaluate((vid) => {
        return new Promise(resolve => {
            vid.onended = () => resolve();
        });
    }, video);
}

async function waitForVideo(page) {
    let video = await page.$("video");
    if (video) return video;

    console.log("等待 video 元素出现…");
    await page.waitForSelector("video");
    return await page.$("video");
}

async function waitForVideoEnd(page, video) {
    console.log("监听视频结束事件…");

    return page.evaluate((vid) => {
        return new Promise((resolve) => {
            vid.onended = () => resolve();
        });
    }, video);
}

async function autoNextOnVideoEnd(page) {

    while (true) {
        // -----------------------
        // 1）每次重新获取最新 iframe
        // -----------------------
        let frame = await getVideoFrame(page);
        while (!frame) {
            console.log("等待 iframe 加载...");
            await page.waitForTimeout(500);
            frame = await getVideoFrame(page);
        }

        // -----------------------
        // 2）重新获取最新 video 元素
        // -----------------------
        let video = await findVideoInsideFrame(frame);
        while (!video) {
            console.log("等待 video 加载...");
            try {
                await frame.waitForSelector("video", { timeout: 1000 });
            } catch(_) {}

            // iframe 可能被 reload，要重新获取 frame
            frame = await getVideoFrame(page);
            video = await findVideoInsideFrame(frame);
        }
        console.log("🎬 已找到视频，开始监听结束事件…");
        // 等视频播放结束
        try {
            await waitForVideoEndInFrame(frame, video);
        } catch (err) {
            console.log("⚠️ iframe 已重载，重新获取...");
            continue;   // 直接重新循环（重新找 frame + video）
        }
        console.log("视频播放完毕 → 切换下一节");

        await gotoNextLeaf(page);

        // 等新课的视频加载
        await page.waitForSelector("#frameVideo");

    }
}
// ------------------ 章节处理 ------------------

async function getLeafNodes(page) {
    // 叶子节点 = li 不含 ul
    return await page.$$(
        "ul.page-sidebar-menu li:not(:has(ul))"
    );
}

async function getCurrentLeafNodeIndex(page, leafNodes) {
    for (let i = 0; i < leafNodes.length; i++) {
        const active = await leafNodes[i].evaluate((el) =>
            el.classList.contains("active")
        );
        if (active) return i;
    }
    return -1;
}

async function gotoNextLeaf(page) {
    const leafNodes = await getLeafNodes(page);
    const curIndex = await getCurrentLeafNodeIndex(page, leafNodes);

    if (curIndex === -1) {
        console.log("⚠️ 未找到当前播放的叶子节点");
        return;
    }

    if (curIndex + 1 >= leafNodes.length) {
        console.log("🎉 所有视频已全部播放完毕！");
        return;
    }

    console.log(`➡️ 切换到下一节（${curIndex + 2}/${leafNodes.length}）`);

    await leafNodes[curIndex + 1].click().catch(console.error);
}
