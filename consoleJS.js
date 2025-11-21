(async () => {
    // 找到所有课程节点（按顺序）
    const courseNodes = Array.from(document.querySelectorAll('ul.page-sidebar-menu li.leftTwoLevel[nid]'));

    // 查找当前激活的课程索引
    let currentIndex = courseNodes.findIndex(li => li.classList.contains('activeState'));
    if (currentIndex === -1) currentIndex = 0; // 若未找到，则从第一个开始

    console.log(`共找到 ${courseNodes.length} 个课程，当前从第 ${currentIndex + 1} 个开始播放。`);

    async function playCourse(index) {
        if (index >= courseNodes.length) {
            console.log('✅ 所有课程已播放完毕');
            return;
        }

        const node = courseNodes[index];
        const title = node.innerText.trim();
        console.log(`▶️ 播放第 ${index + 1}/${courseNodes.length} 个课程: ${title}`);

        // 模拟点击课程节点（触发 iframe 加载）
        node.querySelector('a')?.click?.();
        node.click?.();

        // 等待 iframe 加载完成
        const iframe = await waitForIframe();

        // 等待 video 出现
        const video = await waitForVideo(iframe);
        if (!video) {
            console.warn('⚠️ 未找到 video，跳过该课程。');
            return playCourse(index + 1);
        }

        // 设置静音并播放
        try {
            video.muted = true;
            await video.play();
            console.log('🎧 已静音播放...');
        } catch (e) {
            console.error('无法播放视频:', e);
        }

        // 监听结束事件 → 自动播放下一个
        video.onended = () => {
            console.log(`⏭ 视频播放完毕，自动播放下一个...`);
            playCourse(index + 1);
        };
    }

    // 等待 iframe 出现
    function waitForIframe(timeout = 20000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const timer = setInterval(() => {
                const iframe = document.querySelector('iframe#frameVideo');
                if (iframe && iframe.contentWindow && iframe.src.includes('video.html')) {
                    clearInterval(timer);
                    resolve(iframe);
                } else if (Date.now() - start > timeout) {
                    clearInterval(timer);
                    reject('iframe 加载超时');
                }
            }, 1000);
        });
    }

    // 等待 video 出现
    function waitForVideo(iframe, timeout = 20000) {
        return new Promise((resolve) => {
            const start = Date.now();
            const timer = setInterval(() => {
                try {
                    const video = iframe.contentDocument?.querySelector('video');
                    if (video) {
                        clearInterval(timer);
                        resolve(video);
                    } else if (Date.now() - start > timeout) {
                        clearInterval(timer);
                        resolve(null);
                    }
                } catch {
                    // 跨域或尚未加载，继续等待
                }
            }, 1000);
        });
    }

    // 启动自动播放
    playCourse(currentIndex);
})();