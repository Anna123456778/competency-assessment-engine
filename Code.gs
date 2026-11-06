/**
 * Classroom Assessment Engine: results receiver, v5.6 (demo edition).
 * Google Apps Script bound to a Google Sheet (Extensions > Apps Script), deployed as a web app.
 *
 * What it does: server-side scoring (the answer key lives only in the Questions sheet), one class code per class,
 * test timing from the server clock, parallel classes, PDF reports emailed to teachers, teacher trial runs,
 * emergency pause, logging of every exit from the test page, unlock codes.
 *
 * Version history:
 *   v5    task types (choice, matching, whole number) with partial credit for matching, time from the page timer,
 *         difficulty levels (Questions F) in the report, trial report after a teacher trial run
 *   v5.1  "Administrator check" sign-in with its own code; its report goes only to the trial copy address
 *   v5.5  emergency pause: POST pause / resume, resume only with the same class code; the deadline is
 *         start + duration + pauses + 90 s; "interrupted by a pause" mark in the teacher report
 *   v5.6  exits from the page (engine v6.5): POST exit (each exit right away, with type, duration, question),
 *         POST unlock (unlock code, Tests S), Exits sheet (created automatically), engine version in Sessions,
 *         "Exits from the test" line in the report, separate exits PDF only when exits happened.
 *         The receiver only records exits; it never changes a result.
 *   v5.6-demo  public "Guest" sign-in (GUEST_CODE): unlimited attempts, answers go to Responses with status guest
 *         (never into class statistics), a report on every guest run goes to TRIAL_CC; when guest mode is on,
 *         the roster also returns the guest code and the unlock code as public hints for the demo page.
 *   v5.7-demo  optional LEARNER_LABEL, CONTACT_LABEL, GROUP_LABEL for non-school use: reports, emails and the trial
 *         sign-in name use these words, and the 1-12 scale is left out. Without them nothing changes.
 *
 * Secrets are not stored in code. Set them in Project Settings > Script Properties:
 *   ADMIN_CODE  code for the "Administrator check" sign-in (6 digits, optional)
 *   GUEST_CODE  public code for the "Guest" sign-in (6 digits, optional; turns on the public demo mode)
 *   TRIAL_CC    email that gets every trial, check and guest report (optional)
 *   LEARNER_LABEL  word for a learner in reports and emails, e.g. Participant (optional; default Student).
 *                  When set, the school 1-12 scale is left out of reports.
 *   CONTACT_LABEL  word for the person running the test, e.g. facilitator (optional; default teacher)
 *   GROUP_LABEL    word for a group of learners, e.g. group (optional; default class)
 *
 * Sheets:
 *   Responses : A Time | B Submission ID | C Test ID | D Class | E Subject | F Student | G Question |
 *               H Answer | I Correct (1/0) | J Points | K Status | L Student ID | M Version | N Exits |
 *               O Result code | P Time (s) | Q Pauses (s) | R Pause count
 *   Students  : A Student ID | B Class | C Full name | D Active (checkbox)
 *   Tests     : A Test ID | B Class | C Subject | D Max points | E Open from | F Open until | G Active (checkbox) |
 *               H Note | I Term | J Teacher email | K Report sent (checkbox) | L Primary school (checkbox) |
 *               M Thresholds (points, e.g. 6;10;13) | N Duration (min) | O Version | P Teacher code |
 *               Q Question bank ID (empty = Test ID) | R Class code | S Unlock code
 *   Questions : A Question bank ID | B Question | C Learning outcome | D Max points | E Correct answer |
 *               F Difficulty level (1, 2, 3; empty = no levels)
 *               Answer format: choice = option key (B); number = 12 (several accepted: 12|13);
 *               matching or gaps = 1-C;2-A;3-D (keys as in the data file). Store as plain text.
 *   Levels    : A Level | B From % | C Scale (1-12) | D Verdict
 *   Sessions  : (created automatically) A Class code | B Test ID | C Student ID | D Status | E Start (ms) |
 *               F Result code | G Student | H Class | I Token | J Result (JSON) | K Paused since (ms) |
 *               L Paused (s) | M Pause count | N Unlocks | O Engine
 *   Exits     : (created automatically) A Logged at | B Test ID | C Class | D Student | E Student ID |
 *               F Exit no. (0 = fullscreen unavailable) | G Started | H Duration (s) | I Types | J Question |
 *               K Locked | L Unlocked at | M Status (ok / teacher / check / guest) | N Engine | O Token
 *
 * Parallel classes: one Tests row per class (e.g. MATH3-01-A and MATH3-01-B) with the same question bank (MATH3-01).
 * Each row has its own window and teacher email; a teacher's report covers only their row.
 *
 * GET  ?action=runs&bank=ID          -> open classes for a question bank
 * GET  ?action=roster&test=ID        -> class list (+ trial and guest sign-ins; public demo hints in guest mode)
 * POST {action:'start',  testId, studentId, code, token, engine}
 * POST {action:'submit', testId, studentId, code, token, version, exits, timeSec, answers:[{q, a}], engine, exitLog}
 * POST {action:'pause',  testId, studentId, token, pausedAt}
 * POST {action:'resume', testId, studentId, code, token, pausedAt}
 * POST {action:'exit',   testId, studentId, token, engine, items:[{n, at, dur, types, q, blocked, open}]}
 * POST {action:'unlock', testId, studentId, token, code, n}
 *
 * Statuses: ok | teacher | check | guest | late | unknown student | wrong class | duplicate
 * Only submissions with status ok go into reports.
 */

var RESPONSES = 'Responses';
var TESTS = 'Tests';
var STUDENTS = 'Students';
var QUESTIONS = 'Questions';
var LEVELS = 'Levels';
var SESSIONS = 'Sessions';
var EXITS = 'Exits';
var MAX_ANSWERS = 200;
var MAX_EXITS = 300;

var TEACHER_ID = 'TEACHER';
var TEACHER_NAME = 'Teacher (trial run)';
var ADMIN_ID = 'ADMIN';
var ADMIN_NAME = 'Check (administrator only)';
var GUEST_ID = 'GUEST';
var GUEST_NAME = 'Guest';

var SENDER_NAME = 'Classroom Assessment';
var DAILY_HOUR = 18;
var DEFAULT_DURATION_MIN = 40;
var GRACE_SEC = 90; // allowance for sending after time runs out
var VERSION = '5.7';
var LOCALE = 'en';

var ST_STARTED = 'started';
var ST_SUBMITTED = 'submitted';
var YES = 'yes';

function prop_(name) {
  try { return String(PropertiesService.getScriptProperties().getProperty(name) || '').trim(); } catch (e) { return ''; }
}
function adminCode_() { return prop_('ADMIN_CODE'); }
function guestCode_() { return prop_('GUEST_CODE'); }
function trialCc_() { return prop_('TRIAL_CC'); }

/** Words used in reports and emails (Script Properties; school defaults). Sheet headers and menus stay as they are. */
var W_CACHE = null;
function W_() {
  if (W_CACHE) return W_CACHE;
  var learner = prop_('LEARNER_LABEL'), contact = prop_('CONTACT_LABEL'), group = prop_('GROUP_LABEL');
  var cap = function (x) { return x.charAt(0).toUpperCase() + x.slice(1); };
  var w = { school: !learner };
  w.Learner = cap(learner || 'Student');
  w.learner = w.Learner.toLowerCase();
  w.Learners = w.Learner + 's';
  w.learners = w.learner + 's';
  w.contact = (contact || 'teacher').toLowerCase();
  w.Contact = cap(w.contact);
  w.group = (group || 'class').toLowerCase();
  w.trialName = w.Contact + ' (trial run)';
  W_CACHE = w;
  return w;
}

/** Trial-type sign-ins: no session, unlimited attempts, never in class statistics. */
function isTrialId_(studentId) { return studentId === TEACHER_ID || studentId === ADMIN_ID || studentId === GUEST_ID; }
function trialName_(studentId) {
  if (studentId === ADMIN_ID) return ADMIN_NAME;
  if (studentId === GUEST_ID) return GUEST_NAME;
  return W_().trialName;
}

/* exit type labels (the engine sends short keys) */
var EXIT_LABELS = {
  tab: 'other tab or minimised window',
  blur: 'other window, app, half of a split screen or notification',
  narrow: 'window narrowed (split view)',
  fs: 'left fullscreen',
  close: 'page closed or reloaded',
  fsna: 'fullscreen unavailable'
};
var EXIT_OPEN_MARK = ' (in progress)';

/* difficulty level colours in the report: [header, header text, light background for a correct answer] */
var LVL_COLORS = [['#2B4C7E', '#FFFFFF', '#DFE7F2'], ['#2E8B57', '#FFFFFF', '#DDF1E4'], ['#F2C14E', '#1A1A1A', '#FDF3D6']];
var LVL_GREY = ['#6B6B6B', '#FFFFFF', '#EEEEEE'];

/* =====================  GET  ===================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (p.action === 'runs') {
    var bank = clean_(p.bank, 50);
    var now = new Date();
    var runs = [];
    var vals = ss.getSheetByName(TESTS).getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      var t = testFromRow_(vals[i], i + 1);
      if (t.id && t.bank === bank && testOpen_(t, now) === 'ok') runs.push({ testId: t.id, className: t.className });
    }
    runs.sort(function (a, b) { return a.className.localeCompare(b.className, LOCALE); });
    return json_({ ok: true, runs: runs });
  }
  if (p.action === 'roster') {
    var test = findTest_(ss.getSheetByName(TESTS), clean_(p.test, 50));
    if (!test) return json_({ ok: false, error: 'unknown test' });
    var open = testOpen_(test, new Date()) === 'ok';
    var students = open ? rosterFor_(ss.getSheetByName(STUDENTS), test.className) : [];
    if (adminCode_()) students.unshift({ id: ADMIN_ID, name: ADMIN_NAME });
    if (test.teacherCode) students.unshift({ id: TEACHER_ID, name: W_().trialName });
    var res = { ok: true, open: open, className: test.className, subject: test.subject,
      durationMin: test.durationMin, students: students };
    /* public demo mode: Guest first in the list, and the codes a visitor needs are shown on the page */
    if (guestCode_()) {
      students.unshift({ id: GUEST_ID, name: GUEST_NAME });
      res.demo = { guestCode: guestCode_(), unlockCode: test.unlockCode };
    }
    return json_(res);
  }
  return json_({ ok: true, service: 'Classroom Assessment receiver', version: VERSION });
}

