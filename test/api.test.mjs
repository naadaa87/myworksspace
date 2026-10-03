/* 서버 API 통합 테스트 — node:sqlite로 D1을 흉내 내어 실제 흐름을 검증 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(new URL('../functions/api/[[route]].js', import.meta.url).pathname).href);
const onRequest = mod.onRequest;

/* ---------- D1 셰임 ---------- */
class Stmt {
  constructor(st) { this.st = st; this.args = []; }
  bind(...a) { const c = new Stmt(this.st); c.args = a.map(v => v === undefined ? null : v); return c; }
  async first() { const r = this.st.get(...this.args); return r === undefined ? null : r; }
  async all() { return { results: this.st.all(...this.args) }; }
  async run() { const info = this.st.run(...this.args); return { success: true, meta: info }; }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db.prepare(sql)); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const raw = new DatabaseSync(':memory:');
const DB = new D1(raw);

/* ---------- 호스트 DB 셰임 (ssople-host 모사: 컬럼명이 달라도 자동 매핑되는지 검증) ---------- */
const hraw = new DatabaseSync(':memory:');
hraw.exec(`CREATE TABLE reservations(
  id INTEGER PRIMARY KEY, branch_code TEXT, space_name TEXT,
  use_date TEXT, slot TEXT, start_time TEXT, end_time TEXT,
  customer_name TEXT, phone TEXT, total_amount INTEGER, status TEXT, memo TEXT)`);
const HOSTDB = new D1(hraw);
async function callH(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const req = new Request('http://local' + '/api' + path, {
    method, headers, body: body != null ? JSON.stringify(body) : undefined
  });
  const res = await onRequest({ request: req, env: { DB, HOSTDB } });
  let j = null; try { j = await res.json(); } catch (e) {}
  return { status: res.status, j };
}

/* ---------- 요청 헬퍼 ---------- */
async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const req = new Request('http://local' + '/api' + path, {
    method, headers, body: body != null ? JSON.stringify(body) : undefined
  });
  const res = await onRequest({ request: req, env: { DB } });
  let j = null; try { j = await res.json(); } catch (e) {}
  return { status: res.status, j };
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* =====================================================================
   0) 스키마 미실행 상태
   ===================================================================== */
console.log('\n[0] 스키마 미실행');
{
  const r = await call('GET', '/health');
  ok(r.status === 200 && r.j.ok === false && r.j.needSchema === true, 'health → needSchema', r.j);
}

raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); // 재실행 안전성
raw.exec(fs.readFileSync(new URL('../upgrade_v2.sql', import.meta.url), 'utf8')); // 기존 사용자용 업그레이드 SQL
raw.exec(fs.readFileSync(new URL('../upgrade_v2.sql', import.meta.url), 'utf8')); // 재실행 안전성
console.log('\n[1] 스키마 적용(2회 실행) + 시드');
{
  const n = t => raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  ok(n('branches') === 5, '지점 5');
  ok(n('check_items') === 26, '체크 항목 26(공통 20 + 게임 6)');
  ok(n('channels') === 55, '채널 55');
  const st = raw.prepare("SELECT v FROM app_settings WHERE k='settings'").get();
  const s = JSON.parse(st.v);
  ok(s.times.night[0] === '19:00' && s.mid_deadline === '18:30' && s.quick_items.length === 5, '기본 설정 JSON');
  const r = await call('GET', '/health');
  ok(r.j.ok === true && r.j.needSetup === true, 'health → needSetup');
}

/* =====================================================================
   2) 초기 설정 · 로그인
   ===================================================================== */
console.log('\n[2] 초기 설정 · 로그인');
let ownerTok, mgrTok = null, workerTok, facTok;
{
  let r = await call('POST', '/setup', { body: { name: '최시준', username: 'ceo', password: 'test1234' } });
  ok(r.status === 200 && r.j.token && r.j.user.role === 'owner', '대표 계정 생성', r.j);
  ownerTok = r.j.token;
  const row = raw.prepare("SELECT pw FROM users WHERE username='ceo'").get();
  ok(/^pbkdf2\$10000\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(row.pw), '비밀번호 PBKDF2 해시 저장');

  r = await call('POST', '/setup', { body: { name: 'x', username: 'x', password: 'xxxxxx' } });
  ok(r.status === 400 && /이미 초기 설정/.test(r.j.error), '재설정 차단');

  r = await call('GET', '/health');
  ok(r.j.ok === true && r.j.needSetup === false, 'health → 설정 완료');

  r = await call('POST', '/login', { body: { username: 'ceo', password: 'wrong!' } });
  ok(r.status === 400 && /올바르지 않습니다/.test(r.j.error), '잘못된 비밀번호 400(401 아님)');

  r = await call('POST', '/login', { body: { username: 'ceo', password: 'test1234' } });
  ok(r.status === 200 && r.j.token, '로그인');
  ownerTok = r.j.token;

  r = await call('GET', '/bootstrap');
  ok(r.status === 401, '토큰 없이 401');
}

