// 小红书自动评论 - Popup 控制脚本
// 纯原生 JS，无框架依赖
'use strict';

var STORAGE_KEY = 'xhs_auto_task';
var POLL_INTERVAL = 1000; // 轮询间隔（毫秒）
var XHS_HOST = 'www.xiaohongshu.com';

// DOM 引用
var elKeyword = document.getElementById('keyword');
var elComments = document.getElementById('comments');
var elTargetCount = document.getElementById('targetCount');
var elMinDelay = document.getElementById('minDelay');
var elMaxDelay = document.getElementById('maxDelay');
var elDailyMax = document.getElementById('dailyMax');
var elHourlyMax = document.getElementById('hourlyMax');
var elSkipRate = document.getElementById('skipRate');
var elRestEvery = document.getElementById('restEvery');
var elRestMin = document.getElementById('restMin');
var elRestMax = document.getElementById('restMax');
var elLikeRate = document.getElementById('likeRate');
var elDiversify = document.getElementById('diversify');
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
  if (typeof task.dailyMax === 'number' && elDailyMax) {
    elDailyMax.value = task.dailyMax;
  }
  if (typeof task.hourlyMax === 'number' && elHourlyMax) {
    elHourlyMax.value = task.hourlyMax;
  }
  if (typeof task.skipRate === 'number' && elSkipRate) {
    elSkipRate.value = task.skipRate;
  }
  if (typeof task.restEvery === 'number' && elRestEvery) {
    elRestEvery.value = task.restEvery;
  }
  if (typeof task.restMin === 'number' && elRestMin) {
    elRestMin.value = task.restMin;
  }
  if (typeof task.restMax === 'number' && elRestMax) {
    elRestMax.value = task.restMax;
  }
  if (elLikeRate) {
    elLikeRate.checked = task.likeRate !== 0;
  }
  if (elDiversify) {
    elDiversify.checked = task.diversify !== false;
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
  // 防封号：默认 30~90 秒，下限放开到 3 秒（用户自设，风险自负）
  var minDelay = toInt(elMinDelay.value, 30, 3, 3600);
  var maxDelay = toInt(elMaxDelay.value, 90, 3, 3600);
  if (maxDelay < minDelay) {
    maxDelay = minDelay;
  }
  var dailyMax = elDailyMax ? toInt(elDailyMax.value, 20, 1, 50) : 20;
  var hourlyMax = elHourlyMax ? toInt(elHourlyMax.value, 8, 1, 20) : 8;
  var skipRate = elSkipRate ? toInt(elSkipRate.value, 15, 0, 50) : 15;
  var restEvery = elRestEvery ? toInt(elRestEvery.value, 5, 0, 20) : 5;
  var restMin = elRestMin ? toInt(elRestMin.value, 60, 30, 3600) : 60;
  var restMax = elRestMax ? toInt(elRestMax.value, 180, 30, 3600) : 180;
  if (restMax < restMin) {
    restMax = restMin;
  }
  var likeOn = elLikeRate ? !!elLikeRate.checked : true;
  var diversifyOn = elDiversify ? !!elDiversify.checked : true;

  // 写回规范化的表单值
  elTargetCount.value = targetCount;
  elMinDelay.value = minDelay;
  elMaxDelay.value = maxDelay;
  if (elDailyMax) elDailyMax.value = dailyMax;
  if (elHourlyMax) elHourlyMax.value = hourlyMax;
  if (elSkipRate) elSkipRate.value = skipRate;
  if (elRestEvery) elRestEvery.value = restEvery;
  if (elRestMin) elRestMin.value = restMin;
  if (elRestMax) elRestMax.value = restMax;

  // 关键修复：新建任务必须清空旧 queue/currentIndex，否则二次启动复用旧队列
  var task = {
    running: true,
    keyword: keyword,
    comments: comments,
    targetCount: targetCount,
    minDelay: minDelay,
    maxDelay: maxDelay,
    dailyMax: dailyMax,
    hourlyMax: hourlyMax,
    skipRate: skipRate,
    restEvery: restEvery,
    restMin: restMin,
    restMax: restMax,
    likeRate: likeOn ? 30 : 0,
    diversify: diversifyOn,
    doneCount: 0,
    queue: [],
    currentIndex: 0,
    failStreak: 0,
    logs: ['任务已创建：关键词「' + keyword + '」，目标 ' + targetCount + ' 篇（防封：' + minDelay + '~' + maxDelay + 's/条，每日≤' + dailyMax + '）']
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

// 轮询最新状态并刷新 UI
function poll() {
  getTask().then(function (task) {
    renderState(task);
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
    startPolling();
  });

  elStartBtn.addEventListener('click', onStart);
  elStopBtn.addEventListener('click', onStop);

  // 关闭 popup 时清理定时器
  window.addEventListener('unload', function () {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