/* =====================  POST  ===================== */

function doPost(e) {
  var data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  var lock = LockService.getScriptLock();
  /* an exit does not wait in a long queue, so it never slows down starts and submissions; if busy, the engine retries */
  if (data && data.action === 'exit') {
    if (!lock.tryLock(5000)) return json_({ ok: false, error: 'busy' });
  } else {
    lock.waitLock(20000);
  }
  try {
    var testId = clean_(data.testId, 50);
    var studentId = clean_(data.studentId, 30);
    if (!testId || !studentId) return json_({ ok: false, error: 'bad payload' });
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (data.action === 'start') return json_(doStart_(ss, data, testId, studentId));
    if (data.action === 'submit') return json_(doSubmit_(ss, data, testId, studentId));
    if (data.action === 'pause') return json_(doPause_(ss, data, testId, studentId));
    if (data.action === 'resume') return json_(doResume_(ss, data, testId, studentId));
    if (data.action === 'exit') return json_(doExit_(ss, data, testId, studentId));
    if (data.action === 'unlock') return json_(doUnlock_(ss, data, testId, studentId));
    return json_({ ok: false, error: 'bad action' });
  } finally {
    lock.releaseLock();
  }
}

/** Admission check for a student. Returns an error code or ''. */
function admission_(ss, test, student, studentId) {
  var now = new Date();
  var open = testOpen_(test, now);
  if (open !== 'ok') return 'closed:' + open;
  if (!student || !student.active) return 'unknown student';
  if (norm_(student.className) !== norm_(test.className)) return 'wrong class';
  if (alreadySubmitted_(ss.getSheetByName(RESPONSES), test.id, studentId)) return 'already';
  return '';
}

function isAdminCode_(code) { var a = adminCode_(); return !!a && code === a; }
function isGuestCode_(code) { var g = guestCode_(); return !!g && code === g; }

function doStart_(ss, data, testId, studentId) {
  var test = findTest_(ss.getSheetByName(TESTS), testId);
  if (!test) return { ok: false, error: 'unknown test' };
  var code = clean_(data.code, 20);
  var token = clean_(data.token, 60);
  var engine = clean_(data.engine, 10);
  var nowMs = Date.now();
  var base = { ok: true, serverNow: nowMs, durationSec: test.durationMin * 60,
    className: test.className, subject: test.subject };

  if (studentId === TEACHER_ID) {
    if (!test.teacherCode || code !== test.teacherCode) return { ok: false, error: 'bad code' };
    base.startedAt = nowMs;
    return base;
  }
  if (studentId === ADMIN_ID) {
    if (!isAdminCode_(code)) return { ok: false, error: 'bad code' };
    base.startedAt = nowMs;
    return base;
  }
  if (studentId === GUEST_ID) {
    if (!isGuestCode_(code)) return { ok: false, error: 'bad code' };
    if (testOpen_(test, new Date()) !== 'ok') return { ok: false, error: 'closed:' + testOpen_(test, new Date()) };
    base.startedAt = nowMs;
    return base;
  }

  if (!test.classCode || code !== test.classCode) return { ok: false, error: 'bad code' };
  var student = findStudent_(ss.getSheetByName(STUDENTS), studentId);
  var rec = findSession_(ss, testId, studentId);

  if (rec && rec.status === ST_SUBMITTED) {
    if (token && rec.token === token) return { ok: true, done: true, result: parseJson_(rec.result) };
    return { ok: false, error: 'used' };
  }
  if (rec && rec.status === ST_STARTED) {
    if (!token || rec.token !== token) return { ok: false, error: 'used' };
    if (engine && engine !== rec.engine) setEngine_(ss, rec.row, engine);
    base.startedAt = rec.start;
    base.pausedMs = rec.pausedSec * 1000;
    if (rec.pauseFrom) base.pauseFrom = rec.pauseFrom;
    return base;
  }
  var err = admission_(ss, test, student, studentId);
  if (err) return { ok: false, error: err };
  if (!token) return { ok: false, error: 'bad payload' };
  var sh = sessionsSheet_(ss);
  var row;
  if (rec) {
    row = rec.row;
    sh.getRange(row, 4, 1, 2).setValues([[ST_STARTED, nowMs]]);
    sh.getRange(row, 9).setValue(token);
  } else {
    row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, 10).setValues([[test.classCode, testId, studentId, ST_STARTED, nowMs, '',
      student.name, test.className, token, '']]);
  }
  if (engine) setEngine_(ss, row, engine);
  base.startedAt = nowMs;
  return base;
}