/* =====================================================================
   3) bootstrap · 계정 발급
   ===================================================================== */
console.log('\n[3] bootstrap · 계정');
let BR;
{
  let r = await call('GET', '/bootstrap', { token: ownerTok });
  BR = r.j.branches;
  ok(BR.length === 5 && BR[0].name === '신촌 어반홀리' && BR[4].id === 'br-gundae', 'bootstrap 지점 정렬', BR.map(b => b.name));
  ok(r.j.check_items.length === 26 && r.j.settings.clean_before_min === 30, 'bootstrap 항목·설정');
  ok(Array.isArray(r.j.user.branch_ids), 'branch_ids 배열 복원');

  r = await call('POST', '/users', { token: ownerTok, body: { name: '김철수', username: 'chulsoo', password: 'pw123456', role: 'worker', branch_ids: ['br-urban', 'br-restel'] } });
  ok(r.status === 200 && r.j.user.branch_ids.length === 2, '근무자 계정 생성', r.j);
  r = await call('POST', '/users', { token: ownerTok, body: { name: '중복', username: 'chulsoo', password: 'pw123456', role: 'worker' } });
  ok(/이미 사용 중/.test(r.j.error), '아이디 중복 차단');
  r = await call('POST', '/users', { token: ownerTok, body: { name: '박시설', username: 'fac1', password: 'pw123456', role: 'facility', branch_ids: [] } });
  ok(r.status === 200, '시설 계정 생성');

  let w = await call('POST', '/login', { body: { username: 'chulsoo', password: 'pw123456' } });
  workerTok = w.j.token;
  let f = await call('POST', '/login', { body: { username: 'fac1', password: 'pw123456' } });
  facTok = f.j.token;
  ok(!!workerTok && !!facTok, '근무자·시설 로그인');

  r = await call('POST', '/users', { token: workerTok, body: { name: 'x', username: 'zz', password: 'pw123456' } });
  ok(r.status === 403 && /대표만/.test(r.j.error), '근무자의 계정 생성 차단');

  /* 비밀번호 재설정 */
  const wid = raw.prepare("SELECT id FROM users WHERE username='chulsoo'").get().id;
  r = await call('PATCH', '/users/' + wid, { token: ownerTok, body: { name: '김철수', role: 'worker', branch_ids: ['br-urban'], active: 1, password: 'newpw123' } });
  ok(r.status === 200 && r.j.user.branch_ids.length === 1, '계정 수정(담당 지점 변경)');
  w = await call('POST', '/login', { body: { username: 'chulsoo', password: 'newpw123' } });
  ok(w.status === 200, '재설정 비밀번호로 로그인');
  workerTok = w.j.token;
}

/* =====================================================================
   4) 예약 — 직접 추가 · 엑셀 업로드(교체/병합) · 권한별 /data
   ===================================================================== */
