// 小红书自动评论 - Popup 控制脚本
// 纯原生 JS，无框架依赖
'use strict';

var STORAGE_KEY = 'xhs_auto_task';
var STAT_KEY = 'xhs_auto_stats';
var SENT_KEY = 'xhs_sent_daily';
var POLL_INTERVAL = 1000; // 轮询间隔（毫秒）
var XHS_HOST = 'www.xiaohongshu.com';

// 固定策略（UI选项框已删除）：随机跳过15%，点赞+多样化常开；每日/每小时上限、长休息已移除
var FIXED_GUARD = {
  skipRate: 15,
  likeRate: 30,
  diversify: true
};

// DOM 引用
var elKeyword = document.getElementById('keyword');
var elComments = document.getElementById('comments');
var elTargetCount = document.getElementById('targetCount');
var elMinDelay = document.getElementById('minDelay');
var elMaxDelay = document.getElementById('maxDelay');
var elSentTodayText = document.getElementById('sentTodayText');
var elClearSentBtn = document.getElementById('clearSentBtn');
var elStartBtn = document.getElementById('startBtn');
var elStopBtn = document.getElementById('stopBtn');
var elStatusBadge = document.getElementById('statusBadge');
var elProgressText = document.getElementById('progressText');
var elProgressFill = document.getElementById('progressFill');
var elLogArea = document.getElementById('logArea');

var pollTimer = null;
var lastLogCount = 0;

// 读取存储中的任务状态
function getTask() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(STORAGE_KEY, function (result) {
      resolve(result[STORAGE_KEY] || null);
    });
  });
}

// 写入任务状态（合并）
function saveTask(partial) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(STORAGE_KEY, function (result) {
      var current = result[STORAGE_KEY] || {};
      var next = Object.assign({}, current, partial);
      var obj = {};
      obj[STORAGE_KEY] = next;
      chrome.storage.local.set(obj, function () {
        resolve(next);
      });
    });
  });
}

// 按行拆分评论，去除空行
function parseComments(raw) {
  return String(raw || '')
    .split('\n')
    .map(function (line) {
      return line.trim();
    })
    .filter(function (line) {
      return line.length > 0;
    });
}

// 将任意值转为合法整数并夹取范围
function toInt(value, fallback, min, max) {
  var n = parseInt(value, 10);
  if (isNaN(n)) {
    n = fallback;
  }
  if (typeof min === 'number' && n < min) {
    n = min;
  }
  if (typeof max === 'number' && n > max) {
    n = max;
  }
  return n;
}

// 渲染日志
function renderLogs(logs) {
  var list = logs || [];
  if (list.length === 0) {
    elLogArea.innerHTML = '<span class="log-empty">暂无日志</span>';
    lastLogCount = 0;
    return;
  }
  // 仅在日志数量变化时重建，避免频繁刷新
  if (list.length === lastLogCount && elLogArea.dataset.count === String(list.length)) {
    return;
  }
  lastLogCount = list.length;
  elLogArea.dataset.count = String(list.length);
  elLogArea.textContent = list.join('\n');
  elLogArea.scrollTop = elLogArea.scrollHeight;
}

// 渲染整体状态（徽章 / 进度 / 按钮）
function renderState(task) {
  var running = !!(task && task.running);
  var done = task ? task.doneCount || 0 : 0;
  var total = task ? task.targetCount || 0 : 0;

  elStatusBadge.textContent = running ? '运行中' : '空闲';
  elStatusBadge.className = 'badge ' + (running ? 'badge-running' : 'badge-idle');

  elStartBtn.disabled = running;
  elStopBtn.disabled = !running;

  elProgressText.textContent = '进度：' + done + ' / ' + total;
  var percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  elProgressFill.style.width = percent + '%';

  renderLogs(task ? task.logs : []);
}

// 把存储中的任务数据回填到表单（只在打开时执行）
function fillForm(task) {
  if (!task) {
    return;
  }
  if (typeof task.keyword === 'string' && task.keyword) {
    elKeyword.value = task.keyword;
  }
  if (Array.isArray(task.comments) && task.comments.length > 0) {
    elComments.value = task.comments.join('\n');
  }
  if (typeof task.targetCount === 'number') {
    elTargetCount.value = task.targetCount;
  }
  if (typeof task.minDelay === 'number') {
    elMinDelay.value = task.minDelay;
  }
  if (typeof task.maxDelay === 'number') {
    elMaxDelay.value = task.maxDelay;
  }
}

// 校验表单，返回错误信息字符串（空串代表通过）
function validate(keyword, comments) {
  if (!keyword) {
    return '请填写搜索关键词';
  }
  if (comments.length === 0) {
    return '请填写至少一条评论内容';
  }
  return '';
}

// 获取当前激活标签页
function getActiveTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

// 判断标签页是否在目标站点
function isXhsTab(tab) {
  if (!tab || !tab.url) {
    return false;
  }
  try {
    var url = new URL(tab.url);
    return url.hostname === XHS_HOST || url.hostname.endsWith('.xiaohongshu.com');
  } catch (e) {
    return false;
  }
}