function doSubmit_(ss, data, testId, studentId) {
  var test = findTest_(ss.getSheetByName(TESTS), testId);
  if (!test) return { ok: false, error: 'unknown test' };
  var code = clean_(data.code, 20);
  var token = clean_(data.token, 60);
  var isAdmin = studentId === ADMIN_ID;
  var isGuest = studentId === GUEST_ID;
  var isTeacher = studentId === TEACHER_ID || isAdmin;
  var student = null, rec = null;
  var status = 'ok';

  if (isGuest) {
    if (!isGuestCode_(code)) return { ok: false, error: 'bad code' };
    status = 'guest';
  } else if (isAdmin) {
    if (!isAdminCode_(code)) return { ok: false, error: 'bad code' };
    status = 'check';
  } else if (isTeacher) {
    if (!test.teacherCode || code !== test.teacherCode) return { ok: false, error: 'bad code' };
    status = 'teacher';
  } else {
    if (!test.classCode || code !== test.classCode) return { ok: false, error: 'bad code' };
    student = findStudent_(ss.getSheetByName(STUDENTS), studentId);
    rec = findSession_(ss, testId, studentId);
    if (!rec || !token || rec.token !== token) return { ok: false, error: 'bad code' };
    if (rec.status === ST_SUBMITTED) return { ok: true, result: parseJson_(rec.result) }; // repeated send
    if (rec.status !== ST_STARTED) return { ok: false, error: 'not started' };
    if (!student || !student.active) status = 'unknown student';
    else if (norm_(student.className) !== norm_(test.className)) status = 'wrong class';
    else if (alreadySubmitted_(ss.getSheetByName(RESPONSES), testId, studentId)) status = 'duplicate';
    else {
      /* a submission that arrives during an open pause closes it now */
      if (rec.pauseFrom) closePause_(ss, rec, Date.now());
      if (Date.now() - rec.start > (test.durationMin * 60 + GRACE_SEC + rec.pausedSec) * 1000) status = 'late';
    }
  }
  var pausedSec = rec ? rec.pausedSec : 0;
  var pauseN = rec ? rec.pauseN : 0;

  var key = readQuestions_(ss.getSheetByName(QUESTIONS), test.bank);
  var order = key.order;
  if (!order.length) return { ok: false, error: 'no questions' };

  var given = {};
  var answers = data.answers;
  if (answers && answers.length && answers.length <= MAX_ANSWERS) {
    for (var i = 0; i < answers.length; i++) {
      var a = answers[i] || {};
      given[clean_(a.q, 20)] = clean_(a.a, 500);
    }
  }

  var now = new Date();
  var id = Utilities.getUuid();
  var resultCode = makeResultCode_();
  var exits = Math.max(0, Math.min(999, Number(data.exits) || 0));
  var version = clean_(data.version || test.version, 30);
  var studentName = (isTeacher || isGuest) ? trialName_(studentId) : (student ? student.name : '');
  /* time from the page timer (seconds); if an old page did not send it, use server time for students */
  var limitSec = test.durationMin * 60 + GRACE_SEC;
  var timeSec = '';
  if (data.timeSec !== undefined && data.timeSec !== null && data.timeSec !== '' && !isNaN(Number(data.timeSec))) {
    timeSec = Math.max(0, Math.min(limitSec, Math.round(Number(data.timeSec))));
  } else if (rec && rec.start) {
    timeSec = Math.max(0, Math.min(limitSec, Math.round((Date.now() - rec.start) / 1000) - pausedSec));
  }

  var rows = [], total = 0, correctN = 0, wrong = [], ptsMap = {};
  for (var k = 0; k < order.length; k++) {
    var q = order[k];
    var m = key.map[q];
    var ans = given[q] || '';
    var sc = scoreAnswer_(m, ans);
    total += sc.pts;
    ptsMap[q] = sc.pts;
    if (sc.ok) correctN++; else wrong.push(q);
    rows.push([now, id, testId, test.className, test.subject, studentName,
      q, ans, sc.ok ? 1 : 0, sc.pts, status, studentId, version, exits, resultCode, timeSec,
      pauseN ? pausedSec : '', pauseN || '']);
  }
  var resp = responsesSheet_(ss);
  resp.getRange(resp.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

  /* full exit list with the submission (backup copy; exits that already arrived are not duplicated) */
  if (data.exitLog && data.exitLog.length) {
    try { writeExits_(ss, test, studentId, studentName, token, data.exitLog, clean_(data.engine, 10)); }
    catch (err) { console.error('exits on submit: ' + err); }
  }

  var levels = readLevels_(ss.getSheetByName(LEVELS));
  var max = test.max || sumMax_(key);
  var lv = levels[levelIdx_(test, levels, total, max)];
  var result = { status: status, level: lv.name, correct: correctN, total: order.length,
    wrong: wrong, resultCode: resultCode, teacher: isTeacher, pts: ptsMap, score: total, max: max };

  /* teacher trial run: trial report to the teacher and a copy to TRIAL_CC; check and guest runs: TRIAL_CC only */
  if (isTeacher || isGuest) {
    var kind = isGuest ? 'guest' : (isAdmin ? 'admin' : 'teacher');
    try { sendTrialReport_(ss, test, rows, kind, token); } catch (err) { console.error('trial report: ' + err); }
  }

  if (rec) {
    var sh = ss.getSheetByName(SESSIONS);
    sh.getRange(rec.row, 4).setValue(ST_SUBMITTED);
    sh.getRange(rec.row, 6).setValue(resultCode);
    sh.getRange(rec.row, 10).setValue(JSON.stringify(result));
  }
  return { ok: true, result: result };
}

function responsesSheet_(ss) {
  var sh = ss.getSheetByName(RESPONSES);
  if (!sh) {
    sh = ss.insertSheet(RESPONSES);
    sh.getRange(1, 1, 1, 18).setValues([['Time', 'Submission ID', 'Test ID', 'Class', 'Subject', 'Student', 'Question',
      'Answer', 'Correct', 'Points', 'Status', 'Student ID', 'Version', 'Exits', 'Result code', 'Time (s)',
      'Pauses (s)', 'Pause count']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* =====================  EMERGENCY PAUSE  ===================== */

/** Code that resumes a pause: the class code for students, their own code for trial sign-ins. */
function pauseCodeOk_(test, studentId, code) {
  if (studentId === ADMIN_ID) return isAdminCode_(code);
  if (studentId === GUEST_ID) return isGuestCode_(code);
  if (studentId === TEACHER_ID) return !!test.teacherCode && code === test.teacherCode;
  return !!test.classCode && code === test.classCode;
}

/** Pause start. No code needed (the student presses the button); the session is checked by token. */
function doPause_(ss, data, testId, studentId) {
  var test = findTest_(ss.getSheetByName(TESTS), testId);
  if (!test) return { ok: false, error: 'unknown test' };
  var nowMs = Date.now();
  if (isTrialId_(studentId)) return { ok: true, serverNow: nowMs, pauseFrom: nowMs };
  var token = clean_(data.token, 60);
  var rec = findSession_(ss, testId, studentId);
  if (!rec || !token || rec.token !== token) return { ok: false, error: 'bad code' };
  if (rec.status !== ST_STARTED) return { ok: false, error: 'not started' };
  if (!rec.pauseFrom) {
    var at = pauseStart_(rec, data.pausedAt, nowMs);
    ensurePauseHeaders_(ss);
    ss.getSheetByName(SESSIONS).getRange(rec.row, 11).setValue(at);
    rec.pauseFrom = at;
  }
  return { ok: true, serverNow: nowMs, pauseFrom: rec.pauseFrom };
}

/** Resume after a pause: the teacher enters the same code. Returns the start and total pause time for the timer. */
function doResume_(ss, data, testId, studentId) {
  var test = findTest_(ss.getSheetByName(TESTS), testId);
  if (!test) return { ok: false, error: 'unknown test' };
  var code = clean_(data.code, 20);
  if (!pauseCodeOk_(test, studentId, code)) return { ok: false, error: 'bad code' };
  var nowMs = Date.now();
  if (isTrialId_(studentId)) return { ok: true, serverNow: nowMs, trial: true };
  var token = clean_(data.token, 60);
  var rec = findSession_(ss, testId, studentId);
  if (!rec || !token || rec.token !== token) return { ok: false, error: 'bad code' };
  if (rec.status !== ST_STARTED) return { ok: false, error: 'not started' };
  /* the pause may not have reached the server (no internet): use the click time from the page */
  if (!rec.pauseFrom && data.pausedAt) rec.pauseFrom = pauseStart_(rec, data.pausedAt, nowMs);
  if (rec.pauseFrom) closePause_(ss, rec, nowMs);
  return { ok: true, serverNow: nowMs, startedAt: rec.start, pausedMs: rec.pausedSec * 1000, pauses: rec.pauseN };
}

/** Pause start time: from the page, but not before the start and not after now. */
function pauseStart_(rec, clientAt, nowMs) {
  var at = Number(clientAt) || nowMs;
  return Math.max(rec.start || 0, Math.min(nowMs, at));
}

/** Closes a pause: adds its length to the total and increments the counter. */
function closePause_(ss, rec, nowMs) {
  var add = Math.max(0, Math.round((nowMs - rec.pauseFrom) / 1000));
  rec.pausedSec += add;
  rec.pauseN += 1;
  rec.pauseFrom = 0;
  ensurePauseHeaders_(ss);
  ss.getSheetByName(SESSIONS).getRange(rec.row, 11, 1, 3).setValues([['', rec.pausedSec, rec.pauseN]]);
}

function ensurePauseHeaders_(ss) {
  var sh = sessionsSheet_(ss);
  if (!String(sh.getRange(1, 11).getValue()).trim()) {
    sh.getRange(1, 11, 1, 3).setValues([['Paused since', 'Paused (s)', 'Pause count']]).setFontWeight('bold');
  }
}

/* =====================  EXITS  ===================== */

/** Engine version label in the Exits sheet: with a leading v, because Sheets turns "6.5" into a date. */
function engineLabel_(engine) {
  var e = String(engine || '').trim();
  return e ? (e.charAt(0) === 'v' ? e : 'v' + e) : '';
}

/** Reading the version back: a value Sheets already turned into a date is returned as v6.5. */
function engineText_(v) {
  if (v instanceof Date) return 'v' + v.getDate() + '.' + (v.getMonth() + 1);
  return engineLabel_(v);
}

function exitStatus_(studentId) {
  if (studentId === ADMIN_ID) return 'check';
  if (studentId === TEACHER_ID) return 'teacher';
  if (studentId === GUEST_ID) return 'guest';
  return 'ok';
}

/** An exit from the page, sent by the engine right away. For students the session is checked by token. */
function doExit_(ss, data, testId, studentId) {
  var test = findTest_(ss.getSheetByName(TESTS), testId);
  if (!test) return { ok: false, error: 'unknown test' };
  var token = clean_(data.token, 60);
  if (!token) return { ok: false, error: 'bad payload' };
  var name;
  if (isTrialId_(studentId)) name = trialName_(studentId);
  else {
    var rec = findSession_(ss, testId, studentId);
    if (!rec || rec.token !== token) return { ok: false, error: 'bad code' };
    var st = findStudent_(ss.getSheetByName(STUDENTS), studentId);
    name = st ? st.name : studentId;
  }
  writeExits_(ss, test, studentId, name, token, data.items, clean_(data.engine, 10));
  return { ok: true };
}

/** Unlock after every 5th exit: only the unlock code from Tests S. */
function doUnlock_(ss, data, testId, studentId) {
  var test = findTest_(ss.getSheetByName(TESTS), testId);
  if (!test) return { ok: false, error: 'unknown test' };
  if (!test.unlockCode) return { ok: false, error: 'no unlock code' };
  var code = clean_(data.code, 20);
  if (code !== test.unlockCode) return { ok: false, error: 'bad code' };
  var token = clean_(data.token, 60);
  if (!token) return { ok: false, error: 'bad payload' };
  var name;
  if (isTrialId_(studentId)) name = trialName_(studentId);
  else {
    var rec = findSession_(ss, testId, studentId);
    if (!rec || rec.token !== token) return { ok: false, error: 'bad code' };
    if (rec.status !== ST_STARTED) return { ok: false, error: 'not started' };
    ensureSessionHeaders_(ss);
    ss.getSheetByName(SESSIONS).getRange(rec.row, 14).setValue(rec.unlocks + 1);
    var st = findStudent_(ss.getSheetByName(STUDENTS), studentId);
    name = st ? st.name : studentId;
  }
  var n = Math.max(0, Math.min(9999, Math.floor(Number(data.n) || 0)));
  var now = new Date();
  var sh = exitsSheet_(ss);
  var idx = exitIndex_(sh, token);
  if (idx[n]) sh.getRange(idx[n].row, 12).setValue(now);
  else {
    /* the exit has not arrived yet: a placeholder row, the engine fills it in later */
    sh.getRange(sh.getLastRow() + 1, 1, 1, 15).setValues([[now, test.id, test.className, name, studentId, n, '', '',
      EXIT_OPEN_MARK.trim(), '', YES, now, exitStatus_(studentId), engineLabel_(clean_(data.engine, 10)), token]]);
  }
  return { ok: true, serverNow: Date.now() };
}

function exitsSheet_(ss) {
  var sh = ss.getSheetByName(EXITS);
  if (!sh) {
    sh = ss.insertSheet(EXITS);
    sh.getRange(1, 1, 1, 15).setValues([['Logged at', 'Test ID', 'Class', 'Student', 'Student ID', 'Exit no.', 'Started',
      'Duration (s)', 'Types', 'Question', 'Locked', 'Unlocked at', 'Status', 'Engine', 'Token']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Exits of one session (token): exit number -> row and whether it is final. */
function exitIndex_(sh, token) {
  var idx = {};
  var last = sh.getLastRow();
  if (last < 2) return idx;
  var vals = sh.getRange(2, 1, last - 1, 15).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][14]).trim() !== token) continue;
    var n = Number(vals[i][5]) || 0;
    idx[n] = { row: i + 2, final: String(vals[i][8]).indexOf(EXIT_OPEN_MARK.trim()) < 0 };
  }
  return idx;
}

/** Writes or updates exits. The key is session token + exit number, so repeats are not duplicated. */
function writeExits_(ss, test, studentId, name, token, items, engine) {
  if (!items || !items.length || !token) return;
  engine = engineLabel_(engine);
  var sh = exitsSheet_(ss);
  var idx = exitIndex_(sh, token);
  var status = exitStatus_(studentId);
  var now = new Date();
  var appends = [];
  for (var i = 0; i < Math.min(items.length, MAX_EXITS); i++) {
    var it = items[i] || {};
    var n = Math.max(0, Math.min(9999, Math.floor(Number(it.n) || 0)));
    var open = !!it.open;
    var types = (it.types && it.types.length ? it.types : []).slice(0, 10).map(function (k) {
      return EXIT_LABELS[String(k)] || '';
    }).filter(function (x) { return !!x; }).join(', ');
    var at = Number(it.at) || 0;
    var vals = [now, test.id, test.className, name, studentId, n, at ? new Date(at) : '',
      Math.max(0, Math.min(86400, Math.round(Number(it.dur) || 0))),
      types + (open ? EXIT_OPEN_MARK : ''), clean_(it.q, 20), it.blocked ? YES : ''];
    var ex = idx[n];
    if (ex) {
      if (open && ex.final) continue; // a final record is never replaced by an in-progress one
      if (ex.app != null) { var a = appends[ex.app]; for (var c = 0; c < 11; c++) a[c] = vals[c]; a[12] = status; a[13] = engine; }
      else {
        sh.getRange(ex.row, 1, 1, 11).setValues([vals]); // L (Unlocked at) is left as is
        sh.getRange(ex.row, 13, 1, 2).setValues([[status, engine]]);
      }
      ex.final = !open;
    } else {
      appends.push(vals.concat(['', status, engine, token]));
      idx[n] = { app: appends.length - 1, final: !open };
    }
  }
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, 15).setValues(appends);
}

/** Exits of a test: either one token (trial run) or all student sessions (status ok). */
function readExits_(ss, testId, token) {
  var sh = ss.getSheetByName(EXITS);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues();
  var list = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[1]).trim() !== testId) continue;
    if (token ? String(r[14]).trim() !== token : String(r[12]).trim() !== 'ok') continue;
    list.push({ name: String(r[3]), sid: String(r[4]).trim(), n: Number(r[5]) || 0,
      start: r[6] instanceof Date ? r[6] : null, dur: Number(r[7]) || 0, types: String(r[8]),
      q: String(r[9]), blocked: String(r[10]).trim() === YES, unlockAt: r[11] instanceof Date ? r[11] : null,
      engine: engineText_(r[13]), token: String(r[14]).trim() });
  }
  return list;
}

/** Report groups: one group = one student session (after "let student start again" there is a second group). */
function groupExits_(ss, testId, list, trial) {
  var submitted = {};
  if (!trial) {
    var sh = ss.getSheetByName(SESSIONS);
    if (sh && sh.getLastRow() > 1) {
      var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (String(vals[i][1]).trim() === testId && String(vals[i][3]).trim() === ST_SUBMITTED) submitted[String(vals[i][8]).trim()] = true;
      }
    }
  }
  var byTok = {}, order = [];
  list.forEach(function (x) {
    var g = byTok[x.token];
    if (!g) { g = byTok[x.token] = { name: x.name, sid: x.sid, token: x.token, items: [], fsna: false, total: 0,
      blocks: 0, unlocked: 0, engine: '', first: null, done: trial || !!submitted[x.token] }; order.push(g); }
    if (x.engine) g.engine = x.engine;
    if (x.n === 0) { if (x.types.indexOf(EXIT_LABELS.fsna) >= 0) g.fsna = true; return; }
    g.items.push(x);
    g.total += x.dur;
    if (x.blocked) { g.blocks++; if (x.unlockAt) g.unlocked++; }
    if (x.start && (!g.first || x.start < g.first)) g.first = x.start;
  });
  order.forEach(function (g) { g.items.sort(function (a, b) { return a.n - b.n; }); });
  order.sort(function (a, b) {
    var c = a.name.localeCompare(b.name, LOCALE);
    return c || ((a.first ? a.first.getTime() : 0) - (b.first ? b.first.getTime() : 0));
  });
  /* attempt number when a student has several sessions */
  var cnt = {}, seen = {};
  order.forEach(function (g) { cnt[g.sid] = (cnt[g.sid] || 0) + 1; });
  order.forEach(function (g) { seen[g.sid] = (seen[g.sid] || 0) + 1; g.attempt = cnt[g.sid] > 1 ? seen[g.sid] : 0; });
  return order;
}