console.log('\n[4] 예약 · 데이터 조회');
{
  let r = await call('POST', '/reservations', { token: workerTok, body: { branch_id: 'br-urban', res_date: '2026-10-03', slot: 'night' } });
  ok(r.status === 403, '근무자 예약 추가 차단');

  r = await call('POST', '/reservations', { token: ownerTok, body: { branch_id: 'br-urban', res_date: '2026-10-03', slot: 'night', status: '확정', customer: '홍길동', phone: '010-1111-2222', amount: 180000, start_t: '19:00', end_t: '10:00' } });
  ok(r.status === 200 && r.j.reservation.source === 'manual', '예약 직접 추가');
  const manualId = r.j.reservation.id;

  const rows = [
    { branch_id: 'br-urban',  res_date: '2026-10-03', slot: 'day',   resno: 'BF1001', customer: '홍길동', phone: '010-1111-2222', amount: 90000,  status: '확정', start_t: '12:00', end_t: '17:00' },
    { branch_id: 'br-restel', res_date: '2026-10-03', slot: 'night', resno: 'N2001',  customer: '이몽룡', phone: '010-3333-4444', amount: 170000, status: '확정', start_t: '19:00', end_t: '10:00' },
    { branch_id: 'br-play2',  res_date: '2026-10-05', slot: 'allday', resno: 'BF1002', customer: '성춘향', phone: '010-5555-6666', amount: 250000, status: '이용완료', start_t: '12:00', end_t: '22:00' }
  ];
  r = await call('POST', '/reservations/import', { token: ownerTok, body: { mode: 'replace', rows } });
  ok(r.status === 200 && r.j.added === 3, '엑셀 업로드(교체) 3건', r.j);

  /* 교체 재업로드: 같은 달 excel 3건 삭제 후 2건 삽입, manual은 유지 */
  r = await call('POST', '/reservations/import', { token: ownerTok, body: { mode: 'replace', rows: rows.slice(0, 2) } });
  ok(r.j.added === 2, '교체 재업로드 added=2');
  let cnt = raw.prepare("SELECT COUNT(*) n FROM reservations WHERE substr(res_date,1,7)='2026-10'").get().n;
  ok(cnt === 3, '교체 후 총 3건(엑셀 2 + 직접 1)', cnt);

  /* 병합: 기존 resno 스킵 + 파일 내 중복 1회만 */
  r = await call('POST', '/reservations/import', { token: ownerTok, body: { mode: 'merge', rows: [rows[0], rows[2], rows[2]] } });
  ok(r.j.added === 1, '병합 added=1(기존 스킵·파일 내 중복 1회)', r.j);
  cnt = raw.prepare("SELECT COUNT(*) n FROM reservations").get().n;
  ok(cnt === 4, '병합 후 총 4건');

  /* /data — 관리자 vs 근무자 */
  r = await call('GET', '/data?from=2026-10-01&to=2026-10-31', { token: ownerTok });
  ok(r.j.reservations.length === 4 && r.j.reservations.some(x => x.customer === '홍길동'), '관리자 /data 전체 필드');
  r = await call('GET', '/data?from=2026-10-01&to=2026-10-31', { token: workerTok });
  const wr = r.j.reservations;
  ok(wr.length === 4 && wr.every(x => !('customer' in x) && !('phone' in x) && !('amount' in x)), '근무자 /data 고객·금액 제거');
  const day = wr.find(x => x.slot === 'day' && x.branch_id === 'br-urban');
  const night = wr.find(x => x.slot === 'night' && x.branch_id === 'br-urban');
  ok(day && night && day.ckey && day.ckey === night.ckey, '동일 고객 ckey 일치(연속 이용 판단)');
  ok(r.j.costs.length === 0, '근무자에게 비용 미노출');

  r = await call('DELETE', '/reservations/' + manualId, { token: ownerTok });
  ok(r.j.ok === true, '예약 삭제');
}

/* =====================================================================
   5) 청소 기록 — upsert · 제출 · 확인/보완 권한
   ===================================================================== */
console.log('\n[5] 청소 기록');
{
  const key = 'br-urban|2026-10-04|night';
  let r = await call('POST', '/cleanings', { token: workerTok, body: { task_key: key, branch_id: 'br-urban', clean_date: '2026-10-04', kind: 'night', window_label: '10:00 ~ 다음 예약 전', assignee: '김철수' } });
  ok(r.status === 200 && r.j.cleaning.status === 'todo' && r.j.cleaning.assignee === '김철수', '청소 생성(upsert)');
  const cid = r.j.cleaning.id;

  r = await call('POST', '/cleanings', { token: workerTok, body: { task_key: key, checks: { 'ci-c-01': true, 'ci-c-04': true }, note: '소파 아래 분실물 보관' } });
  ok(r.j.cleaning.id === cid && r.j.cleaning.checks['ci-c-04'] === true && r.j.cleaning.note.includes('분실물'), '같은 키 재저장 = 갱신');

  r = await call('POST', '/cleanings', { token: workerTok, body: { task_key: key, status: 'done', submitted_by: '김철수', submitted_at: new Date().toISOString() } });
  ok(r.j.cleaning.status === 'done' && r.j.cleaning.checks['ci-c-01'] === true, '완료 제출(기존 체크 유지)');

  r = await call('PATCH', '/cleanings/' + cid, { token: workerTok, body: { status: 'confirmed' } });
  ok(r.status === 403 && /확인 권한/.test(r.j.error), '근무자의 확인 처리 차단');
  r = await call('PATCH', '/cleanings/' + cid, { token: workerTok, body: { feedback: '셀프 피드백' } });
  ok(r.status === 403, '근무자의 피드백 차단');

  r = await call('PATCH', '/cleanings/' + cid, { token: ownerTok, body: { status: 'redo', feedback: '화장실 거울 얼룩이 남았습니다. 확인 부탁드립니다.', review_by: '최시준', review_at: new Date().toISOString() } });
  ok(r.j.cleaning.status === 'redo' && /거울/.test(r.j.cleaning.feedback), '보완 요청 + 피드백');

  r = await call('POST', '/cleanings', { token: workerTok, body: { task_key: key, status: 'done', submitted_at: new Date().toISOString() } });
  r = await call('PATCH', '/cleanings/' + cid, { token: ownerTok, body: { status: 'confirmed', review_by: '최시준', review_at: new Date().toISOString() } });
  ok(r.j.cleaning.status === 'confirmed', '재제출 → 확인 완료');

  /* 수동 청소 + 생략 */
  r = await call('POST', '/cleanings', { token: ownerTok, body: { task_key: 'br-play2|2026-10-06|m1abc', branch_id: 'br-play2', clean_date: '2026-10-06', kind: 'etc', manual: 1, window_label: '정기 점검 청소' } });
  ok(r.j.cleaning.manual === 1, '수동 청소 등록');
  r = await call('POST', '/cleanings', { token: workerTok, body: { task_key: 'br-urban|2026-10-07|mid', branch_id: 'br-urban', clean_date: '2026-10-07', kind: 'mid', status: 'skip', note: '동일 고객 연속 이용으로 생략' } });
  ok(r.j.cleaning.status === 'skip', '중간 정리 생략 처리');

  /* /data 청소 ±1일 버퍼 */
  r = await call('GET', '/data?from=2026-10-05&to=2026-10-05', { token: ownerTok });
  ok(r.j.cleanings.some(c => c.clean_date === '2026-10-04') && r.j.cleanings.some(c => c.clean_date === '2026-10-06'), '청소 조회 ±1일 버퍼');
}