// 启动任务
function onStart() {
  var keyword = String(elKeyword.value || '').trim();
  var comments = parseComments(elComments.value);

  var error = validate(keyword, comments);
  if (error) {
    alert(error);
    return;
  }

  var targetCount = toInt(elTargetCount.value, 5, 1, 30);
  // 效率优先：最小延迟下限为 0（风险自负）
  var minDelay = toInt(elMinDelay.value, 0, 0, 3600);
  var maxDelay = toInt(elMaxDelay.value, 10, 0, 3600);
  if (maxDelay < minDelay) {
    maxDelay = minDelay;
  }
  // 固定策略（选项框已删除，不再从表单读取；每日/每小时上限、长休息已移除）
  var skipRate = FIXED_GUARD.skipRate;
  var likeOn = true;
  var diversifyOn = true;

  // 写回规范化的表单值
  elTargetCount.value = targetCount;
  elMinDelay.value = minDelay;
  elMaxDelay.value = maxDelay;

  // 关键修复：新建任务必须清空旧 queue/currentIndex，否则二次启动复用旧队列
  var task = {
    running: true,
    keyword: keyword,
    comments: comments,
    targetCount: targetCount,
    minDelay: minDelay,
    maxDelay: maxDelay,
    skipRate: skipRate,
    likeRate: likeOn ? 30 : 0,
    diversify: diversifyOn,
    doneCount: 0,
    queue: [],
    currentIndex: 0,
    refillCount: 0,
    failStreak: 0,
    logs: ['任务已创建：关键词「' + keyword + '」，目标 ' + targetCount + ' 篇（间隔 ' + minDelay + '~' + maxDelay + 's/条）']
  };

  saveTask(task).then(function () {
    renderState(task);
    lastLogCount = 0; // 强制刷新日志
    renderLogs(task.logs);
    return getActiveTab();
  }).then(function (tab) {
    if (isXhsTab(tab)) {
      // 已在目标站点，直接通知 content script 开始
      // 先 ping，收不到再走 storage onChanged 兜底（content 会自动 run）
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'ping' }, function (resp) {
          if (chrome.runtime.lastError || !resp) {
            // content 未注入：尝试注入一次
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            }).catch(function () {});
          } else {
            chrome.tabs.sendMessage(tab.id, { type: 'XHS_START' }, function () {
              void chrome.runtime.lastError;
            });
          }
        });
      }
    } else {
      // 不在目标站点，导航到搜索结果页（content 靠 storage 变化自动启动）
      var searchUrl =
        'https://www.xiaohongshu.com/search_result?keyword=' +
        encodeURIComponent(keyword);
      if (tab && tab.id != null) {
        chrome.tabs.update(tab.id, { url: searchUrl });
      } else {
        chrome.tabs.create({ url: searchUrl });
      }
    }
  }).catch(function (err) {
    console.error(err);
    alert('启动失败：' + (err && err.message ? err.message : String(err)));
  });
}

// 停止任务
function onStop() {
  saveTask({ running: false }).then(function (task) {
    var logs = (task.logs || []).concat('任务已停止');
    return saveTask({ logs: logs }).then(function () {
      renderState(Object.assign({}, task, { logs: logs }));
      // 通知内容脚本尽快中断（忽略无接收方错误）
      return getActiveTab();
    });
  }).then(function (tab) {
    if (tab && tab.id != null && isXhsTab(tab)) {
      chrome.tabs.sendMessage(tab.id, { type: 'XHS_STOP' }, function () {
        void chrome.runtime.lastError;
      });
    }
  });
}

// 当天已发送记录（防重复）：{ date: 'YYYY-MM-DD', ids: { noteId: { ts, url } } }
function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

function getSentDaily() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(SENT_KEY, function (result) {
      var s = result[SENT_KEY] || null;
      if (!s || s.date !== todayStr() || !s.ids) {
        resolve({ date: todayStr(), ids: {} });
      } else {
        resolve(s);
      }
    });
  });
}

function getStats() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(STAT_KEY, function (result) {
      var s = result[STAT_KEY] || null;
      if (!s || s.date !== todayStr()) {
        resolve({ date: todayStr(), count: 0, skip: 0, fail: 0 });
      } else {
        resolve(s);
      }
    });
  });
}

function renderSent() {
  Promise.all([getSentDaily(), getStats()]).then(function (arr) {
    var sent = arr[0] || { ids: {} };
    var st = arr[1] || {};
    var n = Object.keys(sent.ids || {}).length;
    var ok = st.count || 0;
    var skip = st.skip || 0;
    var fail = st.fail || 0;
    if (elSentTodayText) {
      elSentTodayText.textContent = '今日成功 ' + ok + ' · 跳过 ' + skip + ' · 失败 ' + fail + '（去重基数 ' + n + '）';
    }
  });
}

function onClearSent() {
  var obj = {};
  obj[SENT_KEY] = { date: todayStr(), ids: {} };
  obj[STAT_KEY] = { date: todayStr(), count: 0, skip: 0, fail: 0, hours: {}, commented: {} };
  chrome.storage.local.set(obj, function () {
    renderSent();
  });
}

// 轮询最新状态并刷新 UI
function poll() {
  getTask().then(function (task) {
    renderState(task);
    renderSent();
  });
}

function startPolling() {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(poll, POLL_INTERVAL);
}

// 初始化
function init() {
  getTask().then(function (task) {
    fillForm(task);
    renderState(task);
    renderSent();
    startPolling();
  });

  elStartBtn.addEventListener('click', onStart);
  elStopBtn.addEventListener('click', onStop);
  if (elClearSentBtn) {
    elClearSentBtn.addEventListener('click', onClearSent);
  }

  // 关闭 popup 时清理定时器
  window.addEventListener('unload', function () {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