function exitsSummary_(groups) {
  var ep = 0, studs = {}, fsna = 0;
  groups.forEach(function (g) { ep += g.items.length; if (g.items.length) studs[g.sid] = true; if (g.fsna) fsna++; });
  return { episodes: ep, students: Object.keys(studs).length, fsna: fsna, groups: groups };
}

/** Students who submitted with an old engine version (exits were not logged for them). */
function oldEngineCount_(ss, testId) {
  var sh = ss.getSheetByName(SESSIONS);
  if (!sh || sh.getLastRow() < 2) return 0;
  var cols = Math.min(15, sh.getMaxColumns());
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues();
  var n = 0;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][1]).trim() === testId && String(vals[i][3]).trim() === ST_SUBMITTED && !String(vals[i][14] || '').trim()) n++;
  }
  return n;
}

function exitsLine_(x, trial) {
  if (!x.episodes) return '0';
  if (trial) return x.episodes + ', details in a separate email';
  return x.episodes + ' by ' + x.students + ' ' + (x.students === 1 ? W_().learner : W_().learners) + ', details in a separate email';
}

/** kind: '' (class report) | 'teacher' | 'admin' | 'guest' */
var RUN_LABELS = { teacher: 'Trial run', admin: 'Check', guest: 'Guest run' };

function sendExitsReport_(test, to, x, trial, kind) {
  if (!x || (!x.episodes && !x.fsna) || !to) return;
  var pdf = Utilities.newBlob(exitsHtml_(test, x, trial, kind), 'text/html', test.id + '_exits.html')
    .getAs('application/pdf')
    .setName((kind === 'guest' ? 'Guest_exits_' : (trial ? 'Trial_exits_' : 'Exits_')) + test.id + '.pdf');
  var subject = (trial ? (RUN_LABELS[kind] || 'Trial run') + ', exits: ' : 'Exits from the test: ') +
    test.subject + ', ' + test.className + ' (' + test.id + ')';
  var body =
    '<p>Hello,</p>' +
    '<p>Attached is the report on exits from the page during the test <b>' + esc_(test.subject) + ', ' + esc_(test.className) + '</b>.</p>' +
    '<p>Exits: ' + x.episodes + (trial ? '' : ', ' + W_().learners + ': ' + x.students) + '. The test only records exits; the ' + W_().contact + ' makes any decisions.</p>' +
    '<p>' + SENDER_NAME + '</p>';
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: body, attachments: [pdf], name: SENDER_NAME });
}

function exitsHtml_(t, x, trial, kind) {
  var ALT = '#F3F6F9';
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var fmt = function (d) { return d ? Utilities.formatDate(d, tz, 'dd.MM.yyyy HH:mm') : '...'; };
  var clock = function (d) { return d ? Utilities.formatDate(d, tz, 'HH:mm:ss') : '...'; };
  var th = function (txt) { return '<th bgcolor="#1E2A38"><font color="#FFFFFF">' + txt + '</font></th>'; };
  var alt = function (i) { return i % 2 ? ' class="alt" bgcolor="' + ALT + '"' : ''; };
  var blockText = function (it) {
    if (!it.blocked) return '';
    if (!it.unlockAt) return '<font color="#D9534F">locked, not unlocked</font>';
    var s = it.start ? Math.max(0, Math.round((it.unlockAt.getTime() - it.start.getTime()) / 1000)) : null;
    return 'locked, unlocked' + (s !== null ? ' after ' + fmtTime_(s) : '');
  };
  var gname = function (g) { return esc_(g.name) + (g.attempt ? ' (attempt ' + g.attempt + ')' : ''); };
  var h = [];
  h.push('<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,sans-serif;font-size:11px;color:#1E2A38;}' +
    'h1{font-size:18px;margin:0 0 4px 0;} h2{font-size:14px;margin:18px 0 6px 0;border-bottom:2px solid #1E2A38;padding-bottom:3px;}' +
    'h3{font-size:12px;margin:14px 0 2px 0;}' +
    'table{width:100%;border-collapse:collapse;margin-top:4px;} th{background:#1E2A38;color:#fff;text-align:left;padding:5px;}' +
    'td{padding:5px;border-bottom:1px solid #ddd;vertical-align:top;} tr.alt td{background:#F3F6F9;}' +
    '.muted{color:#6B6B6B;}' +
    '</style></head><body>');
  h.push('<h1>' + (trial ? (RUN_LABELS[kind] || 'Trial run') + ', exits' : 'Exits from the test') + ': ' + esc_(t.subject) + ', ' + esc_(t.className) + '</h1>');
  h.push('<div class="muted">Test ID: ' + esc_(t.id) + ' | Test window: ' + fmt(t.from) + ' - ' + fmt(t.to) +
    ' | Generated: ' + fmt(new Date()) + '</div>');
  h.push('<p>The test records every exit from the page: type, time, duration and the question the ' + W_().learner + ' was on. ' +
    'On every 5th exit the test locks until the ' + W_().contact + '\'s unlock code. The ' + W_().contact + ' makes any decisions about results.</p>');
  h.push('<p class="muted">Types: ' + [EXIT_LABELS.tab, EXIT_LABELS.blur, EXIT_LABELS.narrow, EXIT_LABELS.fs, EXIT_LABELS.close]
    .map(esc_).join('; ') + '. Duration: how long the test page was hidden or unfocused; ' +
    'if the ' + W_().learner + ' only left fullscreen, until they returned to the test.</p>');

  h.push('<h2>1. Summary</h2>');
  h.push('<table><tr>' + th(W_().Learner) + (trial ? '' : th('Submitted')) + th('Exits') + th('Total time') + th('Locks') + '</tr>');
  x.groups.forEach(function (g, i) {
    var bl = g.blocks ? g.blocks + (g.unlocked < g.blocks ? ' (not unlocked: ' + (g.blocks - g.unlocked) + ')' : '') : '0';
    h.push('<tr' + alt(i) + '><td>' + gname(g) + (g.fsna ? '<br><font color="#D9534F">' + EXIT_LABELS.fsna + '</font>' : '') + '</td>' +
      (trial ? '' : '<td>' + (g.done ? YES : '<font color="#D9534F">not submitted</font>') + '</td>') +
      '<td>' + g.items.length + '</td><td>' + fmtTime_(g.total) + '</td><td>' + bl + '</td></tr>');
  });
  h.push('</table>');

  h.push('<h2>2. Exits by ' + W_().learner + '</h2>');
  x.groups.forEach(function (g) {
    if (!g.items.length) return;
    h.push('<h3>' + gname(g) + '</h3>');
    h.push('<div class="muted">' + (trial ? '' : (g.done ? 'Test submitted' : 'Test not submitted') + ' | ') + 'Exits: ' + g.items.length +
      ' | Total time: ' + fmtTime_(g.total) + (g.engine ? ' | Engine version ' + esc_(g.engine) : '') + '</div>');
    h.push('<table><tr>' + th('No.') + th('Started') + th('Duration') + th('Type') + th('Question') + th('Lock') + '</tr>');
    g.items.forEach(function (it, i) {
      h.push('<tr' + alt(i) + '><td>' + it.n + '</td><td>' + clock(it.start) + '</td><td>' + fmtTime_(it.dur) + '</td><td>' +
        esc_(it.types || '...') + '</td><td>' + esc_(it.q || '...') + '</td><td>' + blockText(it) + '</td></tr>');
    });
    h.push('</table>');
  });
  h.push('<p class="muted" style="margin-top:18px">' + SENDER_NAME + '</p></body></html>');
  return h.join('');
}