/* =====================================================================
   6) 시설 이슈 — 등록 · 코멘트 · 상태 권한
   ===================================================================== */
console.log('\n[6] 시설 이슈');
{
  let r = await call('POST', '/issues', { token: workerTok, body: { branch_id: 'br-restel', category: '전자기기', equip: '무선마이크', priority: '높음', title: '마이크 1대 전원 불량', detail: '충전해도 전원이 켜지지 않습니다.', reporter: '김철수', status: '접수' } });
  ok(r.status === 200 && r.j.issue.status === '접수' && r.j.issue.comments.length === 0, '이슈 등록(근무자 가능)');
  const iid = r.j.issue.id;

  r = await call('PATCH', '/issues/' + iid, { token: workerTok, body: { status: '확인' } });
  ok(r.status === 403 && /처리 권한/.test(r.j.error), '근무자의 상태 변경 차단');

  r = await call('POST', '/issues/' + iid + '/comments', { token: facTok, body: { text: '내일 오전 방문해 확인하겠습니다.' } });
  ok(r.j.issue.comments.length === 1 && r.j.issue.comments[0].by === '박시설', '코멘트(작성자 이름 기록)');

  r = await call('PATCH', '/issues/' + iid, { token: facTok, body: { status: '진행중', assignee: '박시설' } });
  ok(r.j.issue.status === '진행중', '시설 담당 상태 변경');
  r = await call('PATCH', '/issues/' + iid, { token: facTok, body: { status: '완료', assignee: '박시설', cost: 45000 } });
  ok(r.j.issue.status === '완료' && !!r.j.issue.resolved_at && r.j.issue.cost === 45000, '완료 시 resolved_at 자동 기록');

  r = await call('GET', '/issues', { token: workerTok });
  ok(r.j.issues.length === 1 && Array.isArray(r.j.issues[0].comments), '이슈 목록(코멘트 JSON 복원)');
}

/* =====================================================================
   7) 홍보 채널 — 목록 · 수정 · ensure · 권한
   ===================================================================== */
