// 小红书自动评论 - 后台服务脚本 (MV3 Service Worker)
// 职责：1) 初始化默认存储  2) 保活  3) 按需注入 content.js
// 注意：配置了 default_popup 时不要监听 chrome.action.onClicked（永远不会触发）

const DEFAULT_TASK = {
  running: false,
  keyword: '',
  comments: [],
  targetCount: 5,
  // 防封号默认：间隔拉大到 30~90 秒
  minDelay: 30,
  maxDelay: 90,
  dailyMax: 20,
  hourlyMax: 8,
  restEvery: 5,      // 每评论 N 条休息一次（0 = 不休息）
  restMin: 60,       // 休息下限（秒）
  restMax: 180,      // 休息上限（秒）
  skipRate: 15,      // 随机跳过率（百分比 0~50）
  likeRate: 30,      // 随机点赞率（百分比 0~100，模拟真人）
  diversify: true,   // 评论多样化（随机后缀防重复）
  doneCount: 0,
  queue: [],
  currentIndex: 0,
  failStreak: 0,     // 连续失败计数（3 次熔断）
  logs: []
};

// ---------- 1. 安装/升级时初始化默认存储 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('xhs_auto_task', (res) => {
    if (!res || typeof res.xhs_auto_task === 'undefined') {
      chrome.storage.local.set({ xhs_auto_task: DEFAULT_TASK });
    } else {
      // 老版本升级：补齐新增字段，不覆盖用户已有配置
      const merged = Object.assign({}, DEFAULT_TASK, res.xhs_auto_task);
      chrome.storage.local.set({ xhs_auto_task: merged });
    }
  });
  chrome.alarms.create('xhs_keepalive', { periodInMinutes: 0.5 });
});

// ---------- 2. 保活：定时唤醒 Service Worker ----------
// MV3 SW 30 秒空闲会被回收，用 alarm 保持逻辑连续性
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'xhs_keepalive') {
    chrome.storage.local.get('xhs_auto_task', () => {});
  }
});

// ---------- 3. 页面加载完成时按需注入 content.js ----------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.url) return;
  if (!/xiaohongshu\.com/.test(tab.url)) return;

  chrome.storage.local.get('xhs_auto_task', (res) => {
    const task = res && res.xhs_auto_task;
    if (!task || !task.running) return;

    // 先 ping 一下 content 脚本是否已存在
    chrome.tabs.sendMessage(tabId, { type: 'ping' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        // content.js 不存在或被回收，注入兜底
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content.js']
        }).catch(() => {
          // 某些页面（chrome:// 等）无法注入，忽略
        });
      }
    });
  });
});

// ---------- 4. 消息中转（popup -> content 兜底） ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // popup 直接发 relay 时，转发到当前活动标签
  if (msg.type === 'relay' && msg.payload) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (!t || t.id == null) {
        sendResponse({ ok: false, error: 'no_active_tab' });
        return;
      }
      chrome.tabs.sendMessage(t.id, msg.payload, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, data: resp });
        }
      });
    });
    return true; // 异步响应
  }

  return false;
});