/* =====================  SCORING  ===================== */

/** Task type from the key format: a dash = matching, digits only = number, anything else = choice. */
function qType_(key) {
  var s = String(key).trim();
  if (s.indexOf('-') > 0) return 'match';
  if (/^\d+(\s*\|\s*\d+)*$/.test(s)) return 'number';
  return 'choice';
}

function parsePairs_(s) {
  var o = {};
  String(s).split(';').forEach(function (p) {
    var i = p.indexOf('-');
    if (i > 0) o[norm_(p.slice(0, i))] = norm_(p.slice(i + 1));
  });
  return o;
}

/**
 * Points for one question. Matching: max points x share of correct pairs; a fractional part above 0.5 rounds up,
 * 0.5 and below rounds down. Correct (1) only when every pair is correct.
 */
function scoreAnswer_(m, ans) {
  var max = (m && m.max) || 1;
  var key = m ? String(m.key) : '';
  if (!key || ans === '') return { ok: false, pts: 0 };
  var type = qType_(key);
  if (type === 'match') {
    var kp = parsePairs_(key), gp = parsePairs_(ans), n = 0, good = 0;
    for (var l in kp) { n++; if (gp[l] && gp[l] === kp[l]) good++; }
    if (!n) return { ok: false, pts: 0 };
    if (good === n) return { ok: true, pts: max };
    var x = max * good / n, fl = Math.floor(x + 1e-9);
    return { ok: false, pts: (x - fl > 0.5 + 1e-9) ? fl + 1 : fl };
  }
  if (type === 'number') {
    var a = String(ans).replace(/\D/g, '');
    var okN = a !== '' && key.split('|').some(function (k) {
      k = k.replace(/\D/g, '');
      return k !== '' && Number(k) === Number(a);
    });
    return { ok: okN, pts: okN ? max : 0 };
  }
  var ok = norm_(ans) === norm_(key);
  return { ok: ok, pts: ok ? max : 0 };
}

/* =====================  SESSIONS AND CODES  ===================== */

function sessionsSheet_(ss) {
  var sh = ss.getSheetByName(SESSIONS);
  if (!sh) {
    sh = ss.insertSheet(SESSIONS);
    sh.getRange(1, 1, 1, 10).setValues([['Class code', 'Test ID', 'Student ID', 'Status', 'Start (ms)', 'Result code',
      'Student', 'Class', 'Token', 'Result']]).setFontWeight('bold');
    sh.getRange('A:A').setNumberFormat('@');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Headers N Unlocks and O Engine in the Sessions sheet. */
function ensureSessionHeaders_(ss) {
  var sh = sessionsSheet_(ss);
  if (!String(sh.getRange(1, 14).getValue()).trim()) {
    sh.getRange(1, 14, 1, 2).setValues([['Unlocks', 'Engine']]).setFontWeight('bold');
  }
}

function setEngine_(ss, row, engine) {
  ensureSessionHeaders_(ss);
  var cell = ss.getSheetByName(SESSIONS).getRange(row, 15);
  cell.setNumberFormat('@');
  cell.setValue(engine);
}

/** A student's session in the Sessions sheet: the row for the pair (Test ID, Student ID). */
function findSession_(ss, testId, studentId) {
  var sh = ss.getSheetByName(SESSIONS);
  if (!sh || sh.getLastRow() < 2) return null;
  var cols = Math.min(15, sh.getMaxColumns());
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues();
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[1]).trim() === testId && String(r[2]).trim() === studentId) {
      return { row: i + 2, status: String(r[3]).trim(), start: Number(r[4]) || 0,
        token: String(r[8]).trim(), result: String(r[9]),
        pauseFrom: Number(r[10]) || 0, pausedSec: Number(r[11]) || 0, pauseN: Number(r[12]) || 0,
        unlocks: Number(r[13]) || 0, engine: String(r[14] === undefined ? '' : r[14]).trim() };
    }
  }
  return null;
}

function randomCode_(avoid) {
  var code;
  do { code = String(100000 + Math.floor(Math.random() * 900000)); }
  while (avoid.indexOf(code) >= 0);
  return code;
}

/** Class code for a test row: one code per class, written to column R of the Tests sheet. */
function genClassCode_(testId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var test = findTest_(ss.getSheetByName(TESTS), testId);
  if (!test) return testId + ': test not found';
  var code = randomCode_([test.teacherCode, test.unlockCode, adminCode_(), guestCode_()]);
  var cell = ss.getSheetByName(TESTS).getRange(test.row, 18);
  cell.setNumberFormat('@');
  cell.setValue(code);
  return testId + ' (' + test.className + '): class code ' + code;
}

/** Unlock code for a test row (column S of the Tests sheet). Never equal to the class code. */
function genUnlockCode_(testId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TESTS);
  var test = findTest_(sheet, testId);
  if (!test) return testId + ': test not found';
  if (!String(sheet.getRange(1, 19).getValue()).trim()) sheet.getRange(1, 19).setValue('Unlock code').setFontWeight('bold');
  var code = randomCode_([test.classCode, test.teacherCode, adminCode_(), guestCode_()]);
  var cell = sheet.getRange(test.row, 19);
  cell.setNumberFormat('@');
  cell.setValue(code);
  return testId + ' (' + test.className + '): unlock code ' + code;
}

/** Lets a student start again (clears their session if the work has not been submitted). */
function reissueSession_(testId, studentId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rec = findSession_(ss, testId, studentId);
  if (!rec) return 'Student ' + studentId + ' has no session in test ' + testId + '; they have not started yet.';
  if (rec.status === ST_SUBMITTED) return 'The work has already been submitted; a new start is not possible.';
  var sh = ss.getSheetByName(SESSIONS);
  sh.getRange(rec.row, 4, 1, 2).clearContent();
  sh.getRange(rec.row, 9).clearContent();
  sh.getRange(rec.row, 11, 1, 5).clearContent(); // pauses, unlocks, engine; exits of the old attempt stay in Exits
  return 'Student ' + studentId + ' can start test ' + testId + ' again.';
}

function makeResultCode_() {
  var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
  for (var i = 0; i < 6; i++) s += abc.charAt(Math.floor(Math.random() * abc.length));
  return s;
}

/* =====================  MENU AND REPORTS  ===================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Assessment')
    .addItem('Send report for a test...', 'menuSendOne')
    .addItem('Send all closed tests', 'menuSendDue')
    .addSeparator()
    .addItem('Generate class code...', 'menuGenCode')
    .addItem('Generate unlock code...', 'menuGenUnlock')
    .addItem('Let a student start again...', 'menuReissue')
    .addSeparator()
    .addItem('Turn on daily reports', 'installDailyTrigger')
    .addToUi();
}

function menuGenCode() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Class code', 'Enter the Test ID (a row of the Tests sheet, e.g. MATH3-01-A). The old class code will be replaced:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  ui.alert(genClassCode_(r.getResponseText().trim()));
}

function menuGenUnlock() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Unlock code', 'Enter the Test ID (a row of the Tests sheet, e.g. MATH3-01-A). The old unlock code will be replaced:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  ui.alert(genUnlockCode_(r.getResponseText().trim()));
}

function menuReissue() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Start again', 'Enter the Test ID and Student ID separated by a space, e.g. MATH3-01-A S3A01:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var p = r.getResponseText().trim().split(/\s+/);
  ui.alert(p.length === 2 ? reissueSession_(p[0], p[1]) : 'Two values are needed: Test ID and Student ID.');
}

function menuSendOne() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Report for a test', 'Enter the Test ID (as in the Tests sheet):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  ui.alert(sendReport_(r.getResponseText().trim()));
}

function menuSendDue() {
  var log = sendDueReports();
  SpreadsheetApp.getUi().alert(log.length ? log.join('\n') : 'No closed tests are waiting for a report.');
}

/** Reports for every test whose "Open until" has passed, that has a teacher email and no report sent yet. */
function sendDueReports() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TESTS);
  var values = sheet.getDataRange().getValues();
  var now = new Date();
  var log = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var id = String(r[0]).trim();
    if (!id || !(r[5] instanceof Date) || now <= r[5]) continue;
    if (!String(r[9]).trim() || r[10] === true) continue;
    log.push(sendReport_(id));
  }
  return log;
}