console.log('\n[7] 홍보 채널');
{
  let r = await call('GET', '/channels', { token: workerTok });
  ok(r.j.channels.length === 55, '채널 55(시드)');

  const ch = r.j.channels.find(c => c.branch_id === 'br-urban' && c.channel === '인스타그램');
  r = await call('PATCH', '/channels/' + ch.id, { token: workerTok, body: { status: '운영중' } });
  ok(r.status === 403, '근무자 채널 수정 차단');
  r = await call('PATCH', '/channels/' + ch.id, { token: ownerTok, body: { status: '운영중', url: 'https://instagram.com/ssople', owner: '마케팅', last_check: '2026-10-01' } });
  ok(r.j.channel.status === '운영중' && r.j.channel.last_check === '2026-10-01', '채널 수정(오늘 점검)');

  /* 새 지점 + ensure */
  r = await call('POST', '/branches', { token: ownerTok, body: { name: '홍대 테스트점', alias: '홍대테스트', sort: 6, active: 1 } });
  ok(r.status === 200 && r.j.branch.name === '홍대 테스트점', '지점 추가');
  const nb = r.j.branch.id;
  r = await call('POST', '/channels/ensure', { token: ownerTok, body: { branch_id: nb } });
  ok(r.j.channels.filter(c => c.branch_id === nb).length === 11, 'ensure → 기본 11채널 채움');
  r = await call('POST', '/channels/ensure', { token: ownerTok, body: { branch_id: nb } });
  ok(r.j.channels.length === 66, 'ensure 재실행 중복 없음');

  const del = r.j.channels.find(c => c.branch_id === nb && c.channel === '유튜브');
  r = await call('DELETE', '/channels/' + del.id, { token: ownerTok });
  ok(r.j.ok === true, '채널 삭제');
  r = await call('PATCH', '/branches/' + nb, { token: ownerTok, body: { active: 0 } });
  ok(r.j.branch.active === 0, '지점 운영 중지');
}

/* =====================================================================
   8) 체크리스트 항목 · 비용 · 설정
   ===================================================================== */
console.log('\n[8] 항목 · 비용 · 설정');
{
  let r = await call('POST', '/check_items', { token: ownerTok, body: { scope: 'branch', branch_id: 'br-urban', category: '지점 특별관리', label: '루프탑 조명 점검', sort: 1, active: 1 } });
  ok(r.status === 200, '지점 특별 항목 추가');
  const ciid = r.j.item.id;
  r = await call('PATCH', '/check_items/' + ciid, { token: ownerTok, body: { label: '루프탑 조명·난간 점검' } });
  ok(/난간/.test(r.j.item.label), '항목 수정');
  r = await call('DELETE', '/check_items/' + ciid, { token: workerTok });
  ok(r.status === 403, '근무자 항목 삭제 차단');
  r = await call('DELETE', '/check_items/' + ciid, { token: ownerTok });
  ok(r.j.ok === true, '항목 삭제');

  const costRows = BR.map(b => ({ branch_id: b.id, rent: 1200000, mgmt: 180000, supplies: 90000, telecom: 30000, misc: 50000, fee_pct: 3.3 }));
  r = await call('POST', '/costs/save', { token: ownerTok, body: { ym: '2026-10', rows: costRows } });
  ok(r.j.ok === true, '비용 저장(5개 지점)');
  r = await call('POST', '/costs/save', { token: ownerTok, body: { ym: '2026-10', rows: [{ branch_id: 'br-urban', rent: 1300000, mgmt: 180000, supplies: 90000, telecom: 30000, misc: 50000, fee_pct: 3.3 }] } });
  const c = raw.prepare("SELECT rent, COUNT(*) OVER() n FROM costs WHERE ym='2026-10' AND branch_id='br-urban'").get();
  ok(c.rent === 1300000 && raw.prepare("SELECT COUNT(*) n FROM costs WHERE ym='2026-10'").get().n === 5, '비용 upsert(중복 없이 갱신)');
  r = await call('GET', '/data?from=2026-10-01&to=2026-10-31', { token: ownerTok });
  ok(r.j.costs.length === 5, '/data에 월 비용 포함');
  r = await call('POST', '/costs/save', { token: workerTok, body: { ym: '2026-10', rows: costRows } });
  ok(r.status === 403, '근무자 비용 저장 차단');

  const ns = { times: { day: ['12:00', '17:00'], night: ['19:00', '10:00'], allday: ['12:00', '22:00'] }, clean_before_min: 40, mid_deadline: '18:00', quick_items: ['환기', '정리'] };
  r = await call('POST', '/settings', { token: ownerTok, body: { settings: ns } });
  ok(r.j.settings.clean_before_min === 40, '설정 저장');
  r = await call('GET', '/bootstrap', { token: ownerTok });
  ok(r.j.settings.clean_before_min === 40 && r.j.settings.mid_deadline === '18:00', 'bootstrap에 반영');
}

/* =====================================================================
   9) 세션 · 계정 중지 · 로그아웃 · 알 수 없는 경로
   ===================================================================== */
