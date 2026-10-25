-- 0006. 운영 — 작업 큐, 감사 로그, 백업 이력
--
-- 기존 시스템은 엑셀 17종·Zip·백업·DWG 변환을 요청 스레드에서 동기 실행했다.
-- 여기서는 PostgreSQL 자체를 큐로 쓴다 (SKIP LOCKED + LISTEN/NOTIFY). Redis 불필요.

CREATE TABLE jobs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text        NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  state         text        NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued','running','done','failed','canceled')),
  priority      smallint    NOT NULL DEFAULT 100,
  progress      smallint    NOT NULL DEFAULT 0,
  progress_note text,
  result        jsonb,
  error         text,
  requested_by  bigint      REFERENCES users(id),
  attempts      smallint    NOT NULL DEFAULT 0,
  max_attempts  smallint    NOT NULL DEFAULT 3,
  locked_by     text,
  heartbeat_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
-- 워커 획득 전용 부분 인덱스
CREATE INDEX ix_jobs_pick    ON jobs (priority, id) WHERE state = 'queued';
-- 좀비 회수 (heartbeat 끊긴 running)
CREATE INDEX ix_jobs_zombie  ON jobs (heartbeat_at) WHERE state = 'running';
CREATE INDEX ix_jobs_user    ON jobs (requested_by, created_at DESC);

COMMENT ON TABLE jobs IS
  'kind: excel_export | zip_build | backup | convert | bulk_import | mirror | gc | audit_partition';

-- 작업 큐 알림 함수
CREATE OR REPLACE FUNCTION notify_job_enqueued() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('job_enqueued', NEW.id::text);
  RETURN NEW;
END $$;

CREATE TRIGGER trg_jobs_notify AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION notify_job_enqueued();

-- ── 감사 로그 (월 파티션, 영구 보존, 수정·삭제 불가) ──────────────────────
CREATE TABLE audit_log (
  id          bigint      GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id     bigint,
  user_name   text,                 -- 당시 이름 보존 (계정이 지워져도 기록은 남는다)
  screen      text,                 -- 'TDB 관리'
  action      text,                 -- '폴더 이동'
  target      text,                 -- 자료명 / 파일명
  detail      jsonb,
  client_ip   inet,
  request_id  text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX ix_audit_occurred ON audit_log USING brin (occurred_at);
CREATE INDEX ix_audit_user     ON audit_log (user_id, occurred_at DESC);
CREATE INDEX ix_audit_screen   ON audit_log (screen, occurred_at DESC);

COMMENT ON TABLE audit_log IS
  '삭제 불가. 애플리케이션 역할에서 DELETE/UPDATE 권한을 회수해 DB 수준에서 강제한다.';

-- 파티션 자동 생성 함수 (월간 잡이 호출)
CREATE OR REPLACE FUNCTION ensure_audit_partition(target date) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  s date := date_trunc('month', target)::date;
  e date := (date_trunc('month', target) + interval '1 month')::date;
  n text := 'audit_log_' || to_char(s, 'YYYYMM');
BEGIN
  IF to_regclass(n) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)', n, s, e);
  END IF;
END $$;

-- 이번 달과 다음 달
SELECT ensure_audit_partition(current_date);
SELECT ensure_audit_partition((current_date + interval '1 month')::date);

-- ── 백업 이력 ────────────────────────────────────────────────────────────
CREATE TABLE backup_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seq           integer     NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('FULL','INCREMENTAL')),
  scope         text[]      NOT NULL DEFAULT '{}',   -- 담을 항목 (DB/자료/코드/화면)
  set_key       text,
  storage_path  text,
  compressed    boolean     NOT NULL DEFAULT true,
  byte_size     bigint,
  file_count    integer,
  missing_count integer     NOT NULL DEFAULT 0,
  state         text        NOT NULL DEFAULT 'PREPARING'
                  CHECK (state IN ('PREPARING','READY','FAILED','FILE_DELETED')),
  job_id        bigint      REFERENCES jobs(id),
  download_count integer    NOT NULL DEFAULT 0,
  last_download_at timestamptz,
  note          text,
  created_by    bigint      REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_backup_runs_kind_seq ON backup_runs (kind, seq DESC);
CREATE INDEX ix_backup_runs_set_key  ON backup_runs (set_key);

COMMENT ON TABLE backup_runs IS
  '이력 줄은 어떤 경우에도 지워지지 않는다. 파일만 삭제되면 state=FILE_DELETED (기존 정책 유지).';