/** Daily time-driven trigger: runs sendDueReports once a day around DAILY_HOUR (spreadsheet time zone). */
function installDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendDueReports') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('sendDueReports').timeBased().everyDays(1).atHour(DAILY_HOUR).create();
  try {
    SpreadsheetApp.getUi().alert('Daily reports are on (around ' + DAILY_HOUR + ':00).');
  } catch (e) { /* run from the editor */ }
}

function sendReport_(testId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var testsSheet = ss.getSheetByName(TESTS);
  var test = findTest_(testsSheet, testId);
  if (!test) return testId + ': test not found';
  if (!test.teacherEmail) return testId + ': no teacher email';

  var report = buildReport_(ss, testId, test);
  if (!report.participants) return testId + ': no submissions with status ok';
  /* exits (all student sessions, including unsubmitted) and old engine versions */
  var exits = exitsSummary_(groupExits_(ss, testId, readExits_(ss, testId, ''), false));
  report.exits = exits;
  report.oldEngine = oldEngineCount_(ss, testId);

  var html = reportHtml_(report);
  var pdf = Utilities.newBlob(html, 'text/html', testId + '.html')
    .getAs('application/pdf')
    .setName('Report_' + testId + '.pdf');

  var subject = 'Test results: ' + test.subject + ', ' + test.className + ' (' + testId + ')';
  var body =
    '<p>Hello,</p>' +
    '<p>Attached is the report for the test <b>' + esc_(test.subject) + ', ' + esc_(test.className) + '</b>.</p>' +
    '<p>Participants: ' + report.participants +
    (test.primary ? '' : '. Average result: ' + pct_(report.avgPct)) +
    '. Suggested ' + W_().group + ' level: ' + esc_(report.classLevel.name) + '.</p>' +
    '<p>Exits from the test: ' + exitsLine_(exits, false) + '.</p>' +
    '<p>' + SENDER_NAME + '</p>';

  MailApp.sendEmail({ to: test.teacherEmail, subject: subject, htmlBody: body, attachments: [pdf], name: SENDER_NAME });
  testsSheet.getRange(test.row, 11).setValue(true);
  var note = '';
  try { sendExitsReport_(test, test.teacherEmail, exits, false, ''); if (exits.episodes || exits.fsna) note = ' + exits report'; }
  catch (err) { note = ' (exits report not sent: ' + err + ')'; }
  return testId + ': report sent to ' + test.teacherEmail + note;
}

/** Report for one trial run (kind: teacher, admin or guest), plus the exits of that run and a separate PDF if there
    were any. Teacher runs go to the teacher and TRIAL_CC; check and guest runs go to TRIAL_CC only. */
function sendTrialReport_(ss, test, rows, kind, token) {
  var cc = trialCc_();
  var to = (kind === 'teacher' ? [test.teacherEmail, cc] : [cc]).filter(function (x) { return !!x; });
  if (!to.length) return;
  var report = aggregateReport_(ss, test.id, test, rows);
  report.trial = true;
  report.kind = kind;
  var exits = exitsSummary_(groupExits_(ss, test.id, token ? readExits_(ss, test.id, token) : [], true));
  report.exits = exits;
  var pdf = Utilities.newBlob(reportHtml_(report), 'text/html', test.id + '.html')
    .getAs('application/pdf')
    .setName((kind === 'guest' ? 'Guest_report_' : 'Trial_report_') + test.id + '.pdf');
  var subject = RUN_LABELS[kind] + ': ' + test.subject + ', ' + test.className + ' (' + test.id + ')';
  var intro = kind === 'guest'
    ? 'This is a report on one guest run of the public demo test <b>' + esc_(test.subject) + ', ' + esc_(test.className) + '</b>.'
    : 'This is a trial report after a ' + (kind === 'admin' ? 'administrator check' : W_().contact + ' trial run') +
      ' of the test <b>' + esc_(test.subject) + ', ' + esc_(test.className) + '</b>.';
  var body =
    '<p>Hello,</p>' +
    '<p>' + intro + '</p>' +
    '<p>This is how the report will look after the ' + W_().group + ' takes the test. ' +
    (kind === 'guest' ? 'Guest runs' : 'Trial runs') + ' are not included in ' + W_().group + ' statistics.</p>' +
    '<p>' + SENDER_NAME + '</p>';
  MailApp.sendEmail({ to: to.join(','), subject: subject, htmlBody: body, attachments: [pdf], name: SENDER_NAME });
  sendExitsReport_(test, to.join(','), exits, true, kind);
}

function buildReport_(ss, testId, test) {
  var resp = ss.getSheetByName(RESPONSES);
  var last = resp ? resp.getLastRow() : 0;
  var all = last > 1 ? resp.getRange(2, 1, last - 1, Math.min(18, resp.getMaxColumns())).getValues() : [];
  var rows = all.filter(function (r) { return r[2] === testId && r[10] === 'ok'; });
  return aggregateReport_(ss, testId, test, rows);
}

/** Report data from already selected Responses rows. */
function aggregateReport_(ss, testId, test, rows) {
  var levels = readLevels_(ss.getSheetByName(LEVELS));
  var key = readQuestions_(ss.getSheetByName(QUESTIONS), test.bank);
  var meta = key.map;

  var bySubmission = {};
  var students = {};
  var byQuestion = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var sid = r[1];
    if (!bySubmission[sid]) bySubmission[sid] = 0;
    bySubmission[sid] += Number(r[9]) || 0;

    var q = String(r[6]);
    if (!students[sid]) {
      var ts = r[15];
      students[sid] = { name: String(r[5]), total: 0, answers: {},
        time: (ts === '' || ts === null || ts === undefined || isNaN(Number(ts))) ? null : Number(ts),
        pausedSec: Number(r[16]) || 0, pauseN: Number(r[17]) || 0 };
    }
    students[sid].total += Number(r[9]) || 0;
    students[sid].answers[q] = { points: Number(r[9]) || 0, correct: Number(r[8]) === 1 };

    if (!byQuestion[q]) byQuestion[q] = { n: 0, correct: 0, points: 0, wrong: {} };
    var bq = byQuestion[q];
    bq.n++;
    bq.correct += Number(r[8]) || 0;
    bq.points += Number(r[9]) || 0;
    if (!Number(r[8])) {
      var ans = String(r[7]).trim() || '(no answer)';
      bq.wrong[ans] = (bq.wrong[ans] || 0) + 1;
    }
  }

  var totals = [];
  for (var s in bySubmission) totals.push(bySubmission[s]);
  var n = totals.length;
  var max = test.max || sumMax_(key);
  var sum = 0, mn = Infinity, mx = -Infinity;
  for (var t = 0; t < n; t++) { sum += totals[t]; mn = Math.min(mn, totals[t]); mx = Math.max(mx, totals[t]); }
  var avg = n ? sum / n : 0;
  var avgPct = max ? avg / max : 0;

  var distribution = levels.map(function (l) { return { name: l.name, scale: l.scale, count: 0 }; });
  for (var k = 0; k < n; k++) distribution[levelIdx_(test, levels, totals[k], max)].count++;

  /* difficulty levels from the Questions sheet (F). When present, questions are sorted by level first. */
  var lvlOf = function (q) { return (meta[q] && meta[q].lvl) || ''; };
  var qKeys = Object.keys(byQuestion).sort(function (a, b) {
    var la = lvlOf(a), lb = lvlOf(b);
    if (la !== lb) return lvlCmp_(la, lb);
    var na = parseFloat(a), nb = parseFloat(b);
    return (isNaN(na) || isNaN(nb)) ? a.localeCompare(b) : na - nb;
  });
  var lvlList = [];
  qKeys.forEach(function (q) { var l = lvlOf(q); if (l && lvlList.indexOf(l) < 0) lvlList.push(l); });
  var lvlGroups = lvlList.map(function (l) {
    return { lvl: l, keys: qKeys.filter(function (q) { return lvlOf(q) === l; }) };
  });
  var noLvl = qKeys.filter(function (q) { return !lvlOf(q); });
  if (lvlList.length && noLvl.length) lvlGroups.push({ lvl: '', keys: noLvl });

  var questions = qKeys.map(function (q) {
    var bq = byQuestion[q];
    var m = meta[q] || {};
    var topWrong = '', topCount = 0;
    for (var w in bq.wrong) if (bq.wrong[w] > topCount) { topWrong = w; topCount = bq.wrong[w]; }
    var share = bq.n ? bq.correct / bq.n : 0;
    return { q: q, lvl: m.lvl || '', outcome: m.outcome || '', max: m.max || 0, n: bq.n, share: share,
      avgPoints: bq.n ? bq.points / bq.n : 0, topWrong: topWrong, topWrongCount: topCount,
      verdict: levels[pctIdx_(levels, share)].verdict };
  });

  var outcomeMap = {}, outcomeOrder = [];
  questions.forEach(function (q) {
    var okey = q.outcome || '(no learning outcome set)';
    if (!outcomeMap[okey]) { outcomeMap[okey] = { outcome: okey, qs: [], points: 0, maxPoints: 0, correct: 0, n: 0 }; outcomeOrder.push(okey); }
    var o = outcomeMap[okey];
    o.qs.push(q.q);
    o.correct += q.share * q.n;
    o.n += q.n;
    if (q.max) { o.points += q.avgPoints; o.maxPoints += q.max; }
  });
  var outcomes = outcomeOrder.map(function (okey) {
    var o = outcomeMap[okey];
    var share = o.maxPoints ? o.points / o.maxPoints : (o.n ? o.correct / o.n : 0);
    return { outcome: okey, qs: o.qs.join(', '), share: share, verdict: levels[pctIdx_(levels, share)].verdict };
  });

  var studentList = [], timeSum = 0, timeN = 0;
  for (var sk in students) {
    var st = students[sk];
    var li = levelIdx_(test, levels, st.total, max);
    var byLvl = {};
    lvlGroups.forEach(function (g) {
      var got = 0, mxl = 0, okN = 0;
      g.keys.forEach(function (q) {
        mxl += (meta[q] && meta[q].max) || 1;
        var a = st.answers[q];
        if (a) { got += a.points; if (a.correct) okN++; }
      });
      byLvl[g.lvl] = { got: got, max: mxl, ok: okN, n: g.keys.length };
    });
    if (st.time !== null) { timeSum += st.time; timeN++; }
    studentList.push({ name: st.name, total: st.total, share: max ? st.total / max : 0,
      score12: to12_(test, levels, st.total, max), level: levels[li].name, answers: st.answers,
      byLvl: byLvl, time: st.time, pausedSec: st.pausedSec, pauseN: st.pauseN });
  }
  studentList.sort(function (a, b) { return a.name.localeCompare(b.name, LOCALE); });

  return {
    testId: testId, test: test, students: studentList, questionKeys: qKeys, participants: n,
    avg: avg, min: n ? mn : 0, maxScore: n ? mx : 0, avgPct: avgPct,
    score12: to12_(test, levels, avg, max),
    classLevel: levels[levelIdx_(test, levels, avg, max)],
    distribution: distribution, outcomes: outcomes, questions: questions, generated: new Date(),
    lvlGroups: lvlList.length ? lvlGroups : [], avgTime: timeN ? timeSum / timeN : null
  };
}