console.log('\n[9] 세션 관리');
{
  const wid = raw.prepare("SELECT id FROM users WHERE username='chulsoo'").get().id;
  let r = await call('PATCH', '/users/' + wid, { token: ownerTok, body: { active: 0 } });
  ok(r.j.user.active === 0, '계정 중지');
  r = await call('GET', '/bootstrap', { token: workerTok });
  ok(r.status === 401, '중지 계정 세션 즉시 차단');
  r = await call('POST', '/login', { body: { username: 'chulsoo', password: 'newpw123' } });
  ok(r.status === 400, '중지 계정 로그인 차단');
  await call('PATCH', '/users/' + wid, { token: ownerTok, body: { active: 1 } });

  r = await call('POST', '/logout', { token: facTok, body: {} });
  ok(r.j.ok === true, '로그아웃');
  r = await call('GET', '/issues', { token: facTok });
  ok(r.status === 401, '로그아웃 후 401');

  /* 만료 세션 */
  raw.prepare("UPDATE sessions SET expires_at='2020-01-01T00:00:00.000Z' WHERE user_id=(SELECT id FROM users WHERE username='ceo') AND token=?").run(ownerTok);
  r = await call('GET', '/bootstrap', { token: ownerTok });
  ok(r.status === 401, '만료 세션 401');
  r = await call('POST', '/login', { body: { username: 'ceo', password: 'test1234' } });
  ownerTok = r.j.token;

  r = await call('GET', '/nope', { token: ownerTok });
  ok(r.status === 404 && /알 수 없는 요청/.test(r.j.error), '알 수 없는 경로 404');

  const rr = await onRequest({ request: new Request('http://local/api/health'), env: {} });
  const jj = await rr.json();
  ok(rr.status === 500 && /D1 데이터베이스가 연결되지/.test(jj.error), 'DB 미바인딩 안내');
}


/* =====================================================================
   V2) 지점 프로필 · 일괄 배정 · 브리핑 · 단가 · 확인표시
   ===================================================================== */
console.log('\n[V2-1] 지점 프로필');
let B0, B1, wk2Tok;
{
  let r = await call('GET', '/bootstrap', { token: ownerTok });
  B0 = r.j.branches[0].id; B1 = r.j.branches[1].id;

  r = await call('POST', '/users', { token: ownerTok, body: { name: '보드근무자', username: 'wk2', password: 'wk2pass1', role: 'worker', branch_ids: [] } });
  ok(r.status === 200, 'v2용 근무자 생성', r.j);
  r = await call('POST', '/login', { body: { username: 'wk2', password: 'wk2pass1' } });
  wk2Tok = r.j.token;

  r = await call('POST', '/profiles/' + B0, { token: ownerTok, body: {
    region: '신촌', scode: 'S001', default_worker: '보드근무자',
    std_minutes: 90, buffer_min: 20, midday_deadline: '18:00',
    notes: '분리수거 뒤편', slots_json: JSON.stringify({ night: ['20:00', '08:00'] })
  } });
  ok(r.status === 200 && r.j.profile.region === '신촌' && r.j.profile.std_minutes === 90, '프로필 upsert', r.j);

  r = await call('POST', '/profiles/' + B0, { token: ownerTok, body: { region: '신촌', scode: 'S001', default_worker: '보드근무자', std_minutes: '', notes: '분리수거 뒤편' } });
  ok(r.status === 200 && r.j.profile.std_minutes === null, '프로필 재저장(빈 값 → 전역 사용)', r.j);

  r = await call('POST', '/profiles/' + B0, { token: wk2Tok, body: { region: 'x' } });
  ok(r.status === 403, '근무자 프로필 저장 차단');

  r = await call('GET', `/data?from=2026-01-01&to=2026-01-31`, { token: wk2Tok });
  ok(r.j.v2 === true && Array.isArray(r.j.profiles) && r.j.profiles.some(p => p.branch_id === B0 && p.region === '신촌'), '근무자도 프로필 수신(시간 계산용)', r.j.profiles);
  ok(r.j.host_bound === false, 'HOSTDB 미바인딩 표시', r.j.host_bound);
}

console.log('\n[V2-2] 일괄 배정');
{
  let r = await call('POST', '/assignments', { token: ownerTok, body: { date: '2026-10-10', region: '신촌', branch_id: '', worker: '보드근무자' } });
  ok(r.status === 200 && r.j.assignment.worker === '보드근무자', '권역 배정 생성', r.j);
  const aid = r.j.assignment.id;

  r = await call('POST', '/assignments', { token: ownerTok, body: { date: '2026-10-10', region: '신촌', branch_id: '', worker: '김근무' } });
  ok(r.status === 200 && r.j.assignment.id === aid && r.j.assignment.worker === '김근무', '같은 키 upsert(교체)', r.j);

  r = await call('GET', `/data?from=2026-10-09&to=2026-10-11`, { token: wk2Tok });
  ok(r.j.assignments.length === 1 && r.j.assignments[0].worker === '김근무', '근무자 /data로 배정 수신');

  r = await call('POST', '/assignments', { token: wk2Tok, body: { date: '2026-10-10', region: '신촌', worker: 'x' } });
  ok(r.status === 403, '근무자 배정 차단');

  r = await call('POST', '/assignments', { token: ownerTok, body: { date: '2026-10-10', region: '신촌', branch_id: '', worker: '' } });
  ok(r.status === 200 && r.j.removed === true, '빈 담당 저장 = 배정 해제');
  r = await call('GET', `/data?from=2026-10-09&to=2026-10-11`, { token: ownerTok });
  ok(r.j.assignments.length === 0, '해제 반영');
}

