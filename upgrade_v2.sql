-- =====================================================================
-- 쏘플 공간관리 시스템 · v1 → v2(1단계) 업그레이드
-- ---------------------------------------------------------------------
-- 사용법: Cloudflare 대시보드 → Storage & Databases → D1 → ssople-ops
--        → Console 탭 → 이 파일 내용 전체를 붙여넣고 실행(Execute)
-- 기존 테이블과 데이터는 전혀 건드리지 않고, 새 테이블만 추가합니다.
-- 여러 번 실행해도 안전합니다. (이미 있으면 건너뜁니다)
-- =====================================================================

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

-- 업그레이드 끝 — 파일 교체 후 이 SQL 1회 실행, HOSTDB 바인딩 추가(README 참고)까지 하면 완료입니다.