function reportHtml_(r) {
  var t = r.test;
  var P = !!t.primary; // primary school: levels only, no points
  var W = W_(), S12 = W.school; // the 1-12 scale is a school grade; left out when LEARNER_LABEL is set
  var ALT = '#F3F6F9', OK = '#D5F0DF', BAD = '#F8DAD8';
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var fmt = function (d) { return d ? Utilities.formatDate(d, tz, 'dd.MM.yyyy HH:mm') : '...'; };
  var th = function (txt, center) {
    return '<th bgcolor="#1E2A38"' + (center ? ' style="text-align:center"' : '') + '><font color="#FFFFFF">' + txt + '</font></th>';
  };
  var alt = function (i) { return i % 2 ? ' class="alt" bgcolor="' + ALT + '"' : ''; };
  var h = [];
  h.push('<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,sans-serif;font-size:11px;color:#1E2A38;}' +
    'h1{font-size:18px;margin:0 0 4px 0;} h2{font-size:14px;margin:18px 0 6px 0;border-bottom:2px solid #1E2A38;padding-bottom:3px;}' +
    'table{width:100%;border-collapse:collapse;margin-top:4px;} th{background:#1E2A38;color:#fff;text-align:left;padding:5px;}' +
    'td{padding:5px;border-bottom:1px solid #ddd;vertical-align:top;} tr.alt td{background:#F3F6F9;}' +
    '.muted{color:#6B6B6B;} .kpi td{border:none;padding:3px 10px 3px 0;} .big{font-size:16px;font-weight:bold;}' +
    '</style></head><body>');

  var LV = r.lvlGroups || [];
  var hasLvl = LV.length > 0;
  var lvlColor = function (l) {
    for (var i = 0; i < LV.length; i++) if (LV[i].lvl === l) return LVL_COLORS[i] || LVL_GREY;
    return LVL_GREY;
  };
  var lvlName = function (l) { return l === '' ? 'No level' : (/^\d+$/.test(String(l)) ? 'Level ' + l : String(l)); };
  var thL = function (txt, l) {
    var c = lvlColor(l);
    return '<th bgcolor="' + c[0] + '" style="text-align:center;background:' + c[0] + '"><font color="' + c[1] + '">' + txt + '</font></th>';
  };

  var runName = r.kind === 'guest' ? 'Guest run' : (r.kind === 'admin' ? 'Administrator check' : W.Contact + ' trial run');
  h.push('<h1>' + (r.trial ? (r.kind === 'guest' ? 'Guest run report' : 'Trial report') : 'Test report') + ': ' +
    esc_(t.subject) + ', ' + esc_(t.className) + '</h1>');
  if (r.trial) h.push('<p><font color="#D9534F"><b>' + runName + '.</b></font> This is how the report will look after the ' + W.group + ' takes the test. ' +
    'This run is not included in ' + W.group + ' statistics.</p>');
  h.push('<div class="muted">Test ID: ' + esc_(r.testId) +
    (t.quarter ? ' | Term: ' + esc_(t.quarter) : '') +
    ' | Test window: ' + fmt(t.from) + ' - ' + fmt(t.to) +
    ' | Generated: ' + fmt(r.generated) + '</div>');

  h.push('<h2>1. Overall results</h2><table class="kpi">');
  h.push('<tr><td>Participants</td><td class="big">' + r.participants + '</td></tr>');
  if (r.avgTime !== null && r.avgTime !== undefined) h.push('<tr><td>Average time</td><td>' + fmtTime_(r.avgTime) + (t.durationMin ? ' of ' + t.durationMin + ' min' : '') + '</td></tr>');
  if (!P) {
    h.push('<tr><td>Average score</td><td class="big">' + num_(r.avg) + (t.max ? ' of ' + t.max : '') + ' (' + pct_(r.avgPct) + ')</td></tr>');
    h.push('<tr><td>Minimum / maximum</td><td>' + num_(r.min) + ' / ' + num_(r.maxScore) + '</td></tr>');
    if (S12) h.push('<tr><td>Average on the 1-12 scale</td><td>' + r.score12 + '</td></tr>');
    h.push('<tr><td>Suggested ' + W.group + ' level</td><td class="big">' + esc_(r.classLevel.name) + (S12 ? ' (' + esc_(r.classLevel.scale) + ')' : '') + '</td></tr>');
  } else {
    h.push('<tr><td>Suggested ' + W.group + ' level</td><td class="big">' + esc_(r.classLevel.name) + '</td></tr>');
  }
  /* exits in one line; details in a separate email, only if there were any */
  if (r.exits) h.push('<tr><td>Exits from the test</td><td>' + esc_(exitsLine_(r.exits, r.trial)) + '</td></tr>');
  if (r.oldEngine) h.push('<tr><td></td><td><font color="#D9534F">Note: ' + r.oldEngine + ' ' + (r.oldEngine === 1 ? W.learner : W.learners) +
    ' took the test on an old version of the page; their exits may not have been logged.</font></td></tr>');
  h.push('</table>');

  h.push('<table><tr>' + th('Level') + (P || !S12 ? '' : th('Scale (1-12)')) + th(W.Learners) + th('Share') + '</tr>');
  r.distribution.forEach(function (d, i) {
    h.push('<tr' + alt(i) + '><td>' + esc_(d.name) + '</td>' + (P || !S12 ? '' : '<td>' + esc_(d.scale) + '</td>') +
      '<td>' + d.count + '</td><td>' + pct_(r.participants ? d.count / r.participants : 0) + '</td></tr>');
  });
  h.push('</table>');

  h.push('<h2>2. Learning outcomes</h2>');
  h.push('<table><tr>' + th('Learning outcome') + th('Questions') + th('Mastery') + th('Verdict') + '</tr>');
  r.outcomes.forEach(function (o, i) {
    h.push('<tr' + alt(i) + '><td>' + esc_(o.outcome) + '</td><td>' + esc_(o.qs) +
      '</td><td>' + pct_(o.share) + '</td><td>' + esc_(o.verdict) + '</td></tr>');
  });
  h.push('</table>');

  h.push('<h2>3. Question analysis</h2>');
  h.push('<table><tr>' + th('No.') + (hasLvl ? th('Level') : '') + th('Learning outcome') + th('Correct') + (P ? '' : th('Avg. points')) + th('Most common wrong answer') + '</tr>');
  r.questions.forEach(function (q, i) {
    var lc = lvlColor(q.lvl);
    h.push('<tr' + alt(i) + '><td' + (hasLvl ? ' bgcolor="' + lc[2] + '" style="background:' + lc[2] + '"' : '') + '>' + esc_(q.q) + '</td>' +
      (hasLvl ? '<td>' + esc_(lvlName(q.lvl)) + '</td>' : '') + '<td>' + esc_(q.outcome || '...') +
      '</td><td>' + pct_(q.share) + ' (' + Math.round(q.share * q.n) + ' of ' + q.n + ')</td>' +
      (P ? '' : '<td>' + num_(q.avgPoints) + (q.max ? ' of ' + q.max : '') + '</td>') +
      '<td>' + (q.topWrong ? esc_(q.topWrong) + ' (' + q.topWrongCount + ')' : '...') + '</td></tr>');
  });
  h.push('</table>');

  h.push('<h2>4. ' + W.Learner + ' results</h2>');
  var lvlHead = '';
  LV.forEach(function (g) { lvlHead += thL(esc_(lvlName(g.lvl)), g.lvl); });
  h.push('<table><tr>' + th(W.Learner) + lvlHead + (P ? '' : th('Score') + th('%') + (S12 ? th('1-12') : '')) + th('Level') + th('Time') + '</tr>');
  r.students.forEach(function (s, i) {
    var lvlCells = '';
    LV.forEach(function (g) {
      var b = s.byLvl[g.lvl] || { got: 0, max: 0, ok: 0, n: 0 };
      var c = lvlColor(g.lvl);
      lvlCells += '<td align="center" bgcolor="' + c[2] + '" style="text-align:center;background:' + c[2] + '">' +
        (P ? b.ok + ' of ' + b.n : num_(b.got) + ' / ' + num_(b.max)) + '</td>';
    });
    var pauseMark = s.pauseN ? '<br><font color="#D9534F">interrupted by a pause' + (s.pauseN > 1 ? ' (' + s.pauseN + ' times)' : '') +
      ', ' + Math.max(1, Math.round(s.pausedSec / 60)) + ' min</font>' : '';
    h.push('<tr' + alt(i) + '><td>' + esc_(s.name) + pauseMark + '</td>' + lvlCells +
      (P ? '' : '<td>' + num_(s.total) + (t.max ? ' of ' + t.max : '') + '</td><td>' + pct_(s.share) + '</td>' + (S12 ? '<td>' + s.score12 + '</td>' : '')) +
      '<td>' + esc_(s.level) + '</td><td>' + fmtTime_(s.time) + '</td></tr>');
  });
  h.push('</table>');

  h.push('<h2>5. ' + W.Learner + ' results by question</h2>');
  h.push('<p class="muted">' + (P ? 'Each cell shows + (correct) or x (wrong or skipped).' :
    'Each cell shows the ' + W.learner + '\'s points for the question. Wrong or skipped answers are red and marked x; ' +
    'partial credit for matching is marked x too.') +
    (hasLvl ? ' Questions are grouped by difficulty: level 1 in blue, level 2 in green, level 3 in yellow.' : '') + '</p>');
  var CHUNK = 15;
  var groups = hasLvl ? LV : [{ lvl: null, keys: r.questionKeys }];
  groups.forEach(function (g) {
    for (var c = 0; c < g.keys.length; c += CHUNK) {
      var keys = g.keys.slice(c, c + CHUNK);
      var colc = g.lvl === null ? null : lvlColor(g.lvl);
      var head = '<tr>' + th(W.Learner);
      keys.forEach(function (k) { head += colc ? thL(esc_(k), g.lvl) : th(esc_(k), true); });
      var totLabel = g.lvl === null ? 'Total' : 'Level total';
      head += colc ? thL(totLabel, g.lvl) : (P ? '' : th(totLabel, true));
      var cap = '';
      if (colc) {
        cap = '<tr><td colspan="' + (keys.length + 2) + '" bgcolor="' + colc[0] + '" style="background:' + colc[0] +
          ';border-top:4px solid ' + colc[0] + '"><font color="' + colc[1] + '"><b>' + esc_(lvlName(g.lvl)) +
          '</b> (questions ' + esc_(keys.join(', ')) + ')</font></td></tr>';
      }
      h.push('<table style="margin-top:10px">' + cap + head + '</tr>');
      r.students.forEach(function (s, i) {
        var row = '<tr' + alt(i) + '><td>' + esc_(s.name) + '</td>';
        keys.forEach(function (k) {
          var a = s.answers[k];
          if (!a) { row += '<td></td>'; return; }
          var bg = a.correct ? (colc ? colc[2] : OK) : BAD;
          var val = P ? (a.correct ? '+' : '<font color="#C0392B"><b>x</b></font>')
            : (a.correct ? num_(a.points) : '<font color="#C0392B"><b>' + num_(a.points) + ' x</b></font>');
          row += '<td align="center" bgcolor="' + bg + '" style="text-align:center;background:' + bg + '">' + val + '</td>';
        });
        if (colc) {
          var b2 = s.byLvl[g.lvl] || { got: 0, max: 0, ok: 0, n: 0 };
          row += '<td align="center" style="text-align:center"><b>' + (P ? b2.ok + ' of ' + b2.n : num_(b2.got) + ' / ' + num_(b2.max)) + '</b></td>';
        } else if (!P) {
          row += '<td style="text-align:center"><b>' + num_(s.total) + '</b></td>';
        }
        h.push(row + '</tr>');
      });
      h.push('</table>');
    }
  });

  h.push('<p class="muted" style="margin-top:18px">' + (r.trial ? 'This report covers one ' + runName.toLowerCase() + '.' :
    'Only accepted submissions are counted. ' + W.Contact + ' trial runs, guest runs, repeated and invalid submissions are excluded.') + '</p>');
  h.push('<p class="muted">' + SENDER_NAME + '</p></body></html>');
  return h.join('');
}