console.log('\n[V2-3] 일일 브리핑 + 읽음');
{
  let r = await call('POST', '/notices', { token: ownerTok, body: { date: '2026-10-10', body: '어반홀리 12시 전 완료 필수' } });
  ok(r.status === 200 && r.j.notice.id, '브리핑 등록', r.j);
  const nid = r.j.notice.id;

  r = await call('POST', '/notices', { token: wk2Tok, body: { date: '2026-10-10', body: 'x' } });
  ok(r.status === 403, '근무자 등록 차단');

  r = await call('POST', `/notices/${nid}/read`, { token: wk2Tok, body: {} });
  ok(r.status === 200 && r.j.read === true, '근무자 읽음 확인');
  r = await call('POST', `/notices/${nid}/read`, { token: wk2Tok, body: {} });
  ok(r.status === 200, '중복 확인에도 오류 없음(교체)');

  r = await call('GET', `/data?from=2026-10-09&to=2026-10-11`, { token: ownerTok });
  const reads = r.j.notice_reads.filter(x => x.notice_id === nid);
  ok(r.j.notices.some(n => n.id === nid) && reads.length === 1 && reads[0].user_name === '보드근무자', '읽음 명단 1명', r.j.notice_reads);

  r = await call('POST', `/notices/${nid}/read`, { token: wk2Tok, body: { undo: true } });
  ok(r.status === 200 && r.j.read === false, '읽음 취소');
  r = await call('GET', `/data?from=2026-10-09&to=2026-10-11`, { token: ownerTok });
  ok(r.j.notice_reads.filter(x => x.notice_id === nid).length === 0, '취소 반영');

  r = await call('DELETE', `/notices/${nid}`, { token: ownerTok });
  ok(r.status === 200, '브리핑 삭제');
}

console.log('\n[V2-4] 청소 단가');
{
  const u = raw.prepare("SELECT id FROM users WHERE username='wk2'").get();
  let r = await call('POST', '/rates', { token: wk2Tok, body: { user_id: u.id, rate: 99999 } });
  ok(r.status === 403, '근무자 단가 설정 차단');
  r = await call('POST', '/rates', { token: ownerTok, body: { user_id: u.id, rate: 18000 } });
  ok(r.status === 200 && r.j.rate === 18000, '대표 단가 설정', r.j);
  r = await call('POST', '/rates', { token: ownerTok, body: { user_id: u.id, rate: 20000 } });
  ok(r.status === 200 && r.j.rate === 20000, '단가 upsert(교체)');
  r = await call('GET', `/data?from=2026-10-01&to=2026-10-02`, { token: ownerTok });
  ok(r.j.rates.some(x => x.user_id === u.id && x.rate === 20000), '관리자 /data에 단가 포함');
  r = await call('GET', `/data?from=2026-10-01&to=2026-10-02`, { token: wk2Tok });
  ok((r.j.rates || []).length === 0, '근무자에게는 단가 비공개');
}

console.log('\n[V2-5] 예약 확인 필요 표시(보류)');
{
  let r = await call('POST', '/reservations', { token: ownerTok, body: { branch_id: B0, res_date: '2026-10-12', slot: 'night', status: '확정', amount: 100000, customer: '테스트', phone: '010' } });
  const rid = r.j.reservation.id;
  r = await call('POST', '/resissue', { token: wk2Tok, body: { res_id: rid, issue: 'x' } });
  ok(r.status === 403, '근무자 표시 차단');
  r = await call('POST', '/resissue', { token: ownerTok, body: { res_id: rid, issue: '퇴실 12시 확인 필요' } });
  ok(r.status === 200 && r.j.reservation.issue === '퇴실 12시 확인 필요', '표시 설정', r.j);
  r = await call('GET', `/data?from=2026-10-12&to=2026-10-13`, { token: wk2Tok });
  const wr = r.j.reservations.find(x => x.id === rid);
  ok(wr && wr.issue === 1 && wr.customer === undefined, '근무자에겐 플래그만(내용·개인정보 비공개)', wr);
  r = await call('POST', '/resissue', { token: ownerTok, body: { res_id: rid, issue: '' } });
  ok(r.status === 200 && r.j.reservation.issue === '', '표시 해제');
}

