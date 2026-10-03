/* =====================================================================
   쏘플 공간관리 시스템 v2 — 서버 API (Cloudflare Pages Functions + D1)
   ---------------------------------------------------------------------
   · 이 파일은 /api/* 경로의 모든 요청을 처리합니다.
   · Cloudflare Pages 설정에서 D1 데이터베이스를 변수 이름 "DB"로
     연결해야 동작합니다. (README.md 3~4단계 참고)
   · index.html 안의 데모 엔진과 완전히 같은 요청/응답 규격을 사용하므로,
     화면 코드는 서버 유무와 상관없이 동일하게 동작합니다.
   ===================================================================== */

/* ---------- 공통 응답 ---------- */
const JSONH = { 'Content-Type': 'application/json; charset=utf-8' };
const J = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSONH });
function httpErr(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ---------- 작은 유틸 ---------- */
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const pad2 = n => String(n).padStart(2, '0');
function addDays(ds, n) {
  const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function shiftYM(ym, n) {
  const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}
/* 근무자 화면용 고객 식별키 — index.html의 dhash와 동일(djb2) */
function dhash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return 'd' + h.toString(16); }

const sj = v => JSON.stringify(v == null ? null : v);
const pj = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch (e) { return fb; } };

/* ---------- 비밀번호 (PBKDF2-SHA256, 10,000회) ---------- */
const te = new TextEncoder();
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
function fromHex(hex) { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }
async function pbkdf2Hex(password, salt) {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 10000 }, key, 256);
  return toHex(bits);
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$10000$${toHex(salt)}$${await pbkdf2Hex(pw, salt)}`;
}
async function verifyPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 4) return false;
  const calc = te.encode(await pbkdf2Hex(pw, fromHex(p[2])));
  const want = te.encode(p[3]);
  if (calc.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < calc.length; i++) diff |= calc[i] ^ want[i];
  return diff === 0;
}

/* ---------- 행 → 응답 객체 (JSON 컬럼 복원) ---------- */
const rowUser = r => r && ({ id: r.id, username: r.username, name: r.name, role: r.role, branch_ids: pj(r.branch_ids, []), phone: r.phone || '', active: r.active });
const rowClean = r => r && Object.assign({}, r, { checks: pj(r.checks, {}) });
const rowIssue = r => r && Object.assign({}, r, { comments: pj(r.comments, []) });

/* ---------- 테이블별 허용 컬럼(화이트리스트) ----------
   클라이언트가 보낸 값 중 이 목록에 있는 키만 SQL에 반영합니다. */
const COLS = {
  cleanings: ['branch_id', 'clean_date', 'kind', 'assignee', 'status', 'checks', 'note', 'submitted_by', 'submitted_at', 'review_by', 'review_at', 'feedback', 'manual', 'window_label'],
  issues: ['branch_id', 'category', 'equip', 'title', 'detail', 'priority', 'status', 'reporter', 'assignee', 'cost', 'resolved_at'],
  channels: ['branch_id', 'channel', 'url', 'status', 'owner', 'last_check', 'memo', 'sort'],
  reservations: ['branch_id', 'res_date', 'slot', 'resno', 'customer', 'phone', 'amount', 'status', 'issue', 'memo', 'start_t', 'end_t', 'source'],
  branches: ['name', 'alias', 'memo', 'default_worker', 'sort', 'active'],
  check_items: ['scope', 'branch_id', 'category', 'label', 'sort', 'active'],
  users: ['name', 'role', 'branch_ids', 'phone', 'active']
};
const JSON_COLS = { cleanings: ['checks'], users: ['branch_ids'] };
function pick(table, body) {
  const out = {};
  if (!body) return out;
  for (const k of COLS[table]) if (k in body) {
    let v = body[k];
    if ((JSON_COLS[table] || []).includes(k)) v = sj(v ?? (k === 'branch_ids' ? [] : {}));
    out[k] = v === undefined ? null : v;
  }
  return out;
}
function insertStmt(db, table, obj) {
  const keys = Object.keys(obj);
  return db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .bind(...keys.map(k => obj[k] === undefined ? null : obj[k]));
}
function updateStmt(db, table, obj, id) {
  const keys = Object.keys(obj);
  if (!keys.length) return null;
  return db.prepare(`UPDATE ${table} SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`)
    .bind(...keys.map(k => obj[k] === undefined ? null : obj[k]), id);
}

/* ---------- 세션 ---------- */
const SESSION_DAYS = 60;
function bearer(request) {
  const a = request.headers.get('Authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}
async function newSession(db, userId) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(24)));
  const exp = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').bind(token, userId, exp).run();
  return token;
}
async function getMe(db, request) {
  const token = bearer(request);
  if (!token) return null;
  const row = await db.prepare(
    'SELECT s.expires_at AS _exp, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?'
  ).bind(token).first();
  if (!row) return null;
  if (String(row._exp) < nowIso()) {
    await db.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
    return null;
  }
  if (!row.active) return null;
  return rowUser(row);
}

/* 사이트 홍보 채널 기본값 — index.html의 CHANNEL_PRESETS와 동일 */
const CHANNEL_PRESETS = ['네이버 플레이스·예약', '네이버 지도·내비', '네이버 블로그', '스페이스클라우드', '여기어때', '프빗(Pvit)', '인스타그램', '유튜브', '당근마켓', '카카오톡 채널', '자체 홈페이지'];

/* =====================================================================
   진입점
   ===================================================================== */
export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (!env.DB) throw httpErr('D1 데이터베이스가 연결되지 않았습니다. Cloudflare Pages 설정 → Bindings에서 변수 이름 "DB"로 D1을 연결한 뒤 다시 배포해 주세요.', 500);
    return await route(env.DB, request, env);
  } catch (e) {
    let msg = (e && e.message) ? e.message : '요청 처리에 실패했습니다';
    if (/no such table/i.test(msg)) msg = '데이터베이스 초기화가 필요합니다. D1 Console에서 schema.sql을 실행해 주세요.';
    return J({ error: msg }, e && e.status ? e.status : 400);
  }
}

async function route(db, request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const seg = path.split('/').filter(Boolean);
  const q = url.searchParams;
  const method = request.method;
  let body = null;
  if (method === 'POST' || method === 'PATCH') { try { body = await request.json(); } catch (e) { body = {}; } }

  /* ---------- 인증 불필요 구간 ---------- */
  if (path === '/health' && method === 'GET') {
    try {
      const c = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
      return J({ ok: true, needSetup: !c || !c.n });
    } catch (e) {
      /* 스키마 미실행 → 프런트가 안내 화면을 띄울 수 있게 표시 */
      return J({ ok: false, needSchema: true, error: '데이터베이스 초기화가 필요합니다. D1 Console에서 schema.sql을 실행해 주세요.' });
    }
  }

  if (path === '/setup' && method === 'POST') {
    const c = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (c && c.n > 0) throw httpErr('이미 초기 설정이 완료되었습니다');
    const username = String(body.username || '').trim();
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!username || !name || !password) throw httpErr('이름, 아이디, 비밀번호를 모두 입력해 주세요');
    const id = uid();
    await db.prepare('INSERT INTO users(id,username,pw,name,role,branch_ids,phone,active) VALUES(?,?,?,?,?,?,?,1)')
      .bind(id, username, await hashPassword(password), name, 'owner', '[]', '').run();
    const token = await newSession(db, id);
    const u = await db.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
    return J({ token, user: rowUser(u) });
  }

  if (path === '/login' && method === 'POST') {
    const username = String(body.username || '').trim();
    const u = await db.prepare('SELECT * FROM users WHERE username=? AND active=1').bind(username).first();
    if (!u || !(await verifyPassword(String(body.password || ''), u.pw)))
      throw httpErr('아이디 또는 비밀번호가 올바르지 않습니다');
    const token = await newSession(db, u.id);
    return J({ token, user: rowUser(u) });
  }

  if (path === '/logout') {
    const token = bearer(request);
    if (token) await db.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
    return J({ ok: true });
  }

  /* ---------- 이하 로그인 필요 ---------- */
  const me = await getMe(db, request);
  if (!me) throw httpErr('로그인이 필요합니다', 401);
  const isMgr = me.role === 'owner' || me.role === 'manager';
  const mustMgr = () => { if (!isMgr) throw httpErr('권한이 없습니다', 403); };

  if (path === '/bootstrap' && method === 'GET') {
    const users = (await db.prepare('SELECT * FROM users').all()).results.map(rowUser);
    const branches = (await db.prepare('SELECT * FROM branches ORDER BY sort').all()).results;
    const check_items = (await db.prepare('SELECT * FROM check_items').all()).results;
    const st = await db.prepare("SELECT v FROM app_settings WHERE k='settings'").first();
    return J({ user: me, users, branches, check_items, settings: st ? pj(st.v, null) : null });
  }

  if (path === '/data' && method === 'GET') {
    const from = q.get('from'), to = q.get('to');
    if (!from || !to) throw httpErr('조회 기간이 필요합니다');
    let reservations = (await db.prepare('SELECT * FROM reservations WHERE res_date>=? AND res_date<=?')
      .bind(from, to).all()).results;
    if (!isMgr) {
      /* 근무자에게는 고객 정보·금액을 보내지 않고, 동일 고객 연속 이용 판단용 키만 제공 */
      reservations = reservations.map(r => ({
        id: r.id, branch_id: r.branch_id, res_date: r.res_date, slot: r.slot,
        start_t: r.start_t, end_t: r.end_t, source: r.source,
        ckey: dhash((r.customer || '') + (r.phone || '')), issue: r.issue ? 1 : 0
      }));
    }
    const cleanings = (await db.prepare('SELECT * FROM cleanings WHERE clean_date>=? AND clean_date<=?')
      .bind(addDays(from, -1), addDays(to, 1)).all()).results.map(rowClean);
    let costs = [];
    if (isMgr) {
      const yms = []; let d = from.slice(0, 7);
      while (d <= to.slice(0, 7)) { yms.push(d); d = shiftYM(d, 1); }
      costs = (await db.prepare(`SELECT * FROM costs WHERE ym IN (${yms.map(() => '?').join(',')})`)
        .bind(...yms).all()).results;
    }
    /* ---- v2 확장 데이터 (업그레이드 SQL 미실행 상태에서도 기존 기능은 그대로 동작) ---- */
    let profiles = [], assignments = [], notices = [], notice_reads = [], rates = [], last_sync = null, v2 = true;
    try {
      profiles = (await db.prepare('SELECT * FROM branch_profiles').all()).results;
      assignments = (await db.prepare('SELECT * FROM assignments WHERE date>=? AND date<=?')
        .bind(addDays(from, -1), addDays(to, 1)).all()).results;
      notices = (await db.prepare('SELECT * FROM notices WHERE date>=? AND date<=? ORDER BY date, created_at')
        .bind(addDays(from, -1), addDays(to, 1)).all()).results;
      if (notices.length) {
        const ids = notices.map(n => n.id);
        notice_reads = (await db.prepare(`SELECT * FROM notice_reads WHERE notice_id IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids).all()).results;
      }
      if (isMgr) {
        rates = (await db.prepare('SELECT * FROM user_rates').all()).results;
        last_sync = await db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').first();
      }
    } catch (e) { v2 = false; }
    return J({ reservations, cleanings, costs, profiles, assignments, notices, notice_reads, rates, last_sync, v2, host_bound: !!(env && env.HOSTDB) });
  }

  /* ---------- 시설 이슈 ---------- */
  if (path === '/issues' && method === 'GET') {
    const rows = (await db.prepare('SELECT * FROM issues ORDER BY created_at DESC').all()).results.map(rowIssue);
    return J({ issues: rows });
  }
  if (path === '/issues' && method === 'POST') {
    const o = pick('issues', body);
    const it = Object.assign(
      { branch_id: null, category: '', equip: '', title: '', detail: '', priority: '보통', status: '접수', reporter: me.name, assignee: null, cost: null, resolved_at: null },
      o, { id: uid(), comments: '[]', created_at: nowIso() }
    );
    if (!String(it.title || '').trim()) throw httpErr('제목을 입력해 주세요');
    await insertStmt(db, 'issues', it).run();
    return J({ issue: rowIssue(await db.prepare('SELECT * FROM issues WHERE id=?').bind(it.id).first()) });
  }
  if (seg[0] === 'issues' && seg[1] && seg[2] === 'comments' && method === 'POST') {
    const row = await db.prepare('SELECT * FROM issues WHERE id=?').bind(seg[1]).first();
    if (!row) throw httpErr('이슈를 찾을 수 없습니다', 404);
    const comments = pj(row.comments, []);
    comments.push({ id: uid(), by: me.name, text: String(body.text || ''), at: nowIso() });
    await db.prepare('UPDATE issues SET comments=? WHERE id=?').bind(sj(comments), seg[1]).run();
    return J({ issue: rowIssue(await db.prepare('SELECT * FROM issues WHERE id=?').bind(seg[1]).first()) });
  }
  if (seg[0] === 'issues' && seg[1] && method === 'PATCH') {
    if (!(isMgr || me.role === 'facility')) throw httpErr('처리 권한이 없습니다', 403);
    const row = await db.prepare('SELECT * FROM issues WHERE id=?').bind(seg[1]).first();
    if (!row) throw httpErr('이슈를 찾을 수 없습니다', 404);
    const patch = pick('issues', body);
    if (body.status === '완료' && !row.resolved_at && !patch.resolved_at) patch.resolved_at = nowIso();
    const st = updateStmt(db, 'issues', patch, seg[1]); if (st) await st.run();
    return J({ issue: rowIssue(await db.prepare('SELECT * FROM issues WHERE id=?').bind(seg[1]).first()) });
  }

  /* ---------- 홍보 채널 ---------- */
  if (path === '/channels' && method === 'GET') {
    return J({ channels: (await db.prepare('SELECT * FROM channels').all()).results });
  }
  if (path === '/channels' && method === 'POST') {
    mustMgr();
    const c = Object.assign(
      { branch_id: null, channel: '', url: '', status: '등록필요', owner: '', last_check: null, memo: '', sort: 99 },
      pick('channels', body), { id: uid() }
    );
    await insertStmt(db, 'channels', c).run();
    return J({ channel: await db.prepare('SELECT * FROM channels WHERE id=?').bind(c.id).first() });
  }
  if (seg[0] === 'channels' && seg[1] === 'ensure' && method === 'POST') {
    mustMgr();
    const bid = body.branch_id;
    if (!bid) throw httpErr('지점을 선택해 주세요');
    const have = new Set((await db.prepare('SELECT channel FROM channels WHERE branch_id=?').bind(bid).all()).results.map(r => r.channel));
    const stmts = [];
    CHANNEL_PRESETS.forEach((ch, i) => {
      if (!have.has(ch)) stmts.push(insertStmt(db, 'channels', { id: uid(), branch_id: bid, channel: ch, url: '', status: '등록필요', owner: '', last_check: null, memo: '', sort: i }));
    });
    if (stmts.length) await db.batch(stmts);
    return J({ channels: (await db.prepare('SELECT * FROM channels').all()).results });
  }
  if (seg[0] === 'channels' && seg[1] && method === 'PATCH') {
    mustMgr();
    const row = await db.prepare('SELECT id FROM channels WHERE id=?').bind(seg[1]).first();
    if (!row) throw httpErr('채널을 찾을 수 없습니다', 404);
    const st = updateStmt(db, 'channels', pick('channels', body), seg[1]); if (st) await st.run();
    return J({ channel: await db.prepare('SELECT * FROM channels WHERE id=?').bind(seg[1]).first() });
  }
  if (seg[0] === 'channels' && seg[1] && method === 'DELETE') {
    mustMgr();
    await db.prepare('DELETE FROM channels WHERE id=?').bind(seg[1]).run();
    return J({ ok: true });
  }

  /* ---------- 청소 기록 (task_key 기준 upsert) ---------- */
  if (path === '/cleanings' && method === 'POST') {
    const tk = String(body.task_key || '').trim();
    if (!tk) throw httpErr('task_key가 필요합니다');
    const ex = await db.prepare('SELECT * FROM cleanings WHERE task_key=?').bind(tk).first();
    const o = pick('cleanings', body);
    if (!ex) {
      const c = Object.assign(
        { branch_id: null, clean_date: null, kind: 'etc', assignee: null, status: 'todo', checks: '{}', note: '', submitted_by: null, submitted_at: null, review_by: null, review_at: null, feedback: null, manual: 0, window_label: '' },
        o, { id: uid(), task_key: tk, created_at: nowIso() }
      );
      await insertStmt(db, 'cleanings', c).run();
    } else {
      const st = updateStmt(db, 'cleanings', o, ex.id); if (st) await st.run();
    }
    return J({ cleaning: rowClean(await db.prepare('SELECT * FROM cleanings WHERE task_key=?').bind(tk).first()) });
  }
  if (seg[0] === 'cleanings' && seg[1] && method === 'PATCH') {
    const ex = await db.prepare('SELECT id FROM cleanings WHERE id=?').bind(seg[1]).first();
    if (!ex) throw httpErr('청소 기록을 찾을 수 없습니다', 404);
    const reviewing = ('feedback' in (body || {})) || ['confirmed', 'redo'].includes(body.status);
    if (reviewing && !isMgr) throw httpErr('확인 권한이 없습니다', 403);
    const st = updateStmt(db, 'cleanings', pick('cleanings', body), seg[1]); if (st) await st.run();
    return J({ cleaning: rowClean(await db.prepare('SELECT * FROM cleanings WHERE id=?').bind(seg[1]).first()) });
  }

  /* ---------- 예약 ---------- */
  if (path === '/reservations' && method === 'POST') {
    mustMgr();
    const r = Object.assign(
      { branch_id: null, res_date: null, slot: 'etc', resno: '', customer: '', phone: '', amount: 0, status: '확정', issue: '', memo: '', start_t: null, end_t: null, source: 'manual' },
      pick('reservations', body), { id: uid(), created_at: nowIso() }
    );
    if (!r.res_date) throw httpErr('이용일을 선택해 주세요');
    await insertStmt(db, 'reservations', r).run();
    return J({ reservation: await db.prepare('SELECT * FROM reservations WHERE id=?').bind(r.id).first() });
  }
  if (seg[0] === 'reservations' && seg[1] === 'import' && method === 'POST') {
    mustMgr();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw httpErr('업로드할 예약이 없습니다');
    const mode = body.mode === 'merge' ? 'merge' : 'replace';
    const yms = [...new Set(rows.map(r => String(r.res_date || '').slice(0, 7)))].filter(Boolean);

    const stmts = [];
    if (mode === 'replace') {
      for (const ym of yms)
        stmts.push(db.prepare("DELETE FROM reservations WHERE source='excel' AND substr(res_date,1,7)=?").bind(ym));
    }
    const skip = new Set();
    if (mode === 'merge') {
      const resnos = [...new Set(rows.map(r => String(r.resno || '').trim()).filter(Boolean))];
      for (let i = 0; i < resnos.length; i += 80) {
        const part = resnos.slice(i, i + 80);
        const found = (await db.prepare(`SELECT resno FROM reservations WHERE resno IN (${part.map(() => '?').join(',')})`)
          .bind(...part).all()).results;
        found.forEach(f => skip.add(f.resno));
      }
    }
    let added = 0;
    for (const r of rows) {
      const resno = String(r.resno || '').trim();
      if (mode === 'merge' && resno && skip.has(resno)) continue;
      const row = Object.assign(
        { branch_id: null, res_date: null, slot: 'etc', resno: '', customer: '', phone: '', amount: 0, status: '확정', issue: '', memo: '', start_t: null, end_t: null },
        pick('reservations', r), { id: uid(), source: 'excel', created_at: nowIso() }
      );
      if (!row.res_date) continue;
      stmts.push(insertStmt(db, 'reservations', row));
      if (resno) skip.add(resno);       /* 같은 파일 안의 중복도 한 번만 */
      added++;
    }
    for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
    return J({ added });
  }
  if (seg[0] === 'reservations' && seg[1] && method === 'DELETE') {
    mustMgr();
    await db.prepare('DELETE FROM reservations WHERE id=?').bind(seg[1]).run();
    return J({ ok: true });
  }

  /* ---------- 월별 비용 ---------- */
  if (path === '/costs/save' && method === 'POST') {
    mustMgr();
    const ym = String(body.ym || '').trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!ym) throw httpErr('대상 월이 필요합니다');
    const stmts = rows.filter(r => r && r.branch_id).map(r =>
      db.prepare(`INSERT INTO costs(id,ym,branch_id,rent,mgmt,supplies,telecom,misc,fee_pct)
                  VALUES(?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(ym,branch_id) DO UPDATE SET
                    rent=excluded.rent, mgmt=excluded.mgmt, supplies=excluded.supplies,
                    telecom=excluded.telecom, misc=excluded.misc, fee_pct=excluded.fee_pct`)
        .bind(uid(), ym, r.branch_id, +r.rent || 0, +r.mgmt || 0, +r.supplies || 0, +r.telecom || 0, +r.misc || 0, +r.fee_pct || 0)
    );
    if (stmts.length) await db.batch(stmts);
    return J({ ok: true });
  }

  /* ---------- 지점 ---------- */
  if (path === '/branches' && method === 'POST') {
    mustMgr();
    const cnt = await db.prepare('SELECT COUNT(*) AS n FROM branches').first();
    const b = Object.assign(
      { name: '', alias: '', memo: '', default_worker: null, sort: (cnt ? cnt.n : 0) + 1, active: 1 },
      pick('branches', body), { id: uid() }
    );
    if (!String(b.name || '').trim()) throw httpErr('지점명을 입력해 주세요');
    await insertStmt(db, 'branches', b).run();
    return J({ branch: await db.prepare('SELECT * FROM branches WHERE id=?').bind(b.id).first() });
  }
  if (seg[0] === 'branches' && seg[1] && method === 'PATCH') {
    mustMgr();
    const row = await db.prepare('SELECT id FROM branches WHERE id=?').bind(seg[1]).first();
    if (!row) throw httpErr('지점을 찾을 수 없습니다', 404);
    const st = updateStmt(db, 'branches', pick('branches', body), seg[1]); if (st) await st.run();
    return J({ branch: await db.prepare('SELECT * FROM branches WHERE id=?').bind(seg[1]).first() });
  }

  /* ---------- 체크리스트 항목 ---------- */
  if (path === '/check_items' && method === 'POST') {
    mustMgr();
    const it = Object.assign(
      { scope: 'common', branch_id: null, category: '기타', label: '', sort: 99, active: 1 },
      pick('check_items', body), { id: uid() }
    );
    if (!String(it.label || '').trim()) throw httpErr('항목 내용을 입력해 주세요');
    await insertStmt(db, 'check_items', it).run();
    return J({ item: await db.prepare('SELECT * FROM check_items WHERE id=?').bind(it.id).first() });
  }
  if (seg[0] === 'check_items' && seg[1] && method === 'PATCH') {
    mustMgr();
    const row = await db.prepare('SELECT id FROM check_items WHERE id=?').bind(seg[1]).first();
    if (!row) throw httpErr('항목을 찾을 수 없습니다', 404);
    const st = updateStmt(db, 'check_items', pick('check_items', body), seg[1]); if (st) await st.run();
    return J({ item: await db.prepare('SELECT * FROM check_items WHERE id=?').bind(seg[1]).first() });
  }
  if (seg[0] === 'check_items' && seg[1] && method === 'DELETE') {
    mustMgr();
    await db.prepare('DELETE FROM check_items WHERE id=?').bind(seg[1]).run();
    return J({ ok: true });
  }

  /* ---------- 계정 (대표 전용) ---------- */
  if (path === '/users' && method === 'POST') {
    if (me.role !== 'owner') throw httpErr('계정 관리는 대표만 가능합니다', 403);
    const username = String(body.username || '').trim();
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!username || !name || !password) throw httpErr('이름, 아이디, 비밀번호를 입력해 주세요');
    const dup = await db.prepare('SELECT id FROM users WHERE username=?').bind(username).first();
    if (dup) throw httpErr('이미 사용 중인 아이디입니다');
    const u = {
      id: uid(), username, pw: await hashPassword(password), name,
      role: body.role || 'worker', branch_ids: sj(Array.isArray(body.branch_ids) ? body.branch_ids : []),
      phone: String(body.phone || ''), active: 1
    };
    await insertStmt(db, 'users', u).run();
    return J({ user: rowUser(await db.prepare('SELECT * FROM users WHERE id=?').bind(u.id).first()) });
  }
  if (seg[0] === 'users' && seg[1] && method === 'PATCH') {
    if (me.role !== 'owner') throw httpErr('계정 관리는 대표만 가능합니다', 403);
    const row = await db.prepare('SELECT id FROM users WHERE id=?').bind(seg[1]).first();
    if (!row) throw httpErr('계정을 찾을 수 없습니다', 404);
    const patch = pick('users', body);
    if (body.password) patch.pw = await hashPassword(String(body.password));
    const st = updateStmt(db, 'users', patch, seg[1]); if (st) await st.run();
    if (patch.active === 0) await db.prepare('DELETE FROM sessions WHERE user_id=?').bind(seg[1]).run();
    return J({ user: rowUser(await db.prepare('SELECT * FROM users WHERE id=?').bind(seg[1]).first()) });
  }

  /* ---------- v2 · 지점 운영 프로필 ---------- */
  if (seg[0] === 'profiles' && seg[1] && method === 'POST') {
    mustMgr();
    const b = await db.prepare('SELECT id FROM branches WHERE id=?').bind(seg[1]).first();
    if (!b) throw httpErr('지점을 찾을 수 없습니다', 404);
    const numOr = v => (v == null || v === '' ? null : (Math.round(+v) || null));
    const pr = {
      region: String(body.region ?? ''), scode: String(body.scode ?? ''),
      default_worker: String(body.default_worker ?? ''),
      std_minutes: numOr(body.std_minutes), buffer_min: numOr(body.buffer_min),
      midday_deadline: body.midday_deadline ? String(body.midday_deadline) : null,
      notes: String(body.notes ?? ''), slots_json: body.slots_json ? String(body.slots_json) : ''
    };
    await db.prepare(`INSERT INTO branch_profiles(branch_id,region,scode,default_worker,std_minutes,buffer_min,midday_deadline,notes,slots_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(branch_id) DO UPDATE SET region=excluded.region, scode=excluded.scode, default_worker=excluded.default_worker,
        std_minutes=excluded.std_minutes, buffer_min=excluded.buffer_min, midday_deadline=excluded.midday_deadline,
        notes=excluded.notes, slots_json=excluded.slots_json, updated_at=excluded.updated_at`)
      .bind(seg[1], pr.region, pr.scode, pr.default_worker, pr.std_minutes, pr.buffer_min, pr.midday_deadline, pr.notes, pr.slots_json, nowIso()).run();
    return J({ profile: await db.prepare('SELECT * FROM branch_profiles WHERE branch_id=?').bind(seg[1]).first() });
  }

  /* ---------- v2 · 날짜×권역/지점 일괄 배정 ---------- */
  if (path === '/assignments' && method === 'POST') {
    mustMgr();
    const date = String(body.date || '').trim();
    if (!date) throw httpErr('날짜가 필요합니다');
    const region = String(body.region ?? ''), branch_id = String(body.branch_id ?? '');
    const worker = String(body.worker ?? '').trim();
    const ex = await db.prepare('SELECT id FROM assignments WHERE date=? AND region=? AND branch_id=?').bind(date, region, branch_id).first();
    if (!worker) {
      if (ex) await db.prepare('DELETE FROM assignments WHERE id=?').bind(ex.id).run();
      return J({ ok: true, removed: !!ex });
    }
    if (ex) {
      await db.prepare('UPDATE assignments SET worker=?, created_by=?, created_at=? WHERE id=?').bind(worker, me.name, nowIso(), ex.id).run();
      return J({ assignment: await db.prepare('SELECT * FROM assignments WHERE id=?').bind(ex.id).first() });
    }
    const aid = uid();
    await db.prepare('INSERT INTO assignments(id,date,region,branch_id,worker,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(aid, date, region, branch_id, worker, me.name, nowIso()).run();
    return J({ assignment: await db.prepare('SELECT * FROM assignments WHERE id=?').bind(aid).first() });
  }
  if (seg[0] === 'assignments' && seg[1] && method === 'DELETE') {
    mustMgr();
    await db.prepare('DELETE FROM assignments WHERE id=?').bind(seg[1]).run();
    return J({ ok: true });
  }

  /* ---------- v2 · 일일 브리핑(필수 확인사항) ---------- */
  if (path === '/notices' && method === 'POST') {
    mustMgr();
    const date = String(body.date || '').trim(), text = String(body.body || '').trim();
    if (!date || !text) throw httpErr('날짜와 내용을 입력해 주세요');
    const nid = uid();
    await db.prepare('INSERT INTO notices(id,date,body,created_by,created_at) VALUES(?,?,?,?,?)').bind(nid, date, text, me.name, nowIso()).run();
    return J({ notice: await db.prepare('SELECT * FROM notices WHERE id=?').bind(nid).first() });
  }
  if (seg[0] === 'notices' && seg[1] && seg[2] === 'read' && method === 'POST') {
    const n = await db.prepare('SELECT id FROM notices WHERE id=?').bind(seg[1]).first();
    if (!n) throw httpErr('브리핑을 찾을 수 없습니다', 404);
    if (body && body.undo) {
      await db.prepare('DELETE FROM notice_reads WHERE notice_id=? AND user_id=?').bind(seg[1], me.id).run();
      return J({ ok: true, read: false });
    }
    await db.prepare('INSERT OR REPLACE INTO notice_reads(notice_id,user_id,user_name,read_at) VALUES(?,?,?,?)').bind(seg[1], me.id, me.name, nowIso()).run();
    return J({ ok: true, read: true });
  }
  if (seg[0] === 'notices' && seg[1] && method === 'DELETE') {
    mustMgr();
    await db.prepare('DELETE FROM notices WHERE id=?').bind(seg[1]).run();
    await db.prepare('DELETE FROM notice_reads WHERE notice_id=?').bind(seg[1]).run();
    return J({ ok: true });
  }

  /* ---------- v2 · 계정별 청소 건당 단가 (대표 전용) ---------- */
  if (path === '/rates' && method === 'POST') {
    if (me.role !== 'owner') throw httpErr('단가 설정은 대표만 가능합니다', 403);
    const target = String(body.user_id || '');
    const rate = Math.max(0, Math.round(+body.rate || 0));
    const u = await db.prepare('SELECT id FROM users WHERE id=?').bind(target).first();
    if (!u) throw httpErr('계정을 찾을 수 없습니다', 404);
    await db.prepare('INSERT INTO user_rates(user_id,rate) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET rate=excluded.rate').bind(target, rate).run();
    return J({ ok: true, user_id: target, rate });
  }

  /* ---------- v2 · 예약 "확인 후 진행" 표시 ---------- */
  if (path === '/resissue' && method === 'POST') {
    mustMgr();
    const rid = String(body.res_id || '');
    const r = await db.prepare('SELECT id FROM reservations WHERE id=?').bind(rid).first();
    if (!r) throw httpErr('예약을 찾을 수 없습니다', 404);
    await db.prepare('UPDATE reservations SET issue=? WHERE id=?').bind(String(body.issue ?? ''), rid).run();
    return J({ reservation: await db.prepare('SELECT * FROM reservations WHERE id=?').bind(rid).first() });
  }

  /* ---------- v2 · 호스트 예약 동기화 (읽기 전용) ---------- */
  if (path === '/sync' && method === 'POST') {
    mustMgr();
    return J(await runSync(env, db, me));
  }
  if (path === '/hostmap' && method === 'POST') {
    mustMgr();
    await db.prepare("INSERT INTO app_settings(k,v) VALUES('host_map',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(sj(body.map || {})).run();
    return J({ ok: true });
  }

  /* ---------- 운영 설정 ---------- */
  if (path === '/settings' && method === 'POST') {
    mustMgr();
    await db.prepare("INSERT INTO app_settings(k,v) VALUES('settings',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .bind(sj(body.settings || {})).run();
    return J({ settings: body.settings || {} });
  }

  throw httpErr('알 수 없는 요청: ' + path, 404);
}


/* =====================================================================
   v2 · 호스트(ssople-host) 예약 동기화 — 같은 Cloudflare 계정 안에서
   HOSTDB 바인딩(읽기 전용 용도)으로 직접 읽습니다. 로그인 정보 불필요.
   호스트 DB에는 어떤 쓰기도 하지 않습니다.
   ===================================================================== */
const SYNC_BACK_DAYS = 35, SYNC_FWD_DAYS = 90;
const qid = id => '"' + String(id).replace(/"/g, '""') + '"';
const normKey = s => String(s || '').toLowerCase().replace(/[\s_\-]/g, '');
const normNm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
function normDate10(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/[./]/g, '-');
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}` : null;
}
function normTimeHM(v) {
  if (v == null) return null;
  const m = String(v).match(/(\d{1,2}):(\d{2})/);
  return m ? `${String(+m[1]).padStart(2, '0')}:${m[2]}` : null;
}
function pickCol(cols, cands) {
  const ks = cols.map(c => ({ raw: c, k: normKey(c) }));
  for (const cand of cands) { const t = normKey(cand); const hit = ks.find(x => x.k === t); if (hit) return hit.raw; }
  for (const cand of cands) { const t = normKey(cand); const hit = ks.find(x => x.k.includes(t) && t.length >= 3); if (hit) return hit.raw; }
  return null;
}
function slotFromRaw(raw, startHM) {
  const s = String(raw || '');
  if (/밤|야간|night/i.test(s)) return 'night';
  if (/올데이|종일|allday|all[\s_\-]?day|full/i.test(s)) return 'allday';
  if (/낮|주간|day/i.test(s)) return 'day';
  if (startHM) {
    const h = +startHM.slice(0, 2);
    if (h >= 18 || h < 6) return 'night';
    if (h >= 10 && h <= 14) return 'day';
    return 'allday';
  }
  return 'etc';
}

async function runSync(env, db, me) {
  if (!env || !env.HOSTDB) throw httpErr(
    '호스트 예약 DB(HOSTDB)가 아직 연결되지 않았습니다. Cloudflare Pages → 프로젝트 Settings → Bindings → Add → D1 database에서 '
    + 'Variable name을 HOSTDB, 데이터베이스를 ssople-host로 지정해 저장하고, Deployments에서 Retry deployment 해주세요. '
    + '이 연결은 예약을 읽는 데만 사용하며 호스트 DB에는 아무것도 쓰지 않습니다.', 500);
  const H = env.HOSTDB;

  /* 수동 매핑(있으면 우선) */
  let map = {};
  try { const r = await db.prepare("SELECT v FROM app_settings WHERE k='host_map'").first(); if (r) map = pj(r.v, {}) || {}; } catch (e) {}

  /* 예약 테이블 탐지 */
  const tbls = (await H.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(r => r.name);
  let tbl = map.table && tbls.includes(map.table) ? map.table : null;
  if (!tbl) tbl = tbls.find(n => /^reservations?$/i.test(n)) || tbls.find(n => /reserv|booking|예약/i.test(n));
  if (!tbl) throw httpErr('호스트 DB에서 예약 테이블을 찾지 못했습니다. (발견된 테이블: ' + tbls.join(', ') + ')');

  const cols = (await H.prepare(`PRAGMA table_info(${qid(tbl)})`).all()).results.map(r => r.name);
  const mc = map.cols || {};
  const col = {
    code:   mc.code   || pickCol(cols, ['branch_code', 'scode', 'space_code', 'store_code', 'shop_code', 'spot_code']),
    bname:  mc.bname  || pickCol(cols, ['branch_name', 'space_name', 'store_name', 'shop_name', 'room_name', 'branch', 'space']),
    date:   mc.date   || pickCol(cols, ['use_date', 'res_date', 'reserve_date', 'reservation_date', 'checkin_date', 'start_date', 'use_day', 'date', 'ymd']),
    slot:   mc.slot   || pickCol(cols, ['slot', 'time_slot', 'slot_type', 'time_type', 'session', 'kind']),
    start:  mc.start  || pickCol(cols, ['start_t', 'start_time', 'checkin_time', 'from_time', 'start']),
    end:    mc.end    || pickCol(cols, ['end_t', 'end_time', 'checkout_time', 'to_time', 'end']),
    cust:   mc.cust   || pickCol(cols, ['customer_name', 'customer', 'guest_name', 'booker_name', 'booker', 'user_name', 'name']),
    phone:  mc.phone  || pickCol(cols, ['phone', 'tel', 'mobile', 'contact', 'hp']),
    amount: mc.amount || pickCol(cols, ['total_amount', 'pay_amount', 'paid_amount', 'amount', 'price', 'total']),
    status: mc.status || pickCol(cols, ['status', 'state', 'pay_status', 'res_status']),
    resno:  mc.resno  || pickCol(cols, ['resno', 'reservation_no', 'res_no', 'booking_no', 'order_no', 'order_id', 'no', 'id']),
    memo:   mc.memo   || pickCol(cols, ['memo', 'note', 'request', 'requests', 'comment'])
  };
  if (!col.date) throw httpErr(`호스트 예약 테이블(${tbl})에서 날짜 컬럼을 찾지 못했습니다. (컬럼: ${cols.join(', ')})`);
  if (!col.resno) throw httpErr(`호스트 예약 테이블(${tbl})에서 예약번호 컬럼을 찾지 못했습니다. (컬럼: ${cols.join(', ')})`);
  if (!col.code && !col.bname) throw httpErr(`호스트 예약 테이블(${tbl})에서 지점 컬럼을 찾지 못했습니다. (컬럼: ${cols.join(', ')})`);

  const today = new Date().toISOString().slice(0, 10);
  const f = addDays(today, -SYNC_BACK_DAYS), t = addDays(today, SYNC_FWD_DAYS);
  const hostRows = (await H.prepare(`SELECT * FROM ${qid(tbl)} WHERE substr(${qid(col.date)},1,10)>=? AND substr(${qid(col.date)},1,10)<=?`)
    .bind(f, t).all()).results;

  /* 지점 매칭 준비: 프로필 S코드 → 지점명·별칭 순서 */
  const branches = (await db.prepare('SELECT id,name,alias FROM branches').all()).results;
  let profiles = [];
  try { profiles = (await db.prepare('SELECT branch_id,scode FROM branch_profiles').all()).results; }
  catch (e) { throw httpErr('v2 테이블이 아직 없습니다. D1 Console에서 upgrade_v2.sql을 1회 실행한 뒤 다시 시도해 주세요.'); }
  const byScode = {}; profiles.forEach(p => { if (p.scode) byScode[normNm(p.scode)] = p.branch_id; });
  const byName = {};
  branches.forEach(b => {
    byName[normNm(b.name)] = b.id;
    String(b.alias || '').split(',').map(a => a.trim()).filter(Boolean).forEach(a => { byName[normNm(a)] = b.id; });
  });

  const unmatched = new Set();
  const act = []; let skipped = 0;
  for (const hr of hostRows) {
    const rawNo = hr[col.resno];
    const resno = 'H' + String(rawNo == null ? '' : rawNo).trim();
    if (resno === 'H') { skipped++; continue; }
    const rd = normDate10(hr[col.date]);
    if (!rd) { skipped++; continue; }
    const stRaw = col.status ? String(hr[col.status] ?? '') : '';
    if (/취소|cancel|refund|환불/i.test(stRaw)) continue;   /* 취소분은 '활성 아님'으로만 취급 → 아래 제거 단계에서 정리 */
    let bid = null, blabel = '';
    if (col.code) {
      blabel = String(hr[col.code] ?? '').trim();
      if (blabel) bid = byScode[normNm(blabel)] || byName[normNm(blabel)] || null;
    }
    if (!bid && col.bname) {
      const nm = String(hr[col.bname] ?? '').trim();
      if (nm) {
        blabel = blabel || nm;
        bid = byName[normNm(nm)] || null;
        if (!bid) {
          const key = normNm(nm);
          const hit = Object.keys(byName).find(k => k && k.length >= 2 && (key.includes(k) || k.includes(key)));
          if (hit) bid = byName[hit];
        }
      }
    }
    if (!bid) { if (blabel) unmatched.add(blabel); skipped++; continue; }
    const start = normTimeHM(col.start ? hr[col.start] : null) || (String(hr[col.date] || '').length > 10 ? normTimeHM(hr[col.date]) : null);
    const end = normTimeHM(col.end ? hr[col.end] : null);
    act.push({
      resno, branch_id: bid, res_date: rd,
      slot: slotFromRaw(col.slot ? hr[col.slot] : null, start),
      customer: col.cust ? String(hr[col.cust] ?? '') : '',
      phone: col.phone ? String(hr[col.phone] ?? '') : '',
      amount: col.amount ? (parseInt(String(hr[col.amount] ?? '0').replace(/[^\d-]/g, ''), 10) || 0) : 0,
      status: '확정', start_t: start, end_t: end,
      memo: col.memo ? String(hr[col.memo] ?? '') : ''
    });
  }

  /* resno 기준 upsert + 창 안에서 사라진 동기화분 제거(취소 반영) */
  const exRows = (await db.prepare("SELECT * FROM reservations WHERE source='sync'").all()).results;
  const ex = new Map(exRows.map(r => [r.resno, r]));
  const activeSet = new Set(act.map(r => r.resno));
  const stmts = [];
  let added = 0, updated = 0, removed = 0;
  for (const r of act) {
    const e = ex.get(r.resno);
    if (!e) {
      stmts.push(insertStmt(db, 'reservations', Object.assign({ id: uid(), issue: '', source: 'sync', created_at: nowIso() }, r)));
      added++;
    } else {
      const diff = ['branch_id', 'res_date', 'slot', 'customer', 'phone', 'amount', 'start_t', 'end_t', 'memo']
        .some(k => String(e[k] ?? '') !== String(r[k] ?? ''));
      if (diff) {
        const st = updateStmt(db, 'reservations', {
          branch_id: r.branch_id, res_date: r.res_date, slot: r.slot, customer: r.customer, phone: r.phone,
          amount: r.amount, start_t: r.start_t, end_t: r.end_t, memo: r.memo
        }, e.id);
        if (st) stmts.push(st);
        updated++;
      }
    }
  }
  for (const e of exRows) {
    if (e.res_date >= f && e.res_date <= t && !activeSet.has(e.resno)) {
      stmts.push(db.prepare('DELETE FROM reservations WHERE id=?').bind(e.id));
      removed++;
    }
  }
  for (let i = 0; i < stmts.length; i += 60) await db.batch(stmts.slice(i, i + 60));

  const msg = `테이블 ${tbl} · 창 ${f}~${t}` + (unmatched.size ? ' · 미매칭 지점: ' + [...unmatched].slice(0, 8).join(', ') : ' · 전 지점 매칭');
  try {
    await db.prepare('INSERT INTO sync_log(ran_at,by_name,ok,added,updated,removed,skipped,message) VALUES(?,?,?,?,?,?,?,?)')
      .bind(nowIso(), me.name, 1, added, updated, removed, skipped, msg).run();
  } catch (e) {}
  return { ok: true, added, updated, removed, skipped, table: tbl, unmatched: [...unmatched], window: [f, t], ran_at: nowIso() };
}
