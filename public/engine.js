/* Classroom Assessment Engine v6.5 (demo edition)
   One universal test runner. Each test ships only a data file (window.TEST_DATA); the answer key never
   reaches the browser. The page sends answers to the receiver (Google Apps Script), which scores them.

   Features by version:
   v5    images in questions and options, 4+ options, result by topic
   v5.1  optional D.topicsTitle and D.topicsCol
   v5.2  points by difficulty level when questions carry lvl / pts
   v6    task types 'match' (matching) and 'number' (whole number), time from the timer, points from the server
   v6.2  task type 'fill' (several gaps per task: digits or a list of values), line breaks in question text
   v6.3  emergency pause button: questions hidden, timer stopped, resume only with the class code
   v6.4  a question with no server score is not counted as correct
   v6.5  fullscreen mode; every exit is logged with type, duration and question and sent at once;
         "You left the test" screen; the test locks on every 5th exit until the teacher's unlock code;
         a repeated start after a lost server reply reuses the same session token
   v6.5-demo  "Guest" sign-in for the public demo (unlimited attempts, never in class statistics); when the receiver
         is in guest mode, the guest code is shown on the sign-in and pause screens and the unlock code on the lock screen
   v6.6-demo  optional data fields for non-school use: D.learnerLabel, D.contactLabel, D.groupLabel (interface words),
         D.intro (text on the sign-in screen), D.keepOrder (questions in data-file order), D.feedback (a short note under
         each skill status); question images open full screen on click or tap. Without these fields nothing changes.

   Configuration (optional, set before this script):
   window.APP_CONFIG = {
     api: 'https://script.google.com/macros/s/.../exec',  // receiver URL (Apps Script web app)
     brand: 'Classroom Assessment',                       // text shown in the header
     logo: '',                                            // optional logo image URL (replaces the text)
     footer: 'Classroom Assessment Engine, 2026'
   };
*/
(function () {
  'use strict';

  var ENGINE_VER = '6.6';
  var C = window.APP_CONFIG || {};
  var CFG = {
    api: C.api || '',
    brand: C.brand || 'Classroom Assessment',
    logo: C.logo || '',
    footer: C.footer || 'Classroom Assessment Engine, 2026',
    teacherId: 'TEACHER',
    trialIds: ['TEACHER', 'ADMIN', 'GUEST'] // no session on the server: teacher trial, administrator check, guest
  };
  var D = window.TEST_DATA;
  var app = document.getElementById('app');
  var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  var params = new URLSearchParams(location.search);

  var S = null;          // test state (kept in localStorage)
  var tickHandle = null;
  var inTest = false;

  document.title = D.title + ' | ' + CFG.brand;

  /* Interface words. Defaults are the school wording; an adult test sets them in the data file, e.g.
     learnerLabel: 'Participant', contactLabel: 'your facilitator', groupLabel: 'group'. */
  var L = {
    learner: D.learnerLabel || 'Student',
    contact: D.contactLabel || 'your teacher',
    group: D.groupLabel || 'class',
    school: !D.learnerLabel
  };
  L.learnerLow = L.learner.toLowerCase();
  L.groupCap = L.group.charAt(0).toUpperCase() + L.group.slice(1);
  L.contactPoss = L.contact + '\u2019s';

  /* Primary school (grades 1-4): set D.primary in the data file, otherwise the first digit of the bank ID decides. */
  var PRIMARY = (typeof D.primary === 'boolean') ? D.primary
    : (function () { var m = String(D.bank || '').match(/\d/); return m ? Number(m[0]) <= 4 : false; })();

  /* ---------- utilities ---------- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (kids || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  var memState = {}; // fallback when localStorage is unavailable
  function stKey(t, s) { return 'cae:s:' + t + ':' + s; }
  function save() {
    if (!S) return;
    memState[stKey(S.testId, S.studentId)] = S;
    lsSet(stKey(S.testId, S.studentId), S);
    lsSet('cae:active', { testId: S.testId, studentId: S.studentId });
  }
  function randToken() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function shuffle(arr) {
    var a = arr.slice(), buf = new Uint32Array(a.length);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = a.length - 1; i > 0; i--) {
      var j = buf[i] % (i + 1), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function apiGet(p) {
    return fetch(CFG.api + '?' + new URLSearchParams(p)).then(function (r) { return r.json(); });
  }
  function apiPost(obj) {
    return fetch(CFG.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(obj) })
      .then(function (r) { return r.json(); });
  }
  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec));
    return ('0' + Math.floor(sec / 60)).slice(-2) + ':' + ('0' + (sec % 60)).slice(-2);
  }
  function errText(code) {
    if (/^closed/.test(code || '')) return 'This test is closed right now. Please ask ' + L.contact + '.';
    var m = {
      'bad code': 'That code did not work. Check it and try again, or ask ' + L.contact + '.',
      'used': 'This code has already been used. Please ask ' + L.contact + '.',
      'already': 'This ' + L.learnerLow + ' has already taken the test.',
      'unknown student': L.learner + ' not found in the list. Please ask ' + L.contact + '.',
      'wrong class': L.learner + ' not found in this ' + L.group + ' list.',
      'unknown test': 'Test not found.',
      'not started': 'The test has not been started with this code.',
      'bad payload': 'Request error. Please try again.',
      'no unlock code': 'No unlock code has been set for this test yet. Please ask the administrator.',
      'busy': 'The server is busy. Try again in a few seconds.'
    };
    return m[code] || 'Something went wrong. Try again or ask ' + L.contact + '.';
  }

  /* label of the code field for each sign-in */
  function codeName(sid, studentDefault) {
    if (sid === 'ADMIN') return 'Check code';
    if (sid === 'GUEST') return 'Guest code';
    if (sid === CFG.teacherId) return 'Teacher code';
    return studentDefault;
  }
  /* public demo hint (the receiver sends it only in guest mode) */
  function hint(text) { return h('div', { class: 'info', text: text }); }

  /* ---------- page frame ---------- */
  function shell(content, opts) {
    opts = opts || {};
    stopTick();
    mode = 'other';
    var zoom = document.querySelector('.imgzoom'); if (zoom) zoom.remove(); // an open picture never covers a new screen
    app.innerHTML = '';
    var top = h('div', { class: 'top' }, [
      h('div', { class: 'brand' }, [CFG.logo ? h('img', { src: CFG.logo, alt: CFG.brand }) : CFG.brand]),
      h('div', { class: 'meta', text: opts.meta || D.title }),
      opts.timer ? h('div', { style: 'display:flex;align-items:center' }, [
        h('div', { class: 'timer', id: 'timer', text: '--:--' }),
        h('button', { class: 'alarm', type: 'button', text: 'Pause', title: 'Emergency: pause the test', onclick: pauseTest })])
        : h('span')
    ]);
    app.appendChild(top);
    var main = h('main', null, [content]);
    app.appendChild(main);
    app.appendChild(h('div', { class: 'foot', text: CFG.footer }));
  }

  /* ---------- class, student, code ---------- */
  var chosen = { testId: null, roster: null };

  function startScreen() {
    inTest = false;
    var box = h('div', { class: 'card' }, [h('h1', { text: D.title }), h('p', { class: 'muted', text: 'Loading...' })]);
    shell(box);
    var direct = params.get('t');
    if (direct) return loadRoster(direct);
    apiGet({ action: 'runs', bank: D.bank }).then(function (r) {
      if (!r.ok || !r.runs.length) {
        shell(h('div', { class: 'card' }, [h('h1', { text: D.title }),
          h('div', { class: 'info', text: 'There are no open tests right now. Please ask ' + L.contact + '.' })]));
        return;
      }
      if (r.runs.length === 1) return loadRoster(r.runs[0].testId);
      var btns = r.runs.map(function (x) {
        return h('button', { class: 'btn', text: x.className, onclick: function () { loadRoster(x.testId); } });
      });
      shell(h('div', { class: 'card' }, [h('h1', { text: D.title }),
        h('p', { class: 'muted', text: 'Choose your ' + L.group }), h('div', { class: 'choices' }, btns)]));
    }).catch(function () { netError(startScreen); });
  }

  function netError(retry) {
    shell(h('div', { class: 'card' }, [h('h1', { text: 'No connection' }),
      h('p', { text: 'Check your internet connection and try again.' }),
      h('button', { class: 'btn', text: 'Try again', onclick: retry })]));
  }

  function loadRoster(testId) {
    apiGet({ action: 'roster', test: testId }).then(function (r) {
      if (!r.ok) {
        shell(h('div', { class: 'card' }, [h('h1', { text: D.title }), h('div', { class: 'err', text: errText(r.error) })]));
        return;
      }
      chosen.testId = testId; chosen.roster = r;
      loginScreen(r);
    }).catch(function () { netError(function () { loadRoster(testId); }); });
  }

  function loginScreen(r) {
    var dur = r.durationMin || 40;
    var sel = h('select', { id: 'stu' }, [h('option', { value: '', text: L.school ? 'Find your name in the list' : 'Choose from the list' })]
      .concat(r.students.map(function (s) { return h('option', { value: s.id, text: s.name }); })));
    var codeLabel = h('label', { for: 'code', text: 'Access code' });
    var code = h('input', { id: 'code', class: 'code', type: 'tel', inputmode: 'numeric', autocomplete: 'off', maxlength: '12' });
    var err = h('div');
    var go = h('button', { class: 'btn', text: 'Start test' });
    sel.addEventListener('change', function () {
      codeLabel.textContent = codeName(sel.value, 'Access code');
    });
    go.addEventListener('click', function () {
      err.className = ''; err.textContent = '';
      var sid = sel.value, cv = code.value.trim();
      if (!sid) { err.className = 'err'; err.textContent = L.school ? 'Choose your name from the list.' : 'Choose a sign-in from the list.'; return; }
      if (!cv) { err.className = 'err'; err.textContent = 'Enter the access code.'; return; }
      goFull(); // fullscreen can only be requested from a click
      go.disabled = true; go.textContent = 'Checking...';
      /* If the start reached the server but the reply was lost (slow internet), a second click on this device
         reuses the same token, so the server lets the student back into the same session. */
      var pendKey = 'cae:pend:' + chosen.testId + ':' + sid;
      var token = lsGet(pendKey) || randToken();
      lsSet(pendKey, token);
      apiPost({ action: 'start', testId: chosen.testId, studentId: sid, code: cv, token: token, engine: ENGINE_VER }).then(function (res) {
        go.disabled = false; go.textContent = 'Start test';
        if (!res.ok) { leaveFull(); err.className = 'err'; err.textContent = errText(res.error); return; }
        var stu = r.students.filter(function (s) { return s.id === sid; })[0];
        lsDel(pendKey);
        initState(res, stu, cv, token);
      }, function () { // network errors only; an error inside the test must not drop fullscreen
        leaveFull();
        go.disabled = false; go.textContent = 'Start test';
        err.className = 'err'; err.textContent = 'No connection. Please try again.';
      });
    });
    shell(h('div', { class: 'card' }, [
      h('h1', { text: D.title }),
      h('p', { class: 'muted', text: r.className + (r.subject ? ', ' + r.subject : '') }),
      introBlock(),
      h('div', { class: 'rules' }, [h('strong', { text: 'Before you start' }), h('ul', null, [
        h('li', { text: 'You have ' + dur + ' minutes. The time keeps running even if you reload the page.' }),
        h('li', { text: 'You will not see whether your answers are right during the test.' }),
        h('li', { text: 'Once you press "Confirm answer", you cannot change it.' }),
        h('li', { text: 'The test opens in full screen. Stay in it: the Esc key, other tabs, windows, apps and notifications are logged as exits.' }),
        h('li', { text: 'On every ' + EXIT_BLOCK + 'th exit the test locks, and you can only continue with a code from ' + L.contact + '.' }),
        h('li', { text: 'Emergency or alarm: press "Pause" at the top of the page straight away. The time will stop.' })])]),
      r.demo && r.demo.guestCode ? hint('Demo access: choose "Guest" in the list and enter the code ' + r.demo.guestCode + '.') : null,
      h('label', { for: 'stu', text: L.learner }), sel, codeLabel, code, err,
      h('div', { class: 'row', style: 'margin-top:20px' }, [go])
    ]));
  }

  /* Optional text on the sign-in screen (D.intro): a string or a list of paragraphs; line breaks are kept. */
  function introBlock() {
    if (!D.intro) return null;
    var parts = Array.isArray(D.intro) ? D.intro : [D.intro];
    return h('div', { class: 'intro' }, parts.map(function (t) { return h('p', { text: t }); }));
  }

  /* ---------- set up and restore ---------- */
  function initState(res, stu, code, token) {
    if (res.done) { S = { testId: chosen.testId, studentId: stu.id, studentName: stu.name, token: token, result: res.result }; save(); return resultScreen(); }
    var ids = D.questions.map(function (q) { return q.id; });
    var opts = {};
    D.questions.forEach(function (q) {
      if (q.type === 'match') opts[q.id] = shuffle(q.right.map(function (o) { return o.k; }));
      else if (q.type === 'number' || q.type === 'fill') opts[q.id] = [];
      else opts[q.id] = shuffle(q.options.map(function (o) { return o.k; }));
    });
    S = {
      testId: chosen.testId, studentId: stu.id, studentName: stu.name, code: code, token: token,
      className: res.className, subject: res.subject, durationSec: res.durationSec,
      startedAt: res.startedAt, offset: res.serverNow - Date.now(),
      order: D.keepOrder ? ids : shuffle(ids), // D.keepOrder: questions in data-file order, options still shuffled
      opts: opts, answers: {}, confirmed: {}, exits: 0, cur: 0,
      exitLog: [], away: null, blocked: null, unlocks: 0,
      finishing: false, result: null,
      demo: (chosen.roster && chosen.roster.demo) || null // public demo codes, kept for the pause and lock screens
    };
    save();
    if (fsFailed) markFsNA();
    graceUntil = document.fullscreenElement ? 0 : Date.now() + 3000; // while the browser switches to fullscreen
    testScreen();
  }

  function resume() {
    var act = lsGet('cae:active');
    if (!act) return false;
    var st = lsGet(stKey(act.testId, act.studentId)) || memState[stKey(act.testId, act.studentId)];
    if (!st) return false;
    S = st;
    if (S.result) { resultScreen(); return true; }
    shell(h('div', { class: 'card' }, [h('h1', { text: D.title }), h('p', { class: 'muted', text: 'Restoring your test...' })]));
    /* Reloading or closing the page counts as an exit (except during a pause). If the page managed to log the exit on close, it is already open. */
    if (!S.paused && !S.finishing && !S.away) openExit(null, true, S.lastSeen || Date.now());
    save();
    sendExits();
    if (S.finishing) { submit(); return true; }
    if (S.paused) { pauseScreen(); return true; } // the pause continues; only the teacher or facilitator can resume
    apiPost({ action: 'start', testId: S.testId, studentId: S.studentId, code: S.code, token: S.token, engine: ENGINE_VER }).then(function (res) {
      if (!res.ok) {
        shell(h('div', { class: 'card' }, [h('h1', { text: D.title }), h('div', { class: 'err', text: errText(res.error) }),
          h('div', { class: 'row', style: 'margin-top:16px' }, [h('button', { class: 'btn ghost', text: 'Back to start', onclick: resetDevice })])]));
        return;
      }
      if (res.done) { S.result = res.result; S.away = null; save(); return resultScreen(); }
      if (CFG.trialIds.indexOf(S.studentId) < 0) {
        S.startedAt = res.startedAt;
        if (res.pausedMs != null) S.pausedMs = res.pausedMs;
      }
      S.offset = res.serverNow - Date.now();
      if (res.pauseFrom && !S.paused) { S.paused = { at: res.pauseFrom, synced: true }; closeExit(); save(); return pauseScreen(); }
      save();
      showAway();
    }).catch(function () {
      showAway(); // no connection: continue with the saved time
    });
    return true;
  }

  function resetDevice() { lsDel('cae:active'); S = null; startScreen(); }

  /* ---------- test screen ---------- */
  function remaining() {
    var now = Date.now() + S.offset;
    var paused = (S.pausedMs || 0) + (S.paused ? Math.max(0, now - S.paused.at) : 0); // pauses do not count
    return S.durationSec - (now - S.startedAt - paused) / 1000;
  }

  /* ---------- emergency pause ----------
     One click: questions are hidden, the timer stops, the server records the pause.
     Only the teacher can resume, by entering the same code (the class code; trial sign-ins use their own code). */
  function pauseTest() {
    if (!S || S.paused || S.finishing || S.result) return;
    inTest = false;
    closeExit(); // an exit in progress is closed; a lock (if any) stays
    S.paused = { at: Date.now() + S.offset, synced: false };
    save();
    Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) { m.remove(); });
    pauseScreen();
    apiPost({ action: 'pause', testId: S.testId, studentId: S.studentId, token: S.token, pausedAt: S.paused.at })
      .then(function (res) { if (res.ok && S && S.paused) { S.paused.synced = true; save(); } })
      .catch(function () { /* no connection: the pause start is sent with the resume */ });
  }

  function pauseScreen() {
    inTest = false;
    var clock = h('div', { class: 'ptime', text: '00:00' });
    var code = h('input', { class: 'code', type: 'tel', inputmode: 'numeric', autocomplete: 'off', maxlength: '12', 'aria-label': 'Code to continue' });
    var err = h('div');
    var go = h('button', { class: 'btn', text: 'Continue test' });
    function run() {
      err.className = ''; err.textContent = '';
      var cv = code.value.trim();
      if (!cv) { err.className = 'err'; err.textContent = 'A code from ' + L.contact + ' is needed.'; return; }
      go.disabled = true; go.textContent = 'Checking...';
      apiPost({ action: 'resume', testId: S.testId, studentId: S.studentId, code: cv, token: S.token, pausedAt: S.paused.at })
        .then(function (res) {
          go.disabled = false; go.textContent = 'Continue test';
          if (!res.ok) { err.className = 'err'; err.textContent = errText(res.error); return; }
          var now = res.serverNow || (Date.now() + S.offset);
          if (res.trial || res.pausedMs == null) S.pausedMs = (S.pausedMs || 0) + Math.max(0, now - S.paused.at);
          else { S.pausedMs = res.pausedMs; if (res.startedAt) S.startedAt = res.startedAt; }
          if (res.serverNow) S.offset = res.serverNow - Date.now();
          S.pauses = (S.pauses || 0) + 1;
          S.paused = null;
          save();
          if (S.blocked) blockScreen(); else exitScreen('resume'); // fullscreen returns on a button click
        })
        .catch(function () {
          go.disabled = false; go.textContent = 'Continue test';
          err.className = 'err'; err.textContent = 'No connection. Check your internet and try again.';
        });
    }
    go.addEventListener('click', run);
    code.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
    shell(h('div', { class: 'card pausebox' }, [
      h('h1', { text: 'Test paused' }),
      h('p', { text: 'Emergency pause. The questions are hidden and the timer has stopped. Follow ' + L.contactPoss + ' instructions.' }),
      h('p', { class: 'muted', text: 'Paused for' }),
      clock,
      h('p', { class: 'muted', text: 'When it is safe, ' + L.contact + ' will enter the ' + L.group + ' code and you will continue from the same place. Your answers are saved.' }),
      S.demo && S.demo.guestCode && S.studentId === 'GUEST' ? hint('Demo: continue with the guest code ' + S.demo.guestCode + '.') : null,
      h('label', { text: codeName(S.studentId, L.groupCap + ' code') }), code, err,
      h('div', { class: 'row', style: 'justify-content:center;margin-top:16px' }, [go])
    ]), { meta: S.className + ', ' + S.subject });
    function tick() {
      if (!S || !S.paused) return;
      clock.textContent = mmss((Date.now() + S.offset - S.paused.at) / 1000);
    }
    tick();
    tickHandle = setInterval(tick, 1000);
  }
  function stopTick() { if (tickHandle) { clearInterval(tickHandle); tickHandle = null; } }

  function testScreen() {
    inTest = true;
    var qid = S.order[S.cur];
    var q = D.questions.filter(function (x) { return x.id === qid; })[0];
    var locked = !!S.confirmed[qid];
    var picked = S.answers[qid];

    var nav = h('div', { class: 'nav' }, S.order.map(function (id, i) {
      var cls = (i === S.cur ? 'cur ' : '') + (S.confirmed[id] ? 'done' : (hasAny(S.answers[id]) ? 'ans' : ''));
      return h('button', { class: cls, text: String(i + 1), 'aria-label': 'Question ' + (i + 1),
        onclick: function () { goTo(i); } });
    }));

    var confirmBtn = h('button', { class: 'btn sky', text: 'Confirm answer', disabled: locked || !isAnswered(q, picked) });
    confirmBtn.addEventListener('click', function () { S.confirmed[qid] = true; save(); testScreen(); });

    var body;
    if (q.type === 'match') body = matchBody(q, qid, picked, locked);
    else if (q.type === 'number') body = numberBody(q, qid, picked, locked, confirmBtn);
    else if (q.type === 'fill') body = fillBody(q, qid, picked, locked, confirmBtn);
    else body = choiceBody(q, qid, picked, locked);

    var last = S.cur === S.order.length - 1;
    var actions = h('div', { class: 'actions' }, [
      h('div', { class: 'grp' }, [
        h('button', { class: 'btn ghost', text: 'Back', disabled: S.cur === 0, onclick: function () { goTo(S.cur - 1); } }),
        h('button', { class: 'btn ghost', text: 'Next', disabled: last, onclick: function () { goTo(S.cur + 1); } })]),
      h('div', { class: 'grp' }, [confirmBtn,
        allConfirmed() ? h('button', { class: 'btn', text: 'Finish test', onclick: askFinish }) : null])
    ]);

    shell(h('div', { class: 'card' }, [
      nav,
      h('div', { class: 'qnum', text: 'Question ' + (S.cur + 1) + ' of ' + S.order.length }),
      q.text ? h('div', { class: 'qtext', text: q.text }) : null,
      q.img ? qImage(q) : null,
      body,
      locked ? h('p', { class: 'lockmsg', text: 'Answer confirmed.' }) : null,
      h('p', { class: 'lockmsg', text: allConfirmed() ? 'All answers are confirmed. You can finish the test now.' : 'Confirmed ' + confirmedCount() + ' of ' + S.order.length + '. You can finish the test once every answer is confirmed.' }),
      actions
    ]), { timer: true, meta: S.className + ', ' + S.subject });
    mode = 'test';
    startTick();
  }

  function confirmedCount() { return S.order.filter(function (id) { return S.confirmed[id]; }).length; }
  function allConfirmed() { return confirmedCount() === S.order.length; }

  /* ---------- task types ---------- */
  function qById(id) { return D.questions.filter(function (x) { return x.id === id; })[0]; }
  function hasAny(a) {
    if (a == null || a === '') return false;
    if (typeof a === 'object') { for (var k in a) if (a[k]) return true; return false; }
    return true;
  }
  /* Gaps in a 'fill' task are marked with □ in q.items; gap keys run 1, 2, 3... across all items */
  var BLANK = '□';
  function fillKeys(q) {
    var n = 0;
    (q.items || []).forEach(function (t) { n += String(t).split(BLANK).length - 1; });
    var ks = []; for (var i = 1; i <= n; i++) ks.push(String(i));
    return ks;
  }
  function isAnswered(q, a) {
    if (q.type === 'match') return !!a && q.left.every(function (l) { return !!a[l.k]; });
    if (q.type === 'fill') return !!a && fillKeys(q).every(function (k) { return !!a[k]; });
    return hasAny(a);
  }
  /* Answer string for the server: choice = option key, number = digits, matching = 1-C;2-A;3-D (keys from the data file),
     gaps = 1-5;2-4;3-6 (scored on the server like matching) */
  function ansStr(q, a) {
    if (!q || !hasAny(a)) return '';
    if (q.type === 'match') return q.left.map(function (l) { return l.k + '-' + (a[l.k] || ''); }).join(';');
    if (q.type === 'fill') return fillKeys(q).map(function (k) { return k + '-' + (a[k] || ''); }).join(';');
    return String(a);
  }

  function choiceBody(q, qid, picked, locked) {
    var hasOptImg = q.options.some(function (x) { return !!x.img; });
    var optEls = S.opts[qid].map(function (k, i) {
      var o = q.options.filter(function (x) { return x.k === k; })[0];
      var el = h('button', { class: 'opt' + (picked === k ? ' sel' : '') + (locked ? ' locked' : ''), type: 'button' }, [
        h('span', { class: 'l', text: LETTERS[i] }),
        o.img ? h('img', { class: 'oimg', src: o.img, alt: o.alt || o.t || ('Option ' + LETTERS[i]), draggable: 'false' }) : null,
        o.t ? h('span', { text: o.t }) : null]);
      if (!locked) el.addEventListener('click', function () { S.answers[qid] = k; save(); testScreen(); });
      return el;
    });
    return h('div', { class: 'opts' + (hasOptImg ? ' grid' : '') }, optEls);
  }

  /* Matching: items 1, 2, 3 on the left (order from the data file), options A, B, C on the right (shuffled).
     Each item has a letter list; a letter already used for another item is disabled. */
  function matchBody(q, qid, picked, locked) {
    var a = picked || {};
    var order = S.opts[qid];
    var letterOf = {}; order.forEach(function (k, i) { letterOf[k] = LETTERS[i]; });
    var used = {}; for (var lk in a) if (a[lk]) used[a[lk]] = lk;
    var leftEls = q.left.map(function (l, i) {
      var sel = h('select', { 'aria-label': 'Answer for item ' + (i + 1), disabled: locked },
        [h('option', { value: '', text: '...' })].concat(order.map(function (k) {
          return h('option', { value: k, text: letterOf[k], selected: a[l.k] === k, disabled: !!used[k] && used[k] !== l.k });
        })));
      sel.addEventListener('change', function () {
        var cur = S.answers[qid] || {};
        cur[l.k] = sel.value;
        S.answers[qid] = cur; save(); testScreen();
      });
      return h('div', { class: 'mrow' + (a[l.k] ? ' set' : '') }, [
        h('span', { class: 'l', text: String(i + 1) }),
        h('span', { class: 'mt' }, [l.img ? h('img', { src: l.img, alt: l.alt || l.t || '', draggable: 'false' }) : null, l.t || null]),
        sel]);
    });
    var rightEls = order.map(function (k) {
      var o = q.right.filter(function (x) { return x.k === k; })[0];
      return h('div', { class: 'mright' }, [
        h('span', { class: 'l', text: letterOf[k] }),
        o.img ? h('img', { src: o.img, alt: o.alt || o.t || '', draggable: 'false' }) : null,
        o.t ? h('span', { text: o.t }) : null]);
    });
    return h('div', { class: 'mwrap' }, [
      h('div', { class: 'mcol' }, [h('h3', { text: q.leftTitle || 'Items' })].concat(leftEls)),
      h('div', { class: 'mcol' }, [h('h3', { text: q.rightTitle || 'Options' })].concat(rightEls))]);
  }

  /* Number: whole numbers, digits only. No re-render on each digit, so focus is kept. */
  function numberBody(q, qid, picked, locked, confirmBtn) {
    var inp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: String(q.maxLen || 9),
      value: picked || '', disabled: locked, 'aria-label': 'Answer as a number' });
    inp.addEventListener('input', function () {
      var v = inp.value.replace(/\D/g, '');
      if (v !== inp.value) inp.value = v;
      S.answers[qid] = v; save();
      confirmBtn.disabled = !v;
    });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && inp.value) confirmBtn.click(); });
    setTimeout(function () { if (!locked && document.body.contains(inp)) inp.focus(); }, 0);
    return h('div', { class: 'numwrap' }, [inp, q.unit ? h('span', { class: 'unit', text: q.unit }) : null]);
  }

  /* Gaps. Each line in q.items may hold one or more □. Without q.choices a gap takes digits from the keyboard;
     with q.choices (e.g. ['<','>','=']) the student picks from a list. Repeated answers are allowed.
     No re-render on each digit, so focus is kept. */
  function fillBody(q, qid, picked, locked, confirmBtn) {
    var a = picked || {};
    var n = 0, inputs = [];
    function store(k, v, row) {
      var cur = S.answers[qid] || {};
      cur[k] = v;
      S.answers[qid] = cur; save();
      confirmBtn.disabled = !isAnswered(q, cur);
      row.className = 'frow' + (rowFilled(row) ? ' set' : '');
    }
    function rowFilled(row) {
      var els = row.querySelectorAll('input,select');
      if (!els.length) return false;
      for (var i = 0; i < els.length; i++) if (!els[i].value) return false;
      return true;
    }
    var rows = (q.items || []).map(function (t) {
      var parts = String(t).split(BLANK);
      var row = h('div', { class: 'frow' });
      parts.forEach(function (p, i) {
        if (p.trim()) row.appendChild(h('span', { text: p.trim() }));
        if (i === parts.length - 1) return;
        n++;
        var k = String(n), el;
        if (q.choices && q.choices.length) {
          el = h('select', { 'aria-label': 'Gap ' + k, disabled: locked },
            [h('option', { value: '', text: '...' })].concat(q.choices.map(function (c) {
              return h('option', { value: c, text: c, selected: a[k] === c });
            })));
          el.addEventListener('change', function () { store(k, el.value, row); });
        } else {
          el = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: String(q.maxLen || 3),
            value: a[k] || '', disabled: locked, 'aria-label': 'Gap ' + k });
          el.addEventListener('input', function () {
            var v = el.value.replace(/\D/g, '');
            if (v !== el.value) el.value = v;
            store(k, v, row);
          });
          el.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            var idx = inputs.indexOf(el);
            if (idx >= 0 && idx < inputs.length - 1) inputs[idx + 1].focus();
            else if (!confirmBtn.disabled) confirmBtn.click();
          });
          inputs.push(el);
        }
        row.appendChild(el);
      });
      if (rowFilled(row)) row.className = 'frow set';
      return row;
    });
    if (!locked) setTimeout(function () {
      var first = inputs.filter(function (x) { return !x.value; })[0];
      if (first && document.body.contains(first)) first.focus();
    }, 0);
    return h('div', { class: 'fwrap' }, rows);
  }

  /* Moving to another question: if an answer is picked but not confirmed, show a reminder */
  function goTo(i) {
    if (i < 0 || i >= S.order.length || i === S.cur) return;
    var qid = S.order[S.cur];
    if (hasAny(S.answers[qid]) && !S.confirmed[qid]) {
      var m = h('div', { class: 'modal' }, [h('div', { class: 'card' }, [
        h('h2', { text: 'Answer not confirmed' }),
        h('p', { text: 'You picked an answer to this question but did not press "Confirm answer". You cannot finish the test without confirming it.' }),
        h('div', { class: 'row end' }, [
          h('button', { class: 'btn ghost', text: 'Go without confirming', onclick: function () { m.remove(); S.cur = i; save(); testScreen(); } }),
          h('button', { class: 'btn sky', text: 'Confirm and go', onclick: function () { m.remove(); S.confirmed[qid] = true; S.cur = i; save(); testScreen(); } })])])]);
      document.body.appendChild(m);
      return;
    }
    S.cur = i; save(); testScreen();
  }

  function startTick() {
    var el = document.getElementById('timer');
    function tick() {
      var r = remaining();
      var t = document.getElementById('timer');
      if (t) { t.textContent = mmss(r); t.className = 'timer' + (r <= 300 ? ' warn' : ''); }
      if (r <= 0) { stopTick(); finish(true); }
    }
    tick();
    if (el) tickHandle = setInterval(tick, 500);
  }

  function askFinish() {
    var m = h('div', { class: 'modal' }, [h('div', { class: 'card' }, [
      h('h2', { text: 'Finish the test?' }),
      h('p', { text: 'All answers are confirmed. Once you finish, you cannot go back to the test.' }),
      h('div', { class: 'row end' }, [
        h('button', { class: 'btn ghost', text: 'Let me check again', onclick: function () { m.remove(); } }),
        h('button', { class: 'btn warn', text: 'Yes, finish', onclick: function () { m.remove(); finish(false); } })])])]);
    document.body.appendChild(m);
  }

  function finish() {
    if (S.finishing) return;
    inTest = false;
    closeExit(); // if time ran out on the exit or lock screen, the exit is closed and sent with the submission
    S.finishing = true;
    /* time taken from the timer, seconds from start to finish (capped at the duration) */
    if (S.timeSec == null) S.timeSec = Math.round(Math.max(0, Math.min(S.durationSec, S.durationSec - remaining())));
    save();
    submit();
  }

  /* ---------- submission with retries ---------- */
  var retryDelay = 3;
  function submit() {
    inTest = false;
    var status = h('p', { class: 'muted', id: 'sendmsg', text: 'Sending your answers...' });
    var again = h('button', { class: 'btn', text: 'Send again', style: 'display:none' });
    shell(h('div', { class: 'card result' }, [h('h1', { text: 'Finishing the test' }), status, again]));
    var payload = {
      action: 'submit', testId: S.testId, studentId: S.studentId, code: S.code, token: S.token,
      version: D.version, exits: S.exits || 0, timeSec: S.timeSec,
      engine: ENGINE_VER, exitLog: S.exitLog || [], // full exit list as a backup copy
      answers: S.order.map(function (id) { return { q: id, a: ansStr(qById(id), S.answers[id]) }; })
    };
    function attempt() {
      again.style.display = 'none';
      status.textContent = 'Sending your answers...';
      apiPost(payload).then(function (res) {
        if (res.ok && res.result) {
          (S.exitLog || []).forEach(function (x) { x.sent = true; });
          S.result = res.result; S.finishing = false; save(); resultScreen();
        } else if (res.error === 'bad code' || res.error === 'not started') {
          status.className = 'err';
          status.textContent = 'The server did not accept the answers (' + errText(res.error) + ') Do not close this page, show it to ' + L.contact + '.';
          again.style.display = '';
        } else { fail(); }
      }).catch(fail);
    }
    function fail() {
      status.textContent = 'No connection. Your answers are saved on this device, retrying in ' + retryDelay + ' s...';
      again.style.display = '';
      var d = retryDelay; retryDelay = Math.min(retryDelay * 2, 30);
      setTimeout(function () { if (document.body.contains(status)) attempt(); }, d * 1000);
    }
    again.addEventListener('click', attempt);
    attempt();
  }

  /* ---------- question image: click or tap opens it full screen ----------
     The overlay sits inside the page, so the browser stays in fullscreen and no exit is logged.
     Closing: the Close button or a tap anywhere. Esc is not used: in fullscreen the browser takes Esc itself. */
  function qImage(q) {
    var alt = q.alt || 'Picture for the question';
    var img = h('img', { class: 'qimg zoomable', src: q.img, alt: alt, draggable: 'false', tabindex: '0', role: 'button',
      title: 'Open the picture full screen' });
    function open() {
      var close = h('button', { class: 'btn', type: 'button', text: 'Close' });
      var box = h('div', { class: 'imgzoom', role: 'dialog', 'aria-modal': 'true', 'aria-label': alt }, [
        h('div', { class: 'zscroll' }, [h('img', { src: q.img, alt: alt, draggable: 'false' })]),
        h('p', { class: 'zhint', text: 'Swipe sideways to see the whole picture.' }), close]);
      function shut() { box.remove(); img.focus(); }
      box.addEventListener('click', shut);
      document.body.appendChild(box);
      close.focus();
    }
    img.addEventListener('click', open);
    img.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return h('div', { class: 'qimgwrap' }, [img, h('p', { class: 'imghint', text: 'Tap the picture to enlarge it.' })]);
  }

  /* ---------- result ---------- */
  function resultScreen() {
    inTest = false;
    leaveFull();
    var r = S.result;
    var lvIdx = (D.levels || []).map(function (x) { return x.toLowerCase(); }).indexOf(String(r.level).toLowerCase());
    var wrongPos = (S.order ? r.wrong.map(function (q) { return S.order.indexOf(q) + 1; }) : r.wrong.map(Number))
      .sort(function (a, b) { return a - b; });
    var next = h('button', { class: 'btn ghost', text: 'Next ' + L.learnerLow, onclick: function () {
      if (confirm('Close this result on this device?')) resetDevice();
    } });
    var pts = pointsBlock(r);
    shell(h('div', { class: 'card result' }, [
      h('h1', { text: 'Test complete' }),
      h('p', { class: 'muted', text: S.studentName }),
      h('div', { class: 'badge l' + Math.max(0, lvIdx), text: r.level }),
      pts ? null : h('div', { class: 'stat', text: 'Correct answers: ' + r.correct + ' of ' + r.total }),
      pts,
      pts ? h('p', { class: 'muted', text: 'Correct answers: ' + r.correct + ' of ' + r.total }) : null,
      h('p', { text: wrongPos.length ? 'Questions with mistakes: ' + wrongPos.join(', ') : 'No mistakes. Great work!' }),
      topicsBlock(r),
      r.teacher ? h('div', { class: 'info', text: S.studentId === 'ADMIN' ? 'Administrator check, not included in the report.' : 'Teacher trial run, not included in the report.' }) : null,
      h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, [next])
    ]));
  }

  /* ---------- points by difficulty level ----------
     Shown only when questions carry lvl (difficulty level) or pts (points) and the test is not primary school.
     Points come from the server (r.pts / r.wrong) and the weights in the data file; weights are not the key. */
  function hasWeights() {
    return !PRIMARY && D.questions.some(function (q) { return q.lvl != null || (q.pts != null && q.pts !== 1); });
  }

  function pointsBlock(r) {
    if (!hasWeights()) return null;
    var wrong = {};
    (r.wrong || []).forEach(function (q) { wrong[String(q)] = true; });
    var list = [], byLvl = {}, got = 0, max = 0;
    D.questions.forEach(function (q) {
      var p = Number(q.pts) || 1, key = q.lvl != null ? String(q.lvl) : '';
      var g = byLvl[key];
      if (!g) { g = byLvl[key] = { lvl: key, got: 0, max: 0 }; list.push(g); }
      g.max += p; max += p;
      /* server points per question (r.pts) win, so partial credit for matching shows;
         a question with no server score counts as 0, not full marks */
      var gp = r.pts ? (r.pts[String(q.id)] != null ? Number(r.pts[String(q.id)]) || 0 : 0) : (wrong[String(q.id)] ? 0 : p);
      g.got += gp; got += gp;
    });
    var rows = list.filter(function (g) { return g.lvl !== ''; }).map(function (g) {
      return h('tr', null, [h('td', { text: 'Level ' + g.lvl }), h('td', { class: 'num', text: g.got + ' / ' + g.max })]);
    });
    rows.push(h('tr', { class: 'tot' }, [h('td', { text: 'Total' }), h('td', { class: 'num', text: got + ' / ' + max })]));
    return h('div', null, [
      h('h2', { class: 'tophead', text: D.pointsTitle || 'Points by difficulty level' }),
      h('table', { class: 'topics' }, [
        h('thead', null, [h('tr', null, [h('th', { text: 'Level' }), h('th', { text: 'Points', style: 'text-align:right' })])]),
        h('tbody', null, rows)])]);
  }

  /* ---------- result by topic ----------
     A question's topic comes from q.topic in the data file. Correctness comes from r.wrong (server); no key on the page.
     Status: 80% and above = 2, 50% and above = 1, below = 0. Primary school: successes first and highlighted.
     The heading and column name can be set in the data file (D.topicsTitle, D.topicsCol).
     Optional D.feedback: { 'I can ...': { mastered: '...', nearly: '...', review: '...' } }, keyed by the topic text;
     the note for the reached status is shown under the skill. */
  var STATUS = PRIMARY
    ? ['Let’s practise more', 'Almost there', 'You’ve got it ⭐']
    : ['Needs review', 'Nearly mastered', 'Mastered'];

  function topicStats(r) {
    var wrong = {};
    (r.wrong || []).forEach(function (q) { wrong[String(q)] = true; });
    var list = [], byName = {};
    D.questions.forEach(function (q) {
      if (!q.topic) return;
      var t = byName[q.topic];
      if (!t) { t = byName[q.topic] = { name: q.topic, total: 0, ok: 0 }; list.push(t); }
      t.total++;
      if (!wrong[String(q.id)] && (!r.pts || r.pts[String(q.id)] != null)) t.ok++; // no server score = not counted
    });
    list.forEach(function (t) {
      var p = t.ok / t.total;
      t.s = p >= 0.8 ? 2 : (p >= 0.5 ? 1 : 0);
    });
    return list;
  }

  function topicsBlock(r) {
    var list = topicStats(r);
    if (!list.length) return null;
    if (PRIMARY) list = list.slice().sort(function (a, b) { return b.s - a.s; });
    var FB = D.feedback || {}, FBKEY = ['review', 'nearly', 'mastered'];
    var rows = list.map(function (t) {
      var note = FB[t.name] && FB[t.name][FBKEY[t.s]];
      return h('tr', { class: 's' + t.s + (PRIMARY && t.s === 2 ? ' win' : '') }, [
        h('td', null, [h('div', { text: t.name }), note ? h('div', { class: 'fb', text: note }) : null]),
        h('td', { class: 'st', text: STATUS[t.s] })]);
    });
    return h('div', null, [
      h('h2', { class: 'tophead', text: D.topicsTitle || (PRIMARY ? 'What you can already do' : 'Result by topic') }),
      h('table', { class: 'topics' }, [
        h('thead', null, [h('tr', null, [h('th', { text: D.topicsCol || 'Topic' }), h('th', { text: 'Status' })])]),
        h('tbody', null, rows)])]);
  }

  /* ---------- exits from the page ----------
     One exit = one episode: from the first signal until "Back to the test" (or unlocking).
     Types: tab (other tab or minimised window), blur (other window, app, other half of a split screen, notification),
     narrow (window narrowed, split view), fs (left fullscreen), close (page closed or reloaded).
     Duration = time the page was hidden or unfocused; if neither happened (fullscreen or narrowing only),
     until the return to the test. Each episode is sent straight away (action exit) and again with the submission.
     On every 5th exit the test locks until the teacher's unlock code; the timer keeps running. */
  var EXIT_BLOCK = 5;
  var FS_OK = !!(document.documentElement && document.documentElement.requestFullscreen && document.fullscreenEnabled !== false);
  var fsFailed = false;
  var graceUntil = 0;
  var mode = 'other'; // test | exit | block | other
  var sendingExits = false, exitRetry = null;

  function fsOn() { return FS_OK && !fsFailed && !(S && S.fsNA); }
  function goFull() {
    if (!fsOn() || document.fullscreenElement) return;
    try {
      var p = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (p && p.catch) p.catch(function () { markFsNA(); });
    } catch (e) { markFsNA(); }
  }
  function leaveFull() {
    if (S && !S.result && S.order) return; // the engine never drops fullscreen itself during a test
    try { if (document.fullscreenElement && document.exitFullscreen) { var p = document.exitFullscreen(); if (p && p.catch) p.catch(function () {}); } } catch (e) { /* ignore */ }
  }
  /* the browser refused fullscreen: the test is not blocked, but it shows in the exits report */
  function markFsNA() {
    fsFailed = true;
    if (!S || S.fsNA || S.result) return;
    S.fsNA = true;
    S.exitLog = S.exitLog || [];
    S.exitLog.push({ n: 0, at: Date.now() + (S.offset || 0), dur: 0, types: ['fsna'], q: '' });
    save(); sendExits();
  }

  function cond() {
    var full = !!document.fullscreenElement;
    return {
      tab: !!document.hidden,
      blur: !document.hidden && !document.hasFocus(),
      fs: fsOn() && !full,
      narrow: !full && window.outerWidth > 0 && screen.availWidth > 0 && window.outerWidth < screen.availWidth * 0.85
    };
  }
  function watching() { return !!S && !S.result && !S.finishing && !S.paused && (mode === 'test' || mode === 'exit' || mode === 'block'); }

  function check() {
    if (!watching()) return;
    var c = cond(), t = Date.now();
    var grace = t < graceUntil;
    var out = c.tab || c.blur;
    if (!S.away) {
      if (mode === 'test') { if (!(out || (!grace && (c.fs || c.narrow)))) return; }
      else if (!out) return; // on exit screens with no open exit, only a real exit from the page counts
      openExit(c, false);
      showAway();
      return;
    }
    var ep = S.away, ch = false;
    function add(k) { if (ep.types.indexOf(k) < 0) { ep.types.push(k); ch = true; } }
    if (c.tab) add('tab'); else if (c.blur) add('blur');
    if (!grace) { if (c.fs && !ep.reload) add('fs'); if (c.narrow) add('narrow'); }
    if (out && !ep.outSince) { ep.outSince = t; ch = true; }
    if (!out && ep.outSince) { ep.awayMs += t - ep.outSince; ep.outSince = 0; ch = true; }
    if (ch) save();
  }

  /* Opens an exit. Does not draw the screen: showAway does. */
  function openExit(c, reload, at) {
    var t = at || Date.now();
    S.exits = (S.exits || 0) + 1;
    var types = [];
    if (reload) types.push('close');
    if (c) {
      if (c.tab) types.push('tab'); else if (c.blur) types.push('blur');
      if (c.fs) types.push('fs');
      if (c.narrow) types.push('narrow');
    }
    S.away = { n: S.exits, at: t, q: S.order ? S.order[S.cur] : '', types: types, awayMs: 0,
      outSince: (reload || (c && (c.tab || c.blur))) ? t : 0, reload: !!reload };
    if (S.exits % EXIT_BLOCK === 0) S.blocked = { n: S.exits, at: t };
    save();
  }

  function closeExit() {
    var ep = S && S.away;
    if (!ep) return;
    var t = Date.now();
    if (ep.outSince) { ep.awayMs += Math.max(0, t - ep.outSince); ep.outSince = 0; }
    var dur = ep.awayMs > 0 ? ep.awayMs : Math.max(0, t - ep.at);
    S.exitLog = S.exitLog || [];
    S.exitLog.push({ n: ep.n, at: ep.at + (S.offset || 0), dur: Math.round(dur / 1000), types: ep.types.slice(),
      q: ep.q || '', blocked: ep.n % EXIT_BLOCK === 0 });
    S.away = null;
    save();
    sendExits();
  }

  function showAway() {
    Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) { m.remove(); });
    if (S.blocked) blockScreen();
    else if (S.away) exitScreen('exit');
    else exitScreen('resume');
  }

  function awayShell(card, m) {
    shell(card, { timer: true, meta: S.className + ', ' + S.subject });
    mode = m;
    startTick();
  }

  /* kind: exit (after an exit), unlocked (after unlocking), resume (after a pause or without an exit) */
  function exitScreen(kind) {
    inTest = false;
    var n = S.exits || 0;
    var next = (Math.floor(n / EXIT_BLOCK) + 1) * EXIT_BLOCK;
    var err = h('div');
    var go = h('button', { class: 'btn', text: 'Back to the test' });
    go.addEventListener('click', function () {
      if (!fsOn() && cond().narrow) { err.className = 'err'; err.textContent = 'Make the browser window full width and press again.'; return; }
      graceUntil = document.fullscreenElement ? 0 : Date.now() + 3000; // grace time only while the browser enters fullscreen
      goFull(); // fullscreen only in response to a click
      closeExit();
      testScreen();
    });
    var kids;
    if (kind === 'exit') {
      kids = [
        h('h1', { text: 'You left the test. This has been logged.' }),
        h('div', { class: 'ecount', text: 'Exits: ' + n }),
        h('p', { text: 'Every exit goes into ' + L.contactPoss + ' report. The timer is still running.' }),
        h('p', { class: 'muted', text: 'On exit ' + next + ' the test will lock, and you will only be able to continue with a code from ' + L.contact + '.' })];
    } else if (kind === 'unlocked') {
      kids = [
        h('h1', { text: 'Test unlocked' }),
        h('div', { class: 'ecount', text: 'Exits: ' + n }),
        h('p', { text: 'Your answers are saved. The timer is still running.' }),
        h('p', { class: 'muted', text: 'The next lock is on exit ' + next + '.' })];
    } else {
      kids = [
        h('h1', { text: 'Let’s continue' }),
        h('p', { text: 'The test will open in full screen. Your answers are saved.' })];
    }
    kids.push(err, h('div', { class: 'row', style: 'justify-content:center;margin-top:16px' }, [go]));
    awayShell(h('div', { class: 'card exitbox' + (kind === 'exit' ? '' : ' ok') }, kids), 'exit');
  }

  function blockScreen() {
    inTest = false;
    var code = h('input', { class: 'code', type: 'tel', inputmode: 'numeric', autocomplete: 'off', maxlength: '12', 'aria-label': 'Unlock code' });
    var err = h('div');
    var go = h('button', { class: 'btn', text: 'Unlock' });
    function run() {
      err.className = ''; err.textContent = '';
      var cv = code.value.trim();
      if (!cv) { err.className = 'err'; err.textContent = 'An unlock code from ' + L.contact + ' is needed.'; return; }
      go.disabled = true; go.textContent = 'Checking...';
      apiPost({ action: 'unlock', testId: S.testId, studentId: S.studentId, token: S.token, code: cv,
        n: S.blocked ? S.blocked.n : S.exits, engine: ENGINE_VER })
        .then(function (res) {
          go.disabled = false; go.textContent = 'Unlock';
          if (!res.ok) { err.className = 'err'; err.textContent = errText(res.error); return; }
          S.blocked = null; S.unlocks = (S.unlocks || 0) + 1;
          save();
          exitScreen('unlocked');
        })
        .catch(function () {
          go.disabled = false; go.textContent = 'Unlock';
          err.className = 'err'; err.textContent = 'No connection. Check your internet and try again.';
        });
    }
    go.addEventListener('click', run);
    code.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
    awayShell(h('div', { class: 'card exitbox' }, [
      h('h1', { text: 'Test locked' }),
      h('div', { class: 'ecount', text: 'Exits: ' + (S.exits || 0) }),
      h('p', { text: 'You have left the test ' + (S.exits || 0) + ' times. Call ' + L.contact + ': you can only continue with an unlock code.' }),
      h('p', { class: 'muted', text: 'The timer is still running. Your answers are saved.' }),
      S.demo && S.demo.unlockCode ? hint('Demo: there is no invigilator here, so the unlock code is ' + S.demo.unlockCode + '.') : null,
      h('label', { text: 'Unlock code' }), code, err,
      h('div', { class: 'row', style: 'justify-content:center;margin-top:16px' }, [go])
    ]), 'block');
  }

  /* ---------- sending exits ---------- */
  function exitPayload(items) {
    return { action: 'exit', testId: S.testId, studentId: S.studentId, token: S.token, engine: ENGINE_VER, items: items };
  }
  function sendExits() {
    if (!S || !S.token || sendingExits) return;
    var items = (S.exitLog || []).filter(function (x) { return !x.sent; });
    if (!items.length) return;
    sendingExits = true;
    apiPost(exitPayload(items)).then(function (res) {
      sendingExits = false;
      /* ok, or a final refusal from the server (wrong session): stop retrying; busy = try later */
      if (res && (res.ok || (res.error && res.error !== 'busy'))) {
        items.forEach(function (x) { x.sent = true; });
        save();
      } else retryExits();
    }).catch(function () { sendingExits = false; retryExits(); });
  }
  function retryExits() {
    if (exitRetry) return;
    exitRetry = setTimeout(function () { exitRetry = null; sendExits(); }, 15000);
  }
  /* while the page closes: everything unsent plus the exit in progress (the server updates it later) */
  function beaconExits() {
    if (!S || !S.token || !navigator.sendBeacon) return;
    var items = (S.exitLog || []).filter(function (x) { return !x.sent; });
    if (S.away) {
      var ep = S.away, t = Date.now();
      var ms = (ep.awayMs || 0) + (ep.outSince ? t - ep.outSince : 0);
      items = items.concat([{ n: ep.n, at: ep.at + (S.offset || 0), dur: Math.round((ms || (t - ep.at)) / 1000),
        types: ep.types.slice(), q: ep.q || '', blocked: ep.n % EXIT_BLOCK === 0, open: true }]);
    }
    if (!items.length) return;
    try { navigator.sendBeacon(CFG.api, new Blob([JSON.stringify(exitPayload(items))], { type: 'text/plain;charset=utf-8' })); } catch (e) { /* ignore */ }
  }

  function soon() { setTimeout(check, 50); }
  document.addEventListener('visibilitychange', soon);
  document.addEventListener('fullscreenchange', function () {
    if (document.fullscreenElement) graceUntil = 0; // fullscreen is on: no more grace time needed
    soon();
  });
  window.addEventListener('blur', soon);
  window.addEventListener('focus', soon);
  window.addEventListener('resize', soon);
  window.addEventListener('pagehide', function () {
    if (!S || S.result || S.paused || S.finishing) return;
    if (mode !== 'test' && mode !== 'exit' && mode !== 'block') return;
    var t = Date.now();
    if (!S.away) openExit(null, true, t);
    else {
      if (S.away.types.indexOf('close') < 0) {
        /* closing hides the page first: an "other tab" signal a moment before closing is dropped */
        if (t - S.away.at < 1500) S.away.types = S.away.types.filter(function (k) { return k !== 'tab' && k !== 'blur' && k !== 'fs'; });
        S.away.types.unshift('close');
      }
      if (!S.away.outSince) S.away.outSince = t;
      S.away.reload = true;
    }
    save();
    beaconExits();
  });
  setInterval(function () {
    check();
    if (watching()) {
      var t = Date.now();
      if (t - (S.lastSeen || 0) > 3000) { S.lastSeen = t; save(); }
    }
  }, 1000);

  /* ---------- start ---------- */
  if (!resume()) startScreen();
})();
