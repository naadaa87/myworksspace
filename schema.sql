-- =====================================================================
-- 쏘플 공간관리 시스템 v2 · 데이터베이스 초기화 (Cloudflare D1)
-- ---------------------------------------------------------------------
-- 사용법: Cloudflare 대시보드 → Storage & Databases → D1
--        → 연결할 데이터베이스(예: ssople-ops) → Console 탭
--        → 이 파일 내용 전체를 붙여넣고 실행(Execute)
-- 여러 번 실행해도 안전합니다. (이미 있으면 건너뜁니다)
-- =====================================================================

-- ---------- 계정 · 세션 ----------
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pw TEXT NOT NULL,                       -- PBKDF2-SHA256 해시
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',    -- owner | manager | worker | facility
  branch_ids TEXT NOT NULL DEFAULT '[]',  -- 담당 지점 id 배열(JSON)
  phone TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- ---------- 지점 ----------
CREATE TABLE IF NOT EXISTS branches(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  alias TEXT DEFAULT '',                  -- 엑셀 지점명 매칭용 별칭(쉼표 구분)
  memo TEXT DEFAULT '',
  default_worker TEXT,
  sort INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- ---------- 청소 체크리스트 항목 ----------
CREATE TABLE IF NOT EXISTS check_items(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'common',   -- common(공통) | branch(지점 특별)
  branch_id TEXT,
  category TEXT DEFAULT '기타',
  label TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- ---------- 예약 ----------
CREATE TABLE IF NOT EXISTS reservations(
  id TEXT PRIMARY KEY,
  branch_id TEXT,
  res_date TEXT NOT NULL,                 -- YYYY-MM-DD
  slot TEXT DEFAULT 'etc',                -- day | night | allday | etc
  resno TEXT DEFAULT '',
  customer TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  amount INTEGER DEFAULT 0,
  status TEXT DEFAULT '확정',
  issue TEXT DEFAULT '',
  memo TEXT DEFAULT '',
  start_t TEXT,
  end_t TEXT,
  source TEXT DEFAULT 'manual',           -- excel(업로드) | manual(직접 입력)
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_res_date  ON reservations(res_date);
CREATE INDEX IF NOT EXISTS idx_res_resno ON reservations(resno);

-- ---------- 청소 수행 기록 ----------
CREATE TABLE IF NOT EXISTS cleanings(
  id TEXT PRIMARY KEY,
  task_key TEXT UNIQUE NOT NULL,          -- 지점|날짜|종류 (예약에서 자동 산출)
  branch_id TEXT,
  clean_date TEXT NOT NULL,
  kind TEXT DEFAULT 'etc',                -- day | mid | night | allday | etc
  assignee TEXT,
  status TEXT NOT NULL DEFAULT 'todo',    -- todo | done | redo | confirmed | skip
  checks TEXT NOT NULL DEFAULT '{}',      -- 항목별 체크(JSON)
  note TEXT DEFAULT '',
  submitted_by TEXT, submitted_at TEXT,
  review_by TEXT, review_at TEXT,
  feedback TEXT,
  manual INTEGER DEFAULT 0,
  window_label TEXT DEFAULT '',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_clean_date ON cleanings(clean_date);

-- ---------- 시설 이슈 ----------
CREATE TABLE IF NOT EXISTS issues(
  id TEXT PRIMARY KEY,
  branch_id TEXT,
  category TEXT DEFAULT '', equip TEXT DEFAULT '',
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  priority TEXT DEFAULT '보통',
  status TEXT NOT NULL DEFAULT '접수',    -- 접수 | 확인 | 진행중 | 완료 | 보류
  reporter TEXT DEFAULT '',
  assignee TEXT, cost INTEGER,
  comments TEXT NOT NULL DEFAULT '[]',    -- 처리 기록(JSON)
  created_at TEXT, resolved_at TEXT
);

-- ---------- 홍보 채널 ----------
CREATE TABLE IF NOT EXISTS channels(
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  url TEXT DEFAULT '',
  status TEXT DEFAULT '등록필요',          -- 운영중 | 등록필요 | 점검필요 | 중단
  owner TEXT DEFAULT '',
  last_check TEXT,
  memo TEXT DEFAULT '',
  sort INTEGER DEFAULT 0
);

-- ---------- 월별 비용(손익 계산용) ----------
CREATE TABLE IF NOT EXISTS costs(
  id TEXT PRIMARY KEY,
  ym TEXT NOT NULL,                       -- YYYY-MM
  branch_id TEXT NOT NULL,
  rent INTEGER DEFAULT 0, mgmt INTEGER DEFAULT 0, supplies INTEGER DEFAULT 0,
  telecom INTEGER DEFAULT 0, misc INTEGER DEFAULT 0,
  fee_pct REAL DEFAULT 0,                 -- 플랫폼 수수료(%)
  UNIQUE(ym, branch_id)
);

-- ---------- 운영 설정 ----------
CREATE TABLE IF NOT EXISTS app_settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- ---------- 지점 운영 프로필 (지점마다 다른 규칙·시간) ----------
CREATE TABLE IF NOT EXISTS branch_profiles(
  branch_id TEXT PRIMARY KEY,             -- branches.id 1:1
  region TEXT NOT NULL DEFAULT '',        -- 권역 (예: 신촌, 건대)
  scode TEXT NOT NULL DEFAULT '',         -- 지점 코드 (예: S-0012) · 호스트 동기화 매칭용
  default_worker TEXT NOT NULL DEFAULT '',-- 기본 담당자 이름
  std_minutes INTEGER,                    -- 표준 청소 소요(분) · 비우면 전역값
  buffer_min INTEGER,                     -- 다음 입실 전 완료 버퍼(분) · 비우면 전역값
  midday_deadline TEXT,                   -- 중간 정리 마감 시각 · 비우면 전역값
  notes TEXT NOT NULL DEFAULT '',         -- 지점 특이규칙 (줄바꿈 구분)
  slots_json TEXT NOT NULL DEFAULT '',    -- 운영시간 오버라이드 JSON · 비우면 전역값
  updated_at TEXT NOT NULL DEFAULT ''
);

-- ---------- 날짜×권역(또는 지점) 일괄 담당 배정 ----------
CREATE TABLE IF NOT EXISTS assignments(
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,                     -- YYYY-MM-DD
  region TEXT NOT NULL DEFAULT '',        -- 권역 단위 배정이면 권역명
  branch_id TEXT NOT NULL DEFAULT '',     -- 지점 단위 배정이면 지점 id
  worker TEXT NOT NULL DEFAULT '',        -- 담당자 이름
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assign_key ON assignments(date, region, branch_id);

-- ---------- 일일 브리핑(필수 확인사항) ----------
CREATE TABLE IF NOT EXISTS notices(
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,                     -- 대상 날짜
  body TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notices_date ON notices(date);

CREATE TABLE IF NOT EXISTS notice_reads(
  notice_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  read_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(notice_id, user_id)
);

-- ---------- 계정별 청소 건당 단가 (기본 15,000원은 코드 기본값) ----------
CREATE TABLE IF NOT EXISTS user_rates(
  user_id TEXT PRIMARY KEY,
  rate INTEGER NOT NULL DEFAULT 15000
);

-- ---------- 호스트 예약 동기화 기록 ----------
CREATE TABLE IF NOT EXISTS sync_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT, by_name TEXT, ok INTEGER,
  added INTEGER, updated INTEGER, removed INTEGER, skipped INTEGER,
  message TEXT
);

-- =====================================================================
-- 기본 데이터 (직영 5개 지점 · 공통 체크리스트 · 홍보 채널)
-- =====================================================================

-- 직영 지점
INSERT OR IGNORE INTO branches(id,name,alias,sort,active) VALUES('br-urban','신촌 어반홀리','어반홀리',1,1);
INSERT OR IGNORE INTO branches(id,name,alias,sort,active) VALUES('br-restel','신촌 레스텔','레스텔',2,1);
INSERT OR IGNORE INTO branches(id,name,alias,sort,active) VALUES('br-play2','신촌 플레이션 2호점','플레이션2호점,플레이션 2호점,신촌게임 플레이션 2',3,1);
INSERT OR IGNORE INTO branches(id,name,alias,sort,active) VALUES('br-play3','신촌 플레이션 3호점','플레이션3호점,플레이션 3호점,신촌게임플레이션3',4,1);
INSERT OR IGNORE INTO branches(id,name,alias,sort,active) VALUES('br-gundae','건대 플레이션 미니','건대플레이션,건대 플레이션',5,1);

-- 공통 청소 체크리스트 (운영 매뉴얼 8구역 기준)
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-01','common',NULL,'증빙·상태 확인','퇴실 직후 전체 영상 촬영(30초~1분)',1,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-02','common',NULL,'증빙·상태 확인','오염·파손·분실·흡연·구토 여부 확인',2,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-03','common',NULL,'증빙·상태 확인','차감 가능성 있으면 정리 전 사진 확보',3,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-04','common',NULL,'쓰레기·분리수거','쓰레기·음식물 수거 및 처리',4,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-05','common',NULL,'쓰레기·분리수거','분리수거(일반·플라스틱·캔·유리) / 문밖 무단배출 확인',5,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-06','common',NULL,'주방·설거지','설거지·식기 건조, 식기 수량 확인',6,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-07','common',NULL,'주방·설거지','싱크대·인덕션·조리대 정리',7,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-08','common',NULL,'주방·설거지','냉장고·전자레인지 내부 오염 확인',8,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-09','common',NULL,'실내 청소','테이블·소파 얼룩 제거 및 정돈',9,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-10','common',NULL,'실내 청소','바닥 청소기·밀대(머리카락·끈적임 확인)',10,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-11','common',NULL,'실내 청소','포토존·창틀·소품 정돈',11,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-12','common',NULL,'화장실','변기·세면대·거울 청소',12,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-13','common',NULL,'화장실','휴지·물비누 보충, 배수·냄새 확인',13,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-14','common',NULL,'기기·비품','전자기기·리모컨·마이크 원위치 및 작동 확인',14,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-15','common',NULL,'기기·비품','TV·와이파이·냉난방 작동 확인',15,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-16','common',NULL,'기기·비품','보드게임·소품 수량 확인',16,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-17','common',NULL,'마무리','환기·탈취 후 냉난방·조명·전원 정리',17,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-18','common',NULL,'마무리','소모품 재고 확인(휴지·물티슈·봉투·배터리)',18,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-19','common',NULL,'마무리','도어락 작동·문 잠금 확인',19,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-c-20','common',NULL,'마무리','청소 완료 사진 기록, 다음 예약 가능 상태 공유',20,1);

-- 게임 보유 지점 특별 항목
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-g-play2-1','branch','br-play2','지점 특별관리','PC·콘솔·게임패드 전원 및 파손 확인',1,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-g-play2-2','branch','br-play2','지점 특별관리','게임 타이틀·컨트롤러 수량 확인',2,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-g-play3-1','branch','br-play3','지점 특별관리','PC·콘솔·게임패드 전원 및 파손 확인',1,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-g-play3-2','branch','br-play3','지점 특별관리','게임 타이틀·컨트롤러 수량 확인',2,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-g-gundae-1','branch','br-gundae','지점 특별관리','PC·콘솔·게임패드 전원 및 파손 확인',1,1);
INSERT OR IGNORE INTO check_items(id,scope,branch_id,category,label,sort,active) VALUES('ci-g-gundae-2','branch','br-gundae','지점 특별관리','게임 타이틀·컨트롤러 수량 확인',2,1);

-- 지점별 홍보 채널 기본 목록
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-01','br-urban','네이버 플레이스·예약','등록필요',0);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-02','br-urban','네이버 지도·내비','등록필요',1);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-03','br-urban','네이버 블로그','등록필요',2);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-04','br-urban','스페이스클라우드','등록필요',3);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-05','br-urban','여기어때','등록필요',4);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-06','br-urban','프빗(Pvit)','등록필요',5);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-07','br-urban','인스타그램','등록필요',6);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-08','br-urban','유튜브','등록필요',7);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-09','br-urban','당근마켓','등록필요',8);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-10','br-urban','카카오톡 채널','등록필요',9);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-urban-11','br-urban','자체 홈페이지','등록필요',10);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-01','br-restel','네이버 플레이스·예약','등록필요',0);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-02','br-restel','네이버 지도·내비','등록필요',1);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-03','br-restel','네이버 블로그','등록필요',2);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-04','br-restel','스페이스클라우드','등록필요',3);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-05','br-restel','여기어때','등록필요',4);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-06','br-restel','프빗(Pvit)','등록필요',5);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-07','br-restel','인스타그램','등록필요',6);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-08','br-restel','유튜브','등록필요',7);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-09','br-restel','당근마켓','등록필요',8);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-10','br-restel','카카오톡 채널','등록필요',9);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-restel-11','br-restel','자체 홈페이지','등록필요',10);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-01','br-play2','네이버 플레이스·예약','등록필요',0);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-02','br-play2','네이버 지도·내비','등록필요',1);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-03','br-play2','네이버 블로그','등록필요',2);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-04','br-play2','스페이스클라우드','등록필요',3);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-05','br-play2','여기어때','등록필요',4);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-06','br-play2','프빗(Pvit)','등록필요',5);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-07','br-play2','인스타그램','등록필요',6);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-08','br-play2','유튜브','등록필요',7);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-09','br-play2','당근마켓','등록필요',8);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-10','br-play2','카카오톡 채널','등록필요',9);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play2-11','br-play2','자체 홈페이지','등록필요',10);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-01','br-play3','네이버 플레이스·예약','등록필요',0);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-02','br-play3','네이버 지도·내비','등록필요',1);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-03','br-play3','네이버 블로그','등록필요',2);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-04','br-play3','스페이스클라우드','등록필요',3);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-05','br-play3','여기어때','등록필요',4);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-06','br-play3','프빗(Pvit)','등록필요',5);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-07','br-play3','인스타그램','등록필요',6);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-08','br-play3','유튜브','등록필요',7);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-09','br-play3','당근마켓','등록필요',8);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-10','br-play3','카카오톡 채널','등록필요',9);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-play3-11','br-play3','자체 홈페이지','등록필요',10);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-01','br-gundae','네이버 플레이스·예약','등록필요',0);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-02','br-gundae','네이버 지도·내비','등록필요',1);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-03','br-gundae','네이버 블로그','등록필요',2);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-04','br-gundae','스페이스클라우드','등록필요',3);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-05','br-gundae','여기어때','등록필요',4);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-06','br-gundae','프빗(Pvit)','등록필요',5);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-07','br-gundae','인스타그램','등록필요',6);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-08','br-gundae','유튜브','등록필요',7);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-09','br-gundae','당근마켓','등록필요',8);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-10','br-gundae','카카오톡 채널','등록필요',9);
INSERT OR IGNORE INTO channels(id,branch_id,channel,status,sort) VALUES('ch-gundae-11','br-gundae','자체 홈페이지','등록필요',10);

-- 운영 시간 기본값 (설정 화면에서 변경 가능)
INSERT OR IGNORE INTO app_settings(k,v) VALUES('settings','{"times":{"day":["12:00","17:00"],"night":["19:00","10:00"],"allday":["12:00","22:00"]},"clean_before_min":30,"mid_deadline":"18:30","quick_items":["환기·탈취","테이블·바닥 간단 정리","쓰레기·음식물 정리","화장실 점검(휴지·물내림)","다음 예약 옵션·비품 준비 확인"]}');

-- 초기화 끝 — 사이트로 돌아가 새로고침하면 "처음 설정" 화면이 열립니다.