/* =====================================================================
   V3) 호스트 예약 동기화
   ===================================================================== */
console.log('\n[V3] 호스트 동기화');
{
  let r = await call('POST', '/sync', { token: ownerTok, body: {} });
  ok(r.status === 500 && /HOSTDB/.test(r.j.error) && /읽는 데만/.test(r.j.error), 'HOSTDB 미바인딩 → 연결 안내', r.j);

  const D = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const bName1 = raw.prepare('SELECT name FROM branches WHERE id=?').get(B1).name;
  const ins = hraw.prepare('INSERT INTO reservations(id,branch_code,space_name,use_date,slot,start_time,end_time,customer_name,phone,total_amount,status,memo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run(101, 'S001', '', D(3), '밤', '19:00', '07:00', '홍길동', '01011112222', 150000, '확정', '생일파티');
  ins.run(102, '', bName1, D(4) + ' 11:00', null, '11:00', '16:00', '김영희', '01033334444', 90000, '결제완료', '');
  ins.run(103, 'S999', '미등록지점', D(5), '낮', '11:00', '16:00', '박철수', '010', 80000, '확정', '');
  ins.run(104, 'S001', '', D(-60), '밤', '19:00', '07:00', '과거', '010', 10000, '확정', '');

  r = await callH('POST', '/sync', { token: wk2Tok, body: {} });
  ok(r.status === 403, '근무자 동기화 차단');

  r = await callH('POST', '/sync', { token: ownerTok, body: {} });
  ok(r.status === 200 && r.j.ok && r.j.added === 2 && r.j.removed === 0, '최초 동기화: 2건 추가(창 밖·미매칭 제외)', r.j);
  ok(r.j.unmatched.length === 1 && r.j.unmatched[0] === 'S999' && r.j.skipped === 1, '미매칭 지점 보고', r.j.unmatched);
  ok(r.j.table === 'reservations', '테이블 자동 탐지');

  const s1 = raw.prepare("SELECT * FROM reservations WHERE resno='H101'").get();
  const s2 = raw.prepare("SELECT * FROM reservations WHERE resno='H102'").get();
  ok(s1 && s1.branch_id === B0 && s1.slot === 'night' && s1.source === 'sync' && s1.amount === 150000 && s1.start_t === '19:00', 'S코드 매칭 + 밤타임 인식', s1);
  ok(s2 && s2.branch_id === B1 && s2.slot === 'day' && s2.res_date === D(4), '지점명 매칭 + 시작시각으로 낮타임 파생 + 날짜 정규화', s2);

  r = await callH('POST', '/sync', { token: ownerTok, body: {} });
  ok(r.j.added === 0 && r.j.updated === 0 && r.j.removed === 0, '재실행 시 변경 없음(멱등)');

  hraw.prepare('UPDATE reservations SET total_amount=180000 WHERE id=101').run();
  r = await callH('POST', '/sync', { token: ownerTok, body: {} });
  ok(r.j.updated === 1 && raw.prepare("SELECT amount FROM reservations WHERE resno='H101'").get().amount === 180000, '호스트 변경 → 갱신', r.j);

  hraw.prepare("UPDATE reservations SET status='취소' WHERE id=101").run();
  r = await callH('POST', '/sync', { token: ownerTok, body: {} });
  ok(r.j.removed === 1 && !raw.prepare("SELECT id FROM reservations WHERE resno='H101'").get(), '호스트 취소 → 제거', r.j);
  ok(!!raw.prepare("SELECT id FROM reservations WHERE resno='H102'").get(), '나머지 동기화분 유지');

  const lg = raw.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
  ok(lg && lg.ok === 1 && typeof lg.message === 'string', '동기화 기록 저장', lg);

  r = await callH('GET', `/data?from=${D(0)}&to=${D(7)}`, { token: ownerTok });
  ok(r.j.host_bound === true && r.j.last_sync && r.j.last_sync.ran_at, '/data: 연결 상태 + 마지막 동기화', r.j.last_sync);

  /* 수동 매핑 저장 */
  r = await call('POST', '/hostmap', { token: ownerTok, body: { map: { table: 'reservations' } } });
  ok(r.status === 200, '수동 매핑 저장');
  r = await callH('POST', '/sync', { token: ownerTok, body: {} });
  ok(r.status === 200 && r.j.table === 'reservations', '수동 매핑 적용');
}

console.log(`\n결과: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