/* =====================  LEVELS  ===================== */

function readLevels_(sheet) {
  var values = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue;
    list.push({ name: String(values[i][0]).trim(), from: (Number(values[i][1]) || 0) / 100,
      scale: values[i][2] instanceof Date ? '' : String(values[i][2]).trim(), verdict: String(values[i][3]) });
  }
  list.sort(function (a, b) { return a.from - b.from; });
  for (var k = 0; k < list.length; k++) {
    if (!list[k].scale) list[k].scale = (k * 3 + 1) + '-' + (k * 3 + 3);
  }
  return list;
}

/** Level index from a share (shared thresholds from the Levels sheet). */
function pctIdx_(levels, share) {
  var idx = 0;
  for (var i = 0; i < levels.length; i++) if (share >= levels[i].from - 1e-9) idx = i;
  return idx;
}

/** Level index for a test: its own thresholds (in points) or the shared ones (in percent). */
function levelIdx_(test, levels, pts, max) {
  var th = test.thresholds;
  if (th && th.length === levels.length - 1) {
    var idx = 0;
    for (var i = 0; i < th.length; i++) if (pts >= th[i] - 1e-9) idx = i + 1;
    return idx;
  }
  return pctIdx_(levels, max ? pts / max : 0);
}

/** 1-12 scale: each level spans 3 points; the position inside the level decides 1, 2 or 3 of them. */
function to12_(test, levels, pts, max) {
  var i = levelIdx_(test, levels, pts, max);
  var th = test.thresholds;
  var lo, hi, x = pts;
  if (th && th.length === levels.length - 1) {
    lo = i === 0 ? 0 : th[i - 1];
    hi = i < th.length ? th[i] : max + 1;
  } else {
    x = max ? pts / max : 0;
    lo = levels[i].from;
    hi = i + 1 < levels.length ? levels[i + 1].from : 1.0000001;
  }
  var step = hi > lo ? Math.min(2, Math.floor(3 * (x - lo) / (hi - lo) + 1e-9)) : 0;
  return Math.max(1, Math.min(12, i * 3 + 1 + step));
}

/* =====================  HELPERS  ===================== */

/** Questions sheet: question order, learning outcome, max points, key, level. */
function readQuestions_(sheet, bank) {
  var values = sheet.getDataRange().getValues();
  var map = {}, order = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() !== bank) continue;
    var q = String(values[i][1]).trim();
    if (!q) continue;
    map[q] = { outcome: String(values[i][2]).trim(), max: Number(values[i][3]) || 0,
      key: String(values[i][4] === undefined ? '' : values[i][4]).trim(),
      lvl: String(values[i][5] === undefined || values[i][5] === null ? '' : values[i][5]).trim() };
    order.push(q);
  }
  return { map: map, order: order };
}

function lvlCmp_(a, b) {
  if (a === '') return 1;
  if (b === '') return -1;
  var na = parseFloat(a), nb = parseFloat(b);
  return (isNaN(na) || isNaN(nb)) ? String(a).localeCompare(String(b)) : na - nb;
}

/** Time as m:ss. */
function fmtTime_(sec) {
  if (sec === null || sec === undefined || sec === '' || isNaN(Number(sec))) return '...';
  sec = Math.round(Number(sec));
  return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
}

function sumMax_(key) {
  var s = 0;
  key.order.forEach(function (q) { s += key.map[q].max || 1; });
  return s;
}

function g_(r, i) { return r[i] === undefined || r[i] === null ? '' : r[i]; }

function parseThresholds_(v) {
  var s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null;
  var parts = s.split(/[;,\s]+/).filter(function (x) { return x !== ''; }).map(Number);
  for (var i = 0; i < parts.length; i++) if (isNaN(parts[i])) return null;
  return parts.length ? parts : null;
}

function testFromRow_(r, rowNum) {
  var id = String(g_(r, 0)).trim();
  return {
    row: rowNum,
    id: id,
    className: String(g_(r, 1)).trim(),
    subject: String(g_(r, 2)).trim(),
    max: Number(g_(r, 3)) || 0,
    from: g_(r, 4) instanceof Date ? r[4] : null,
    to: g_(r, 5) instanceof Date ? r[5] : null,
    active: g_(r, 6) === true,
    quarter: String(g_(r, 8)).trim(),
    teacherEmail: String(g_(r, 9)).trim(),
    reportSent: g_(r, 10) === true,
    primary: g_(r, 11) === true,
    thresholds: parseThresholds_(g_(r, 12)),
    durationMin: Number(g_(r, 13)) || DEFAULT_DURATION_MIN,
    version: String(g_(r, 14)).trim(),
    teacherCode: String(g_(r, 15)).trim(),
    bank: String(g_(r, 16)).trim() || id,
    classCode: String(g_(r, 17)).trim(),
    unlockCode: String(g_(r, 18)).trim()
  };
}

function testOpen_(test, now) {
  if (!test.active) return 'inactive';
  if ((test.from && now < test.from) || (test.to && now > test.to)) return 'outside window';
  return 'ok';
}

function findTest_(sheet, testId) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(g_(values[i], 0)).trim() === testId) return testFromRow_(values[i], i + 1);
  }
  return null;
}

function findStudent_(sheet, studentId) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (String(r[0]).trim() === studentId) {
      return { className: String(r[1]).trim(), name: String(r[2]).trim(), active: r[3] === true };
    }
  }
  return null;
}

function rosterFor_(sheet, className) {
  var values = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (r[3] === true && norm_(r[1]) === norm_(className) && String(r[0]).trim()) {
      list.push({ id: String(r[0]).trim(), name: String(r[2]).trim() });
    }
  }
  list.sort(function (a, b) { return a.name.localeCompare(b.name, LOCALE); });
  return list;
}

function alreadySubmitted_(resp, testId, studentId) {
  if (!resp) return false;
  var last = resp.getLastRow();
  if (last < 2) return false;
  var values = resp.getRange(2, 3, last - 1, 10).getValues(); // C..L
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === testId && String(values[i][9]) === studentId && values[i][8] === 'ok') return true;
  }
  return false;
}

function parseJson_(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** Trims, caps length and neutralises formula injection (=, +, -, @ at the start). */
function clean_(v, maxLen) {
  if (v === undefined || v === null) return '';
  var s = String(v).trim();
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s.slice(0, maxLen);
}

function norm_(v) { return String(v).toLowerCase().replace(/\s+/g, '').trim(); }

function esc_(v) {
  return String(v).replace(/^'/, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct_(x) { return Math.round((x || 0) * 100) + '%'; }

function num_(x) { return String(Math.round((x || 0) * 10) / 10); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}