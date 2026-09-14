'use strict';
/**
 * 小红书自动搜索 + 自动评论（Manifest V3 content script）
 *
 * 状态机由 chrome.storage.local 的 xhs_auto_task 驱动：
 *   { running, keyword, comments[], targetCount, minDelay, maxDelay,
 *     skipRate, likeRate, diversify,
 *     doneCount, queue[], currentIndex, refillCount, failStreak, logs[] }
 *
 * 防封号策略（均为零耗时，不加等待）：
 *   1) 间隔（默认 0~10s，下限 0，效率优先风险自负）+ 每条随机抖动
 *   2) 会话文案指纹去重 + 后缀池不重样
 *   3) 点击前鼠标抖动 + 点赞/滚动顺序随机
 *   4) 随机跳过（模拟真人挑选）+ 当天已发送去重（跳过不占发帖名额，自动补采）
 *   5) 验证码/限流/风控文案检测 → 自动暂停
 *   6) 连续失败 3 次熔断
 */

(function () {
  if (window.__XHS_AUTO_BOOTED__) return;
  window.__XHS_AUTO_BOOTED__ = true;

  // ---------- 常量 ----------
  var TASK_KEY = 'xhs_auto_task';
  var STAT_KEY = 'xhs_auto_stats';
  var SENT_KEY = 'xhs_sent_daily';
  var FLOAT_POS_KEY = 'xhs_float_pos';
  var NAV_KEY = '__xhs_auto_nav__';

  var EDITOR_SELECTORS = [
    '#content-textarea',
    '.content-input',
    '.comment-input [contenteditable]',
    '[contenteditable="true"]',
    '[placeholder*="评论"]',
    '[data-placeholder*="评论"]',
    '[aria-placeholder*="评论"]',
    'textarea[placeholder*="评论"]',
    'textarea.comment-input',
    '.comment-editor',
    '.reply-input [contenteditable]',
    '.reply-input textarea',
    '.d-textarea',
    '.d-textarea textarea',
    'div.input-box [contenteditable]',
    'div.input-box textarea',
    '.engage-bar [contenteditable]',
    '.engage-bar textarea'
  ];

  var SUBMIT_SELECTORS = [
    '.btn.submit',
    '.submit',
    '[class*="submit"]',
    'button[type="submit"]',
    '.send-button',
    '[class*="send-button"]',
    '[aria-label*="发送"]',
    '[aria-label*="发布"]',
    '[class*="send"]'
  ];

  var LOGIN_SELECTORS = [
    '.login-container',
    '.login-modal',
    '.login-mask',
    '.sign-container',
    '[class*="login-container"]',
    '[class*="loginModal"]',
    '[class*="login-dialog"]',
    '.login-box'
  ];

  // 验证码 / 滑块 / 风控弹窗
  // 注意：不要用 [class*="slider"]——笔记图片轮播就是 .xhs-slider-container，会 100% 误判
  var CAPTCHA_SELECTORS = [
    '[class*="captcha"]',
    '[class*="Captcha"]',
    '[class*="yidun"]',
    '[class*="geetest"]',
    '[class*="GeeTest"]',
    '[id*="captcha"]',
    '[id*="nc_"]',
    '[class*="verify"]',
    '[class*="Verify"]',
    '.sm-pop',
    '[class*="risk"]'
  ];
  // 强信号：类名/ID 本身就说明是验证码（无需文本确认）
  var CAPTCHA_STRONG_RE = /captcha|yidun|geetest|nc_/i;
  // 弱信号选择器命中时，必须同时见到验证文案才算数（防误杀正常弹窗）
  var CAPTCHA_TEXT_RE = /验证|滑块|拼图|拖动|安全|人机身份/;

  var RATE_LIMIT_RE = /(操作太频繁|稍后再试|频率过快|异常操作|行为异常|验证后重试|滑块验证|安全验证|评论失败|发送失败|被限制|限制评论|禁言)/;

  var DEFAULT_COMMENT = '好棒呀，学到了～';
  var MAX_LOGS = 80;
  var MAX_FAIL_STREAK = 3;

  // 评论多样化后缀（防重复文案检测，零耗时）
  var DIVERSIFY_SUFFIX = ['～', '呀', '呢', '哈', '✨', '~~', '！', '～～', '哦', '啦～', '~', '！!', '呀～', '呢～', '哈～', '👍', '❤️', '～✨', '啦', '哦～'];

  // ---------- 基础工具 ----------
  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  function rand(a, b) {
    if (b < a) { var t = a; a = b; b = t; }
    return Math.floor(Math.random() * (b - a + 1)) + a;
  }

  function pick(arr) {
    if (!arr || !arr.length) return undefined;
    return arr[rand(0, arr.length - 1)];
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function hourStr() {
    return ('0' + new Date().getHours()).slice(-2);
  }

    // 调试：描述被点击的按钮（定位误命中/过期节点）
  function describeEl(el) {
    if (!el) return 'null';
    try {
      var r = el.getBoundingClientRect();
      return el.tagName + '.' + String(el.className || '').slice(0, 50) +
        '[txt=' + String(el.textContent || '').trim().slice(0, 8) +
        ',dis=' + (!!el.disabled) + ',conn=' + (!!el.isConnected) +
        ',w=' + Math.round(r.width) + ',h=' + Math.round(r.height) + ']';
    } catch (e) { return 'unknown'; }
  }

  function isVisible(el) {    if (!el || !el.isConnected) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    var st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    return true;
  }

  function domReady() {
    return new Promise(function (res) {
      if (document.readyState === 'complete' || document.readyState === 'interactive') { res(); return; }
      document.addEventListener('DOMContentLoaded', function () { res(); }, { once: true });
    });
  }

  // ---------- 存储封装 ----------
  function storageGet(keys) {
    return new Promise(function (res) {
      try { chrome.storage.local.get(keys, function (d) { res(d || {}); }); }
      catch (e) { res({}); }
    });
  }

  function storageSet(obj) {
    return new Promise(function (res) {
      try { chrome.storage.local.set(obj, function () { res(); }); }
      catch (e) { res(); }
    });
  }

  function defaults() {
    return {
      running: false,
      keyword: '',
      comments: [],
      targetCount: 5,
      minDelay: 0,
      maxDelay: 10,
      skipRate: 15,
      likeRate: 30,
      diversify: true,
      doneCount: 0,
      queue: [],
      currentIndex: 0,
      refillCount: 0,
      failStreak: 0,
      logs: []
    };
  }

  function getTask() {
    return storageGet([TASK_KEY]).then(function (d) {
      return Object.assign(defaults(), d[TASK_KEY] || {});
    });
  }

  function setTask(patch) {
    return storageGet([TASK_KEY]).then(function (d) {
      var next = Object.assign(defaults(), d[TASK_KEY] || {}, patch || {});
      // 效率优先：间隔下限 0（风险自负）
      if (next.minDelay < 0) next.minDelay = 0;
      if (next.maxDelay < 0) next.maxDelay = 0;
      if (next.maxDelay < next.minDelay) next.maxDelay = next.minDelay;
      var o = {}; o[TASK_KEY] = next;
      return storageSet(o).then(function () { return next; });
    });
  }

  // 统计：成功计数 + 跳过/失败计数 + 每小时计数 + 已评论 ID（只计数展示，不做上限熔断）
  function getStats() {
    return storageGet([STAT_KEY]).then(function (d) {
      var s = d[STAT_KEY] || {};
      if (s.date !== todayStr()) {
        s = { date: todayStr(), count: 0, skip: 0, fail: 0, hours: {}, commented: {} };
      }
      if (!s.hours) s.hours = {};
      if (!s.commented) s.commented = {};
      if (s.skip == null) s.skip = 0;
      if (s.fail == null) s.fail = 0;
      return s;
    });
  }

  function bumpCounter(field) {
    return getStats().then(function (s) {
      s[field] = (s[field] || 0) + 1;
      return setStats(s);
    });
  }

  function setStats(s) {
    var o = {}; o[STAT_KEY] = s;
    return storageSet(o);
  }

  function bumpStats(noteId) {
    return getStats().then(function (s) {
      s.count = (s.count || 0) + 1;
      var h = hourStr();
      s.hours[h] = (s.hours[h] || 0) + 1;
      if (noteId) {
        s.commented[noteId] = Date.now();
        // 裁剪：最多保留 300 个，防止 storage 膨胀
        var keys = Object.keys(s.commented);
        if (keys.length > 300) {
          keys.sort(function (a, b) { return s.commented[a] - s.commented[b]; });
          for (var i = 0; i < keys.length - 300; i++) delete s.commented[keys[i]];
        }
      }
      return setStats(s).then(function () {
        // 同步写入当天已发送记录（防重复核心）
        var url = '';
        try { url = location.href; } catch (e) { url = ''; }
        return markSentToday(noteId, url).catch(function () { /* 忽略去重写入失败 */ }).then(function () { return s; });
      });
    });
  }

  function alreadyCommented(noteId) {
    if (!noteId) return Promise.resolve(false);
    // 双重去重：24h评论记录 + 当天已发送记录（当天记录跨天自动清空）
    return Promise.all([getStats(), getSentDaily()]).then(function (arr) {
      var s = arr[0] || {};
      var sent = arr[1] || {};
      var ts = s.commented && s.commented[noteId];
      if (ts && (Date.now() - ts) < 24 * 3600 * 1000) return true;
      if (sent.ids && sent.ids[noteId]) return true;
      return false;
    });
  }

  // 当天已发送记录：{ date, ids: { noteId: { ts, url } } }，跨天自动清空
  function getSentDaily() {
    return storageGet([SENT_KEY]).then(function (d) {
      var s = d[SENT_KEY] || null;
      if (!s || s.date !== todayStr() || !s.ids) {
        return { date: todayStr(), ids: {} };
      }
      return s;
    });
  }

  function setSentDaily(s) {
    var o = {}; o[SENT_KEY] = s;
    return storageSet(o);
  }

  function markSentToday(noteId, url) {
    if (!noteId) return Promise.resolve(null);
    return getSentDaily().then(function (s) {
      if (s.date !== todayStr()) s = { date: todayStr(), ids: {} };
      s.ids[noteId] = { ts: Date.now(), url: url || '' };
      // 裁剪：最多保留 500 个，防止 storage 膨胀
      var keys = Object.keys(s.ids);
      if (keys.length > 500) {
        keys.sort(function (a, b) { return s.ids[a].ts - s.ids[b].ts; });
        for (var i = 0; i < keys.length - 500; i++) delete s.ids[keys[i]];
      }
      return setSentDaily(s);
    });
  }

  function log(msg) {
    var line = '[XHS自动] ' + msg;
    try { console.log(line); } catch (e) { /* noop */ }
    return getTask().then(function (task) {
      var list = Array.isArray(task.logs) ? task.logs.slice() : [];
      list.push(String(msg));
      while (list.length > MAX_LOGS) list.shift();
      task.logs = list;
      var o = {}; o[TASK_KEY] = task;
      return storageSet(o);
    });
  }

  async function halt(msg) {
    await log(msg);
    await setTask({ running: false });
  }

  // ---------- 页面判定 ----------
  // 修复：统一用 [0-9a-z] 提取 id，避免 /search_result 用 [0-9a-f] 而 /explore 用 [0-9a-z] 导致 sameNote 误判
  function noteIdOf(urlOrPath) {
    try {
      var p = urlOrPath;
      if (urlOrPath.indexOf('http') === 0) p = new URL(urlOrPath).pathname;
      var m = p.match(/\/search_result\/([0-9a-z]{10,})/i) ||
              p.match(/\/(?:explore|discovery\/item)\/([0-9a-z]{10,})/i);
      return m ? m[1].toLowerCase() : '';
    } catch (e) { return ''; }
  }

  function isDetailPage() {
    if (location.pathname.indexOf('/explore/') !== -1 ||
        location.pathname.indexOf('/discovery/item/') !== -1) return true;
    // 跳转中转态：已在 /search_result/<id> 上（含 token），按详情页处理
    return noteIdOf(location.pathname) !== '';
  }

  function isSearchPage() {
    return location.pathname.indexOf('search_result') !== -1 && !isDetailPage();
  }

  function isXhsHost() {
    return /xiaohongshu\.com$/i.test(location.hostname) || /xiaohongshu\.com/i.test(location.hostname);
  }

  function currentKeyword() {
    try { return new URLSearchParams(location.search).get('keyword') || ''; }
    catch (e) { return ''; }
  }

  function searchUrl(keyword) {
    return 'https://www.xiaohongshu.com/search_result?keyword=' +
      encodeURIComponent(keyword) + '&source=web_explore_feed';
  }

  function sameNote(url) {
    var a = noteIdOf(url);
    var b = noteIdOf(location.pathname);
    return !!a && a === b;
  }

  function isLoginWall() {
    if (!document.querySelector) return false;
    for (var i = 0; i < LOGIN_SELECTORS.length; i++) {
      var el = null;
      try { el = document.querySelector(LOGIN_SELECTORS[i]); } catch (e) { el = null; }
      if (el && isVisible(el)) return true;
    }
    return false;
  }

  // 风控检测：验证码 / 限流文案
  function detectRisk() {
    // 1) 验证码类弹窗（强信号直接命中；弱信号需文本二次确认）
    for (var i = 0; i < CAPTCHA_SELECTORS.length; i++) {
      var list = null;
      try { list = document.querySelectorAll(CAPTCHA_SELECTORS[i]); } catch (e) { list = null; }
      if (!list) continue;
      for (var k = 0; k < list.length; k++) {
        var el = list[k];
        if (!isVisible(el)) continue;
        try {
          var r = el.getBoundingClientRect();
          if (r.width <= 10 || r.height <= 10) continue;
        } catch (e) { continue; }
        var clsId = '';
        try { clsId = ((el.className || '').toString() + ' ' + (el.id || '')); } catch (e) { clsId = ''; }
        if (CAPTCHA_STRONG_RE.test(clsId)) {
          return '检测到验证弹窗（' + CAPTCHA_SELECTORS[i] + '），已自动暂停，请手动完成验证后再继续';
        }
        var txt = '';
        try { txt = (el.innerText || '').slice(0, 200); } catch (e) { txt = ''; }
        if (CAPTCHA_TEXT_RE.test(txt)) {
          return '检测到验证弹窗（' + CAPTCHA_SELECTORS[i] + '），已自动暂停，请手动完成验证后再继续';
        }
      }
    }
    // 2) 限流文案
    try {
      var bodyText = (document.body && document.body.innerText) || '';
      if (bodyText.length < 20000) {
        var m = bodyText.match(RATE_LIMIT_RE);
        if (m) return '检测到风控提示（' + m[1] + '），已自动暂停，建议休息 30 分钟以上';
      } else {
        // 页面文本太长时只检查评论区附近
        var zone = document.querySelector('.engage-bar, .comments-container, .note-container');
        var zt = zone ? (zone.innerText || '') : '';
        var m2 = zt.match(RATE_LIMIT_RE);
        if (m2) return '检测到风控提示（' + m2[1] + '），已自动暂停';
      }
    } catch (e) { /* noop */ }
    return '';
  }

  // ---------- 导航守卫（跨页面存活） ----------
  function getNav() {
    try { return JSON.parse(sessionStorage.getItem(NAV_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function setNav(v) {
    try { sessionStorage.setItem(NAV_KEY, JSON.stringify(v)); } catch (e) { /* noop */ }
  }

  // ---------- DOM 交互工具 ----------
  function waitForSelector(sels, timeout) {
    var list = Array.isArray(sels) ? sels : [sels];
    var limit = timeout || 15000;
    var start = Date.now();
    return (async function poll() {
      while (Date.now() - start < limit) {
        if (isLoginWall()) return null;
        var risk = detectRisk();
        if (risk) return null;
        for (var i = 0; i < list.length; i++) {
          var els = null;
          try { els = document.querySelectorAll(list[i]); } catch (e) { els = null; }
          if (!els) continue;
          for (var j = 0; j < els.length; j++) {
            if (isVisible(els[j])) return els[j];
          }
        }
        await sleep(300);
      }
      return null;
    })();
  }

  function scrollToComments() {
    try {
      var anchor = document.querySelector('.engage-bar, .comments-container, #content-textarea, .input-box');
      if (anchor && anchor.scrollIntoView) {
        anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return true;
      }
    } catch (e) { /* noop */ }
    return false;
  }

  // 零耗时防封：点击前补 2~3 次鼠标位移事件，轨迹更像真人（同步派发，不增加等待）
  function jitterMouse() {
    try {
      var cx = Math.round(window.innerWidth / 2 + rand(-40, 40));
      var cy = Math.round(window.innerHeight / 2 + rand(-40, 40));
      for (var i = 0; i < 3; i++) {
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true,
          clientX: cx + rand(-12, 12), clientY: cy + rand(-12, 12)
        }));
      }
    } catch (e) { /* noop */ }
  }

  function safeClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: 'center' });
    } catch (e) { /* noop */ }
    try {
      var r = el.getBoundingClientRect();
      var base = {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        button: 0
      };
      // 小红书展开评论区监听 pointer 事件，只发 mouse 事件展不开，需成套发
      try {
        el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }, base)));
      } catch (e) { /* noop */ }
      el.dispatchEvent(new MouseEvent('mousedown', base));
      try {
        el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }, base)));
      } catch (e) { /* noop */ }
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
    } catch (e) {
      try { el.click(); } catch (_) { /* noop */ }
    }
  }

  // 评论区是否已展开（和人点击后一致的状态）：内层 .engage-bar.active + 遮罩消失 + 底部工具条可见
  function isEditorExpanded() {
    try {
      var bars = document.querySelectorAll('.engage-bar');
      var hasActive = false;
      for (var i = 0; i < bars.length; i++) {
        if (bars[i].classList && bars[i].classList.contains('active')) { hasActive = true; break; }
      }
      var ov = document.querySelector('.not-active');
      if (ov && isVisible(ov)) {
        try {
          var r = ov.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) return false;
        } catch (e) { return false; }
      }
      if (hasActive) return true;
      var bottom = document.querySelector('.bottom');
      if (bottom && isVisible(bottom)) {
        try {
          var br = bottom.getBoundingClientRect();
          if (br.height > 10) return true;
        } catch (e) { /* noop */ }
      }
      // 遮罩已消失也算展开（兼容改版）
      if (!ov) return true;
      return hasActive;
    } catch (e) { return true; }
  }

  // 拟人展开：必须点“说点什么...”遮罩层，而不是直接点编辑器
  // 直接 safeClick(editor) 只会聚焦，展不开，字会塞进收起的小条里（和人点效果不一样）
  async function openEditor(editor) {
    try {
      if (isEditorExpanded()) {
        try { editor.focus(); } catch (e) { /* noop */ }
        return true;
      }
      var cands = [];
      try { cands = document.querySelectorAll('.not-active .inner, .not-active, .inner-when-not-active .inner'); } catch (e) { cands = []; }
      for (var i = 0; i < cands.length; i++) {
        var t = cands[i];
        if (!t || !isVisible(t)) continue;
        safeClick(t);
        await sleep(rand(700, 1200));
        if (isEditorExpanded()) {
          try { editor.focus(); } catch (e) { /* noop */ }
          await sleep(rand(300, 600));
          return true;
        }
      }
      // 兜底：触发器找不到时才直接点编辑器
      safeClick(editor);
      try { editor.focus(); } catch (e) { /* noop */ }
      await sleep(rand(700, 1100));
      return isEditorExpanded();
    } catch (e) { return false; }
  }

  // 拟人输入：修正事件顺序 keydown→beforeinput→插入→input→keyup，确保 Vue 响应式生效
  // 2026-09-14 修复显示异常：旧代码先插入后补 beforeinput，且回退用 insertNode 野路子，
  // 导致 DOM 有字但 Vue model 为空（发送按钮灰色 disabled），或出现多余 <div><br></div> 结构
  function setCaretToEnd(el) {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      var sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      return true;
    } catch (e) { return false; }
  }

  function fireKey(el, type, ch) {
    try {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: ch, code: 'Key' + (String(ch || 'A').toUpperCase().charCodeAt(0) || 65),
        bubbles: true, cancelable: true
      }));
    } catch (e) { /* noop */ }
  }

  function fireBeforeInput(el, ch) {
    try {
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: ch, inputType: 'insertText' }));
    } catch (e) { /* noop */ }
  }

  function fireInput(el, ch) {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, data: ch, inputType: 'insertText' }));
    } catch (e) {
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { /* noop */ }
    }
  }

  async function humanType(el, text) {
    if (!el || !text) return;
    var isFormField = false;
    try {
      isFormField = (el.tagName === 'TEXTAREA') ||
        (el.tagName === 'INPUT' && (!el.type || /^(text|search)$/i.test(el.type)));
    } catch (e) { isFormField = false; }
    try { el.focus(); } catch (e) { /* noop */ }
    try { el.click && el.click(); } catch (e) { /* noop */ }
    await sleep(rand(200, 400));

    // 表单类编辑器（textarea/input）：走 value 路径，contenteditable 那套对其无效
    if (isFormField) {
      try {
        el.focus();
        try {
          var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, '');
          else el.value = '';
        } catch (e) { try { el.value = ''; } catch (_) { /* noop */ } }
        fireInput(el, '');
        await sleep(rand(150, 300));
        var full = String(text);
        for (var fi = 0; fi < full.length; fi += rand(1, 2)) {
          var part = full.slice(0, fi + 1);
          try {
            var p2 = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var d2 = Object.getOwnPropertyDescriptor(p2, 'value');
            if (d2 && d2.set) d2.set.call(el, part);
            else el.value = part;
          } catch (e) { try { el.value = part; } catch (_) { /* noop */ } }
          fireInput(el, part);
          await sleep(rand(50, 140));
        }
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* noop */ }
      } catch (e) { /* noop */ }
      await sleep(rand(300, 600));
      return;
    }

    // 1) 先清空残留：旧页面取消/发送后编辑器仍留字，会与 Vue model 不同步造成显示异常
    try {
      setCaretToEnd(el);
      try { document.execCommand('selectAll', false, null); } catch (e) { /* noop */ }
      try { document.execCommand('delete', false, null); } catch (e) { /* noop */ }
    } catch (e) { /* noop */ }
    try { el.innerHTML = ''; } catch (e) { /* noop */ }
    try { el.textContent = ''; } catch (e) { /* noop */ }
    fireInput(el, '');
    await sleep(rand(200, 400));
    try { el.focus(); } catch (e) { /* noop */ }
    setCaretToEnd(el);

    // 2) 逐字输入：每次 beforeinput 先于插入，execCommand 失败则整段回退（不用 insertNode 碎片插入）
    var useFallback = false;
    var i = 0;
    while (i < text.length) {
      var n = rand(1, 2);
      var chunk = text.slice(i, i + n);
      i += n;
      if (useFallback) break;

      for (var k = 0; k < chunk.length; k++) {
        var ch = chunk[k];
        fireKey(el, 'keydown', ch);
        fireBeforeInput(el, ch);
        var inserted = false;
        try { inserted = document.execCommand('insertText', false, ch); }
        catch (e) { inserted = false; }
        if (!inserted) { useFallback = true; break; }
        fireInput(el, ch);
        fireKey(el, 'keyup', ch);
        setCaretToEnd(el);
        await sleep(rand(50, 140));
      }
    }

    // 3) 回退：整体设置 textContent（不断裂 DOM 结构）+ 补 input 事件唤醒 Vue
    // 兼容新版 Chrome execCommand 被禁用：用原生 value setter + Composition 事件链唤醒框架
    if (useFallback) {
      try {
        el.focus();
        el.textContent = text;
        setCaretToEnd(el);
        try {
          el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true, data: '' }));
        } catch (e) { /* noop */ }
        fireInput(el, text);
        try {
          el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true, data: text }));
        } catch (e) { /* noop */ }
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* noop */ }
      } catch (e) { /* noop */ }
    } else {
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* noop */ }
    }

    // 4) 等 Vue 响应：execCommand 原生 input 事件有 debounce，轮询按钮 disabled
    var t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      try {
        var b = document.querySelector('.btn.submit');
        if (b && !b.disabled) break;
        // 没亮就再补一次 input（不改内容，只唤醒监听）
        fireInput(el, '');
      } catch (e) { /* noop */ }
      await sleep(400);
    }
    await sleep(rand(300, 600));
  }

  function pressCtrlEnter(el) {
    var init = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      ctrlKey: true, bubbles: true, cancelable: true
    };
    ['keydown', 'keypress', 'keyup'].forEach(function (type) {
      try { el.dispatchEvent(new KeyboardEvent(type, init)); } catch (e) { /* noop */ }
    });
  }

  function isEditorCleared(el) {
    var v;
    try {
      v = (typeof el.value === 'string') ? el.value : (el.textContent || '');
    } catch (e) { v = ''; }
    return String(v).trim().length === 0;
  }

  function findSubmitButton(editor, allowDisabled) {
    var container = null;
    try {
      // 实测：编辑器与发送按钮共享祖先 .engage-bar，这里逐级上找
      var p = editor;
      for (var d = 0; d < 6 && p; d++) {
        if (p.classList && (p.classList.contains('engage-bar') || p.classList.contains('input-box') || p.classList.contains('bottom'))) {
          container = p;
          break;
        }
        p = p.parentElement;
      }
      if (!container) {
        container = editor.closest('.comment-input, .comment-box, .d-textarea-wrapper, form, [class*="comment"], .engage-bar, .input-box') || document;
      }
    } catch (e) { container = document; }

    function accept(btn) {
      if (!btn || !isVisible(btn)) return false;
      // 2026-09-14 真因修复：底部工具栏图标（如 .bottom-box-right-submit-button 图片/表情按钮）
      // 类名含 submit/send 且没有 disabled 属性，旧逻辑 !disabled 恒成立会误命中。
      // 非 <button> 元素必须带明确发送文案才接受，图标（空文本）一律排除。
      var txt = '';
      try { txt = (btn.textContent || '').trim(); } catch (e) { txt = ''; }
      var isBtn = false;
      try {
        isBtn = (btn.tagName === 'BUTTON') ||
                (btn.getAttribute && btn.getAttribute('role') === 'button') ||
                ('disabled' in btn);
      } catch (e) { isBtn = false; }
      if (!isBtn && !/^(发布|发送|评论|提交|发送评论)$/.test(txt)) return false;
      if (!allowDisabled && btn.disabled) return false;
      return true;
    }

    for (var i = 0; i < SUBMIT_SELECTORS.length; i++) {
      var els = null;
      try { els = container.querySelectorAll(SUBMIT_SELECTORS[i]); } catch (e) { els = null; }
      if (!els) continue;
      for (var j = 0; j < els.length; j++) {
        if (accept(els[j])) return els[j];
      }
    }

    // 文案兜底
    var TEXT_RE = /^(发布|发送|评论|提交|发送评论)$/;
    var btns = [];
    try { btns = container.querySelectorAll('button, [role="button"], .btn, [class*="btn"]'); }
    catch (e) { btns = []; }
    for (var k = 0; k < btns.length; k++) {
      var txt = (btns[k].textContent || '').trim();
      if (TEXT_RE.test(txt) && accept(btns[k])) return btns[k];
    }
    // 容器内找不到时扩大到全文档（按钮可能与编辑器不在同一祖先下，如 .bottom 兄弟节点）
    if (container !== document) {
      for (var di = 0; di < SUBMIT_SELECTORS.length; di++) {
        var dels = null;
        try { dels = document.querySelectorAll(SUBMIT_SELECTORS[di]); } catch (e) { dels = null; }
        if (!dels) continue;
        for (var dj = 0; dj < dels.length; dj++) {
          if (accept(dels[dj])) return dels[dj];
        }
      }
      var dbtns = [];
      try { dbtns = document.querySelectorAll('button, [role="button"]'); } catch (e) { dbtns = []; }
      for (var dk = 0; dk < dbtns.length; dk++) {
        var dtxt = (dbtns[dk].textContent || '').trim();
        if (TEXT_RE.test(dtxt) && accept(dbtns[dk])) return dbtns[dk];
      }
    }
    return null;
  }

  // 等发送按钮变可用：Vue 有 debounce，直接找 !disabled 的按钮，找不到就补 input 事件唤醒
  async function waitForSubmitEnabled(editor, timeoutMs) {
    var limit = timeoutMs || 10000;
    var start = Date.now();
    var seenDisabled = false;
    while (Date.now() - start < limit) {
      var btn = findSubmitButton(editor, false);
      if (btn) {
        try { await log('发送按钮已就绪：' + describeEl(btn)); } catch (e) { /* noop */ }
        return btn;
      }
      var any = findSubmitButton(editor, true);
      if (any) seenDisabled = true;
      // 输入可能没触发响应式，再补一次 input 事件
      try { fireInput(editor, ''); } catch (e) {
        try { editor.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { /* noop */ }
      }
      await sleep(500);
    }
    if (seenDisabled) await log('发送按钮仍为灰色（disabled），Vue 未识别输入内容，已跳过本条');
    return null;
  }

  function findCommentTrigger() {
    var sels = ['.comment-input', '[class*="comment-input"]', '.comments-container', '.engage-bar', '.input-box'];
    for (var s = 0; s < sels.length; s++) {
      var box = null;
      try { box = document.querySelector(sels[s]); } catch (e) { box = null; }
      if (box && isVisible(box)) {
        var inner = null;
        try { inner = box.querySelector('[contenteditable], textarea, .input, p'); } catch (e) { inner = null; }
        if (inner && isVisible(inner)) return inner;
        return box;
      }
    }
    var cands = [];
    try { cands = document.querySelectorAll('div, span, p'); } catch (e) { cands = []; }
    for (var i = 0; i < cands.length && i < 3000; i++) {
      var el = cands[i];
      if (el.children && el.children.length) continue;
      var txt = (el.textContent || '').trim();
      if ((txt === '说点什么...' || txt === '说点什么' || txt === '评论') && isVisible(el)) return el;
    }
    return null;
  }

  function findLikeButton() {
    var sels = [
      '[aria-label*="赞"]', '[aria-label*="喜欢"]',
      '[class*="like"]', '[class*="Like"]',
      '[class*="praise"]', '[class*="collect"]', '[class*="Collect"]'
    ];
    for (var i = 0; i < sels.length; i++) {
      var els = [];
      try { els = document.querySelectorAll(sels[i]); } catch (e) { els = []; }
      for (var j = 0; j < els.length; j++) {
        if (isVisible(els[j])) return els[j];
      }
    }
    return null;
  }

  // 会话级文案指纹：同一次任务内不重复用同一条文案（零耗时，池子用完自动重置）
  var sessionCommentHist = {};
  var lastSuffix = '';

  function pickFreshComment(comments) {
    if (!comments || !comments.length) return undefined;
    var fresh = [];
    for (var i = 0; i < comments.length; i++) {
      if (!sessionCommentHist[comments[i]]) fresh.push(comments[i]);
    }
    if (!fresh.length) {
      sessionCommentHist = {};
      fresh = comments.slice();
    }
    var c = pick(fresh);
    if (c != null) sessionCommentHist[c] = 1;
    return c;
  }

  function diversifyComment(text) {
    if (!text) return text;
    // 30% 概率不加后缀，保持原样
    if (Math.random() < 0.3) return text;
    // 后缀不与上一条重样（防连续重复指纹），最多重试 5 次
    var suf = '';
    for (var t = 0; t < 5; t++) {
      suf = pick(DIVERSIFY_SUFFIX) || '';
      if (suf !== lastSuffix) break;
    }
    // 避免重复叠加相同后缀
    if (suf && text.endsWith(suf)) return text;
    if (suf) lastSuffix = suf;
    return text + suf;
  }

  // ---------- 拟人浏览（防封核心） ----------
  async function simulateBrowsing(task) {
    // 点赞时机随机化（浏览前/浏览后，零新增耗时：只是把同一次点赞换个位置）
    var likeFirst = Math.random() < 0.5;
    async function maybeLike() {
      try {
        var rate = (task.likeRate == null) ? 30 : task.likeRate;
        if (rate > 0 && rand(1, 100) <= rate) {
          var likeBtn = findLikeButton();
          if (likeBtn) {
            jitterMouse();
            safeClick(likeBtn);
            await log('模拟真人行为：随机点赞 1 次');
            await sleep(rand(800, 1500));
            return true;
          }
        }
      } catch (e) { /* 点赞失败不阻塞 */ }
      return false;
    }
    // 随机停留 2~6 秒
    await sleep(rand(2000, 6000));
    if (likeFirst) await maybeLike();
    // 随机滚动 2~4 次（方向随机抖动：偶尔上滑回看，更像真人）
    var rounds = rand(2, 4);
    for (var i = 0; i < rounds; i++) {
      var dir = (Math.random() < 0.85) ? 1 : -1;
      var dist = rand(200, 600) * dir;
      try {
        window.scrollBy({ top: dist, behavior: 'smooth' });
      } catch (e) { window.scrollBy(0, dist); }
      await sleep(rand(600, 1500));
    }
    if (!likeFirst) await maybeLike();
    // 滚回评论区
    scrollToComments();
    await sleep(rand(500, 1200));
  }

  // ---------- 评论成功判定（修复：新版页面发送成功后编辑器不清空） ----------
  // 根因：2026-09 实测 comment/post 接口返回 success:true、toast“评论已发布”、
  // 评论数 29→30，但 #content-textarea 仍保留原文，导致旧逻辑 isEditorCleared 误判失败
  function getCommentCount() {
    try {
      var el = document.querySelector('.total');
      if (!el) return -1;
      var m = (el.textContent || '').match(/(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    } catch (e) { return -1; }
  }

  function hasSuccessToast() {
    try {
      var nodes = document.querySelectorAll('.reds-toast, .toast, [class*="toast"], [class*="Toast"], [class*="message"], .reds-message');
      for (var i = 0; i < nodes.length; i++) {
        var t = (nodes[i].textContent || '').trim();
        if (/评论已发布|发布成功|发送成功|评论成功/.test(t) && isVisible(nodes[i])) return true;
      }
      // 兜底：toast 可能挂在 body 下且无固定类名，用小尺寸可见元素匹配
      var all = document.querySelectorAll('div, span');
      for (var j = 0; j < all.length; j++) {
        var txt = (all[j].textContent || '').trim();
        if ((txt === '评论已发布' || txt === '发布成功' || txt === '发送成功') && isVisible(all[j])) {
          try {
            var r = all[j].getBoundingClientRect();
            if (r.width < 400 && r.height < 120) return true;
          } catch (e) { return true; }
        }
      }
    } catch (e) { /* noop */ }
    return false;
  }

  function hasOwnComment(text) {
    try {
      var key = String(text || '').trim().slice(0, 20);
      if (!key) return false;
      var zone = document.querySelector('.comments-container, .note-container') || document.body;
      var html = zone.innerText || '';
      return html.indexOf(key) !== -1;
    } catch (e) { return false; }
  }

  function clearEditor(editor) {
    try {
      if (editor) {
        try { editor.focus(); } catch (e) { /* noop */ }
        try { editor.innerHTML = ''; } catch (e) { /* noop */ }
        try { editor.textContent = ''; } catch (e) { /* noop */ }
        try { editor.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* noop */ }
        try { editor.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* noop */ }
      }
      var cancel = document.querySelector('.btn.cancel');
      if (cancel && isVisible(cancel)) safeClick(cancel);
    } catch (e) { /* noop */ }
  }

  function isPostSuccess(editor, text, beforeCount) {
    try {
      if (isEditorCleared(editor)) return true;
      if (hasSuccessToast()) return true;
      var now = getCommentCount();
      if (beforeCount >= 0 && now > beforeCount) return true;
      // 计数选择器缺失时，评论区出现原文即视为成功（兼容编辑器不清空的新版行为）
      if (text && hasOwnComment(text) && (beforeCount < 0 || now < 0)) return true;
    } catch (e) { /* noop */ }
    return false;
  }

  // ---------- 评论动作 ----------
  async function doComment(editor, text) {
    try {
      scrollToComments();
      await sleep(rand(400, 900));

      // 先拟人展开（点“说点什么...”遮罩），再输入；直接点编辑器展不开，字会进收起的小条
      var opened = await openEditor(editor);
      if (!opened) {
        await log('评论区展开失败（遮罩点击未生效），跳过本条');
      }
      // 2026-09-14 真测修复：展开点击会触发 SPA 重渲染，旧编辑器节点可能已脱离 DOM
      // （实测 conn=false、w=0 的 detached 节点，打字进去 Vue 收不到，发送键恒灰）。
      // 此处必须重新查询当前可见节点，后续 humanType/找按钮都用新引用
      try {
        var fresh = await waitForSelector(EDITOR_SELECTORS, 5000);
        if (fresh) editor = fresh;
      } catch (e) { /* 保持旧引用兜底 */ }
      await sleep(rand(300, 600));

      var beforeCount = getCommentCount();

      await humanType(editor, text);
      await sleep(rand(500, 1000));

      var risk = detectRisk();
      if (risk) {
        await halt(risk);
        return 'risk';
      }

      // 发送按钮初始为 disabled，输入后 Vue 异步点亮，需等待而非立即 Ctrl+Enter
      // （旧逻辑找不到可用按钮就 Ctrl+Enter，会在编辑器里留下 <div><br></div> 造成显示异常）
      var btn = await waitForSubmitEnabled(editor, 10000);
      if (btn) {
        await sleep(rand(400, 900)); // 点发送前再顿一下，更像真人
        try { await log('准备点击发送：' + describeEl(btn)); } catch (e) { /* noop */ }
        jitterMouse(); // 零耗时：点击前补 2~3 次鼠标位移事件，轨迹更像真人（不增加等待）
        safeClick(btn);
        try { await log('已点击发送，等待回执…'); } catch (e) { /* noop */ }
      } else {
        try {
          var diag = '编辑器=' + describeEl(editor) + '，内容=' + String((editor.value != null ? editor.value : editor.textContent) || '').slice(0, 20);
          var disBtn = findSubmitButton(editor, true);
          diag += disBtn ? '，禁用按钮=' + describeEl(disBtn) : '，全页无发送候选';
          await log('未找到可用的发送按钮（可能 Vue 未识别输入），跳过本条；' + diag);
        } catch (e) { await log('未找到可用的发送按钮（可能 Vue 未识别输入），跳过本条'); }
        clearEditor(editor);
        var cur = await getTask();
        await setTask({ currentIndex: (cur.currentIndex || 0) + 1, failStreak: (cur.failStreak || 0) + 1 });
        await bumpCounter('fail');
        return false;
      }

      await sleep(3000);

      // 风控二次检查
      var risk2 = detectRisk();
      if (risk2) {
        await halt(risk2);
        return 'risk';
      }

      if (isPostSuccess(editor, text, beforeCount)) {
        clearEditor(editor);
        return true;
      }

      // 兜底再试一次 Ctrl+Enter（兼容发送按钮未真正触发的场景）
      pressCtrlEnter(editor);
      await sleep(2500);
      var risk3 = detectRisk();
      if (risk3) {
        await halt(risk3);
        return 'risk';
      }
      if (isPostSuccess(editor, text, beforeCount)) {
        clearEditor(editor);
        return true;
      }
      // 诊断日志：点击已发出但无成功信号时，留下判定依据（计数/编辑器/toast），方便定位是误判还是真失败
      try {
        await log('发送无回执：计数' + beforeCount + '→' + getCommentCount() + '，编辑器已清空=' + isEditorCleared(editor) + '，成功提示=' + hasSuccessToast());
      } catch (e) { /* noop */ }
      return false;
    } catch (e) {
      await log('doComment 异常：' + (e && e.message ? e.message : e));
      return false;
    }
  }

  async function commentCurrent(task) {
    try {
      if (isLoginWall()) {
        await halt('请先登录');
        return 'halt';
      }
      var risk0 = detectRisk();
      if (risk0) {
        await halt(risk0);
        return 'halt';
      }
      if (!task.comments || !task.comments.length) {
        await halt('评论内容为空，已停止');
        return 'halt';
      }

      var noteId = noteIdOf(location.pathname);
      // 当天防重复：已发送过的帖子跳过
      if (await alreadyCommented(noteId)) {
        await log('该笔记今天已发送过，跳过（当天防重复）');
        await bumpCounter('skip');
        await setTask({ currentIndex: task.currentIndex + 1, failStreak: 0 });
        return 'skip';
      }

      // 随机跳过（模拟真人挑选）
      var skipRate = (task.skipRate == null) ? 15 : task.skipRate;
      if (skipRate > 0 && rand(1, 100) <= skipRate) {
        await log('随机跳过第 ' + (task.currentIndex + 1) + ' 条（模拟真人挑选）');
        await bumpCounter('skip');
        await setTask({ currentIndex: task.currentIndex + 1, failStreak: 0 });
        return 'skip';
      }

      // 拟人浏览
      await simulateBrowsing(task);

      scrollToComments();
      var editor = await waitForSelector(EDITOR_SELECTORS, 10000);
      if (!editor) {
        var trigger = findCommentTrigger();
        if (trigger) {
          safeClick(trigger);
          await sleep(rand(800, 1400));
          editor = await waitForSelector(EDITOR_SELECTORS, 8000);
        }
      }

      var patch = { currentIndex: task.currentIndex + 1, doneCount: task.doneCount, failStreak: task.failStreak || 0 };

      if (!editor) {
        patch.failStreak = (task.failStreak || 0) + 1;
        await setTask(patch);
        await bumpCounter('fail');
        await log('未找到评论输入框，跳过第 ' + (task.currentIndex + 1) + ' 条（连续失败 ' + patch.failStreak + ' 次）');
        if (patch.failStreak >= MAX_FAIL_STREAK) {
          await halt('连续 ' + MAX_FAIL_STREAK + ' 次找不到输入框，可能页面改版或被限流，已自动停止');
          return 'halt';
        }
        return false;
      }

      var raw = pickFreshComment(task.comments) || DEFAULT_COMMENT;
      var text = task.diversify === false ? raw : diversifyComment(raw);
      var result = await doComment(editor, text);

      if (result === 'risk') return 'halt'; // doComment 内已 halt
      if (result === true) {
        patch.doneCount = task.doneCount + 1;
        patch.failStreak = 0;
        await setTask(patch);
        await bumpStats(noteId);
        await log('评论成功：' + text + '（' + patch.doneCount + '/' + (task.targetCount || task.queue.length) + '）');
        return true;
      } else {
        patch.failStreak = (task.failStreak || 0) + 1;
        await setTask(patch);
        await bumpCounter('fail');
        await log('评论失败：' + text + '（连续失败 ' + patch.failStreak + ' 次）');
        if (patch.failStreak >= MAX_FAIL_STREAK) {
          await halt('连续 ' + MAX_FAIL_STREAK + ' 次评论失败，可能被限流或需验证，已自动停止');
          return 'halt';
        }
        return false;
      }
    } catch (e) {
      await log('commentCurrent 异常：' + (e && e.message ? e.message : e));
      await setTask({ currentIndex: task.currentIndex + 1, failStreak: (task.failStreak || 0) + 1 });
      return false;
    }
  }

  // ---------- 主流程 ----------
  async function collectPostLinks(targetCount) {
    var seen = {};
    // 先把已评论过的排除掉（24h记录 + 当天已发送记录双重过滤）
    var stats = await getStats().catch(function () { return { commented: {} }; });
    var sentDaily = await getSentDaily().catch(function () { return { ids: {} }; });
    var links = [];
    var lastCount = -1;

    function gather() {
      var anchors = [];
      try { anchors = document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"], a[href*="/discovery/item/"]'); }
      catch (e) { anchors = []; }
      for (var i = 0; i < anchors.length; i++) {
        var href = anchors[i].getAttribute('href') || anchors[i].href;
        if (!href) continue;
        var u;
        try { u = new URL(href, location.origin); } catch (e) { continue; }
        // 2026-09-14 真测修复：无 xsec_token 的 /explore/ 链接会 404（已复现），直接丢弃
        if (!u.searchParams.get('xsec_token')) continue;
        var id = noteIdOf(u.pathname);
        if (!id) continue; // 排除搜索页本身 /search_result/?keyword=...
        if (seen[id]) continue;
        // 24h 内评论过去重 + 当天已发送去重
        if (stats.commented && stats.commented[id] && (Date.now() - stats.commented[id]) < 24 * 3600 * 1000) continue;
        if (sentDaily.ids && sentDaily.ids[id]) continue;
        seen[id] = true;
        links.push(u.href); // 保留 xsec_token 等查询参数（无 token 的详情页会 404）
      }
    }

    var rounds = rand(6, 10);
    for (var r = 0; r < rounds; r++) {
      gather();
      if (links.length >= targetCount) break;
      if (links.length === lastCount && r >= 2) break; // 无增长即停止
      lastCount = links.length;

      var step = rand(400, 900);
      try { window.scrollBy({ top: step, behavior: 'smooth' }); } catch (e) { window.scrollBy(0, step); }
      try { document.documentElement.scrollTop += rand(0, 120); } catch (e) { /* noop */ }
      await sleep(rand(800, 1600));
    }
    gather();
    return links.slice(0, targetCount);
  }

  async function processQueue() {
    var guard = 0;
    while (guard++ < 2000) {
      var task = await getTask();
      if (!task.running) return;

      if (task.doneCount >= (task.targetCount || 0)) {
        await setTask({ running: false });
        await log('已达目标数量，共评论 ' + task.doneCount + ' 条');
        return;
      }

      if (task.currentIndex >= task.queue.length) {
        // 跳过不计入发帖名额：队列耗尽但成功数未达标时，回搜索页补充收集（自动排除已发送）
        var need = (task.targetCount || 0) - (task.doneCount || 0);
        var refills = task.refillCount || 0;
        if (need > 0 && task.keyword && refills < 3) {
          await log('本轮已处理完，成功 ' + task.doneCount + '/' + task.targetCount + '（跳过不占名额），回搜索页第 ' + (refills + 1) + ' 次补充收集…');
          await setTask({ queue: [], currentIndex: 0, refillCount: refills + 1 });
          location.href = searchUrl(task.keyword);
          return;
        }
        await setTask({ running: false });
        await log('任务结束，共成功评论 ' + task.doneCount + ' 条' + (need > 0 ? '（剩余 ' + need + ' 条无新笔记可发）' : ''));
        return;
      }

      var target = task.queue[task.currentIndex];

      if (isDetailPage() && sameNote(target)) {
        if (isLoginWall()) { await halt('请先登录'); return; }
        var r = await commentCurrent(task);
        if (r === 'halt') return;
        var gapLo = (task.minDelay == null) ? 0 : task.minDelay;
        var gapHi = (task.maxDelay == null) ? 10 : task.maxDelay;
        var gap = rand(gapLo, gapHi);
        await log('等待 ' + gap + ' 秒后继续（防封间隔）…');
        await sleep(gap * 1000);
        continue; // 下一轮推进到下一篇
      }

      // 导航守卫：同一目标短时间重复未生效则跳过，避免死循环
      var nav = getNav();
      if (nav.url === target && (Date.now() - (nav.ts || 0)) < 10000) {
        await log('导航目标未生效，跳过：' + target);
        await setTask({ currentIndex: task.currentIndex + 1 });
        continue;
      }

      setNav({ url: target, ts: Date.now() });
      try { window.scrollTo(0, 0); } catch (e) { /* noop */ }
      await sleep(rand(500, 1200));
      location.href = target; // 整页跳转以保留登录态
      return;                 // 页面卸载，新页面 boot 后继续
    }
  }

  async function runSearchFlow(task) {
    if (currentKeyword() !== task.keyword) {
      await log('跳转到关键词搜索页：' + task.keyword);
      location.href = searchUrl(task.keyword);
      return;
    }

    if (!task.queue || !task.queue.length) {
      await log('开始收集笔记链接（目标 ' + task.targetCount + ' 条）');
      var links = await collectPostLinks(task.targetCount);
      if (!links.length) {
        await halt('未找到任何笔记（可能无结果或 24h 内已评论过），已停止');
        return;
      }
      // 注意：补充收集时不能重置 doneCount（成功数要累计，跳过不占名额）
      await setTask({ queue: links, currentIndex: 0, failStreak: 0 });
      await log('已收集 ' + links.length + ' 条笔记（已自动去重）');
    }

    await processQueue();
  }

  async function run() {
    if (window.__XHS_RUNNING__) return;
    window.__XHS_RUNNING__ = true;
    try {
      if (!isXhsHost()) return;
      await domReady();

      var task = await getTask();
      if (!task.running) return;

      if (isLoginWall()) { await halt('请先登录'); return; }
      var risk = detectRisk();
      if (risk) { await halt(risk); return; }

      if (!task.keyword) { await halt('关键词为空，已停止'); return; }
      if (!task.comments || !task.comments.length) { await halt('评论内容为空，已停止'); return; }

      if (isSearchPage()) {
        await runSearchFlow(task);
      } else if (isDetailPage()) {
        await processQueue();
      } else if (task.keyword) {
        // 非目标页面：回到搜索页重新开始
        location.href = searchUrl(task.keyword);
      }
    } catch (e) {
      await log('run 异常：' + (e && e.message ? e.message : e));
    } finally {
      window.__XHS_RUNNING__ = false;
    }
  }

  // ---------- 可拖动悬浮球（Chrome popup 本身不可拖动，此为页内替代） ----------
  var floatRoot = null;
  var floatBall = null;
  var floatPanel = null;
  var floatStatus = null;
  var floatProg = null;
  var floatStartBtn = null;
  var floatStopBtn = null;

  function getFloatPos() {
    return storageGet([FLOAT_POS_KEY]).then(function (d) {
      var p = d[FLOAT_POS_KEY] || null;
      if (p && typeof p.left === 'number' && typeof p.top === 'number') return p;
      return null;
    });
  }

  function saveFloatPos(left, top) {
    var o = {}; o[FLOAT_POS_KEY] = { left: left, top: top };
    return storageSet(o);
  }

  function refreshFloatUI() {
    if (!floatRoot) return;
    getTask().then(function (task) {
      var running = !!(task && task.running);
      var done = (task && task.doneCount) || 0;
      var total = (task && task.targetCount) || 0;
      try {
        if (floatBall) {
          floatBall.textContent = running ? '停' : '评';
          floatBall.style.background = running ? '#ff2442' : '#1f9d55';
        }
        if (floatStatus) floatStatus.textContent = running ? '运行中' : '空闲';
        if (floatProg) floatProg.textContent = '进度 ' + done + '/' + total;
        if (floatStartBtn) floatStartBtn.disabled = running;
        if (floatStopBtn) floatStopBtn.disabled = !running;
      } catch (e) { /* noop */ }
    });
    getSentDaily().then(function (s) {
      try {
        var n = Object.keys((s && s.ids) || {}).length;
        var el = floatRoot && floatRoot.querySelector('[data-xhs-sent]');
        if (el) el.textContent = '今日已发 ' + n + '（防重）';
      } catch (e) { /* noop */ }
    }).catch(function () { /* noop */ });
  }

  function createFloatBall() {
    if (floatRoot || !document.body) return;
    try {
      var root = document.createElement('div');
      root.id = '__xhs_float_root__';
      root.setAttribute('data-xhs-float', '1');
      root.style.cssText = 'position:fixed;z-index:2147483647;left:auto;top:200px;right:16px;font-family:inherit;user-select:none;';

      var ball = document.createElement('div');
      ball.id = '__xhs_float_ball__';
      ball.title = '拖动移动，点击展开/收起';
      ball.style.cssText = 'width:44px;height:44px;border-radius:50%;background:#1f9d55;color:#fff;font-size:15px;display:flex;align-items:center;justify-content:center;cursor:move;box-shadow:0 2px 10px rgba(0,0,0,.25);';
      ball.textContent = '评';

      var panel = document.createElement('div');
      panel.id = '__xhs_float_panel__';
      panel.style.cssText = 'display:none;margin-top:8px;width:190px;background:#fff;border:1px solid #e3e5e8;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:8px;font-size:12px;color:#1f1f1f;';

      var title = document.createElement('div');
      title.textContent = '小红书自动评论';
      title.style.cssText = 'font-weight:600;margin-bottom:4px;cursor:move;';
      title.setAttribute('data-xhs-drag', '1');

      var status = document.createElement('div');
      status.textContent = '空闲';
      status.style.cssText = 'color:#8a8f99;margin-bottom:2px;';

      var prog = document.createElement('div');
      prog.textContent = '进度 0/0';
      prog.style.cssText = 'margin-bottom:2px;';

      var sent = document.createElement('div');
      sent.setAttribute('data-xhs-sent', '1');
      sent.textContent = '今日已发 0（防重）';
      sent.style.cssText = 'color:#8a8f99;margin-bottom:6px;';

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;';

      var startBtn = document.createElement('button');
      startBtn.textContent = '开始';
      startBtn.style.cssText = 'flex:1;padding:5px 0;border:none;border-radius:6px;background:#ff2442;color:#fff;cursor:pointer;';
      startBtn.onclick = function () { startTask({}); setTimeout(refreshFloatUI, 500); };

      var stopBtn = document.createElement('button');
      stopBtn.textContent = '停止';
      stopBtn.style.cssText = 'flex:1;padding:5px 0;border:none;border-radius:6px;background:#6b7280;color:#fff;cursor:pointer;';
      stopBtn.onclick = function () { stopTask(); setTimeout(refreshFloatUI, 500); };

      row.appendChild(startBtn);
      row.appendChild(stopBtn);
      panel.appendChild(title);
      panel.appendChild(status);
      panel.appendChild(prog);
      panel.appendChild(sent);
      panel.appendChild(row);
      root.appendChild(ball);
      root.appendChild(panel);
      document.body.appendChild(root);

      floatRoot = root;
      floatBall = ball;
      floatPanel = panel;
      floatStatus = status;
      floatProg = prog;
      floatStartBtn = startBtn;
      floatStopBtn = stopBtn;

      // 恢复上次位置
      getFloatPos().then(function (p) {
        if (!p || !floatRoot) return;
        try {
          var maxL = Math.max(0, window.innerWidth - 70);
          var maxT = Math.max(0, window.innerHeight - 70);
          var l = Math.min(Math.max(0, p.left), maxL);
          var t = Math.min(Math.max(0, p.top), maxT);
          floatRoot.style.left = l + 'px';
          floatRoot.style.top = t + 'px';
          floatRoot.style.right = 'auto';
        } catch (e) { /* noop */ }
      });

      // 拖动：按住球或标题移动；移动<5px 视为点击（展开/收起）
      (function bindDrag(handle) {
        var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = 0;
        function onDown(e) {
          var pt = (e.touches && e.touches[0]) || e;
          dragging = true; moved = 0;
          sx = pt.clientX; sy = pt.clientY;
          var r = floatRoot.getBoundingClientRect();
          ox = r.left; oy = r.top;
          e.preventDefault();
        }
        function onMove(e) {
          if (!dragging) return;
          var pt = (e.touches && e.touches[0]) || e;
          var dx = pt.clientX - sx, dy = pt.clientY - sy;
          moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
          var nl = Math.min(Math.max(0, ox + dx), Math.max(0, window.innerWidth - 70));
          var nt = Math.min(Math.max(0, oy + dy), Math.max(0, window.innerHeight - 70));
          floatRoot.style.left = nl + 'px';
          floatRoot.style.top = nt + 'px';
          floatRoot.style.right = 'auto';
        }
        function onUp() {
          if (!dragging) return;
          dragging = false;
          try {
            var r = floatRoot.getBoundingClientRect();
            saveFloatPos(Math.round(r.left), Math.round(r.top));
          } catch (e) { /* noop */ }
          if (moved < 5) {
            try { floatPanel.style.display = (floatPanel.style.display === 'none') ? 'block' : 'none'; } catch (e) { /* noop */ }
          }
        }
        try {
          handle.addEventListener('mousedown', onDown);
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          handle.addEventListener('touchstart', onDown, { passive: false });
          document.addEventListener('touchmove', onMove, { passive: false });
          document.addEventListener('touchend', onUp);
        } catch (e) { /* noop */ }
      })(ball);
      (function bindTitleDrag(handle) {
        var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        function onDown(e) {
          dragging = true;
          sx = e.clientX; sy = e.clientY;
          var r = floatRoot.getBoundingClientRect();
          ox = r.left; oy = r.top;
          e.preventDefault();
        }
        function onMove(e) {
          if (!dragging) return;
          var nl = Math.min(Math.max(0, ox + e.clientX - sx), Math.max(0, window.innerWidth - 70));
          var nt = Math.min(Math.max(0, oy + e.clientY - sy), Math.max(0, window.innerHeight - 70));
          floatRoot.style.left = nl + 'px';
          floatRoot.style.top = nt + 'px';
          floatRoot.style.right = 'auto';
        }
        function onUp() {
          if (!dragging) return;
          dragging = false;
          try {
            var r = floatRoot.getBoundingClientRect();
            saveFloatPos(Math.round(r.left), Math.round(r.top));
          } catch (e) { /* noop */ }
        }
        try {
          handle.addEventListener('mousedown', onDown);
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        } catch (e) { /* noop */ }
      })(title);

      // 任务变化时刷新悬浮球（含日志写入触发的 storage 变更）
      try {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'local') return;
          if (changes[TASK_KEY] || changes[SENT_KEY]) refreshFloatUI();
        });
      } catch (e) { /* noop */ }
      try { setInterval(refreshFloatUI, 2000); } catch (e) { /* noop */ }
      refreshFloatUI();
    } catch (e) { /* 悬浮球创建失败不阻塞主流程 */ }
  }

  // ---------- 任务控制 ----------
  async function startTask(partial) {
    // 以存储中的任务为基准合并，避免 popup 先写存储、消息无 payload 时清空关键词/评论
    var current = await getTask();
    var incoming = (partial && typeof partial === 'object') ? partial : {};
    var task = Object.assign(defaults(), current, incoming, {
      running: true,
      queue: [],
      currentIndex: 0,
      doneCount: 0,
      refillCount: 0,
      failStreak: 0
    });
    if (task.minDelay == null) task.minDelay = 0;
    if (task.maxDelay == null) task.maxDelay = 10;
    if (task.minDelay < 0) task.minDelay = 0;
    if (task.maxDelay < 0) task.maxDelay = 0;
    if (task.maxDelay < task.minDelay) task.maxDelay = task.minDelay;
    if (!task.targetCount) task.targetCount = 5;
    if (!Array.isArray(task.comments)) task.comments = [];

    if (!task.keyword || !task.comments.length) {
      await log('启动失败：关键词或评论内容为空');
      await setTask({ running: false });
      return;
    }

    var o = {}; o[TASK_KEY] = task;
    await storageSet(o);
    await log('任务开始，关键词：' + task.keyword + '（间隔 ' + task.minDelay + '~' + task.maxDelay + 's/条）');
    run();
  }

  async function stopTask() {
    await setTask({ running: false });
    await log('任务已手动停止');
  }

  // ---------- 监听器 ----------
  function setupListeners() {
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        var type = msg && msg.type;
        if (type === 'XHS_AUTO_START' || type === 'XHS_START' || type === 'start' || type === 'START') {
          startTask(msg.task || msg.payload || {});
          try { sendResponse({ ok: true }); } catch (e) { /* noop */ }
        } else if (type === 'XHS_AUTO_STOP' || type === 'XHS_STOP' || type === 'stop' || type === 'STOP') {
          stopTask();
          try { sendResponse({ ok: true }); } catch (e) { /* noop */ }
        } else if (type === 'ping') {
          try { sendResponse({ ok: true, alive: true }); } catch (e) { /* noop */ }
        }
        return true;
      });
    } catch (e) { /* noop */ }

    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[TASK_KEY]) return;
        var nv = changes[TASK_KEY].newValue || {};
        if (nv.running) run();
      });
    } catch (e) { /* noop */ }
  }

  // ---------- 启动 ----------
  (async function boot() {
    setupListeners();
    try { console.info('[xhs-auto] content.js v20260914-eff1 已注入'); } catch (e) { /* noop */ }
    try { window.__XHS_CONTENT_VER = 'v20260914-eff1'; } catch (e) { /* noop */ }
    await domReady();
    try { createFloatBall(); } catch (e) { /* noop */ }
    // 首屏多等一下，让小红书 SPA 渲染评论区
    await sleep(800);
    var task = await getTask();
    if (task.running) run();
  })();
})();
