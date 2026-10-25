-- 기본 시드: 관리자 계정, 권한 그룹, 분류 목록, 샘플 폴더·도면.
-- 재실행해도 안전하다 (ON CONFLICT DO NOTHING).

-- ── 그룹 ────────────────────────────────────────────────────────────────
INSERT INTO groups (name, description) VALUES
  ('설비기술팀', '전체 기능 사용'),
  ('조회전용',   'TDB·MDB 조회만')
ON CONFLICT (name) DO NOTHING;

-- 설비기술팀: 리프 36개 중 '페이지 접속' 전부 + 주요 기능
INSERT INTO group_permissions (group_id, permission_key)
SELECT g.id, k FROM groups g, unnest(ARRAY[
  'screen.tdb_list.access','screen.tdb_list.distribute.modify',
  'screen.tdb_import.access','screen.tdb_import.register',
  'screen.tdb_import.review.approve','screen.tdb_import.review.reject',
  'screen.tdb_import.issue.reattach','screen.tdb_import.issue.repath',
  'screen.tdb_import.issue.recheck','screen.tdb_import.issue.reject',
  'screen.tdb_editor.access','screen.tdb_editor.folder','screen.tdb_editor.document',
  'screen.tdb_editor.zip_register','screen.tdb_editor.retire','screen.tdb_editor.restore',
  'screen.tdb_distributions.access','screen.tdb_distributions.viewer.other_user',
  'screen.tdb_distributions.confirm.manual_return',
  'screen.mdb_list.access',
  'screen.mdb_editor.access','screen.mdb_editor.tag','screen.mdb_editor.document',
  'screen.mdb_editor.zip_register','screen.mdb_editor.retire','screen.mdb_editor.restore',
  'screen.audit.access','screen.audit.viewer.other_user',
  'screen.backup.access','screen.backup.run',
  'common.note_edit.revision','common.note_edit.distribution',
  'common.note_edit.tdb_trash','common.note_edit.mdb_trash'
]) AS k
WHERE g.name = '설비기술팀'
ON CONFLICT DO NOTHING;

-- 조회전용: 두 화면 접속만
INSERT INTO group_permissions (group_id, permission_key)
SELECT g.id, k FROM groups g, unnest(ARRAY[
  'screen.tdb_list.access','screen.mdb_list.access'
]) AS k
WHERE g.name = '조회전용'
ON CONFLICT DO NOTHING;

-- ── 계정 ────────────────────────────────────────────────────────────────
-- 비밀번호는 모두 초기값 규칙 'ghub' + 아이디. 첫 로그인 때 변경 화면이 열린다.
-- 해시는 db/seed/hash.mjs 가 채운다 (여기서는 자리만 만든다).
INSERT INTO users (login_id, name, password_hash, role, group_id, must_change_password)
SELECT 'admin', '관리자', '!', 'ADMIN', g.id, true
  FROM groups g WHERE g.name = '설비기술팀'
ON CONFLICT (login_id) DO NOTHING;

INSERT INTO users (login_id, name, password_hash, role, group_id, must_change_password)
SELECT 'cm', '설비기술팀 CM', '!', 'VIEWER', g.id, true
  FROM groups g WHERE g.name = '설비기술팀'
ON CONFLICT (login_id) DO NOTHING;

INSERT INTO users (login_id, name, password_hash, role, group_id, must_change_password)
SELECT 'viewer', '조회 사용자', '!', 'VIEWER', g.id, true
  FROM groups g WHERE g.name = '조회전용'
ON CONFLICT (login_id) DO NOTHING;

-- ── 분류 목록 ───────────────────────────────────────────────────────────
INSERT INTO projects (name) VALUES ('G.Hub 신설'), ('정기보수 2026'), ('공통')
ON CONFLICT DO NOTHING;

INSERT INTO vendors (name) VALUES ('대한엔지니어링'), ('한성플랜트'), ('사내')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_types (name) VALUES
  ('Pump'), ('Compressor'), ('Vessel'), ('Heat Exchanger'), ('Tank')
ON CONFLICT DO NOTHING;

INSERT INTO mdb_doc_types (name) VALUES
  ('Mechanical Data Book'), ('Inspection Data Book'), ('안전관련'), ('마감보고서')
ON CONFLICT DO NOTHING;

INSERT INTO mdb_tag_change_reasons (name) VALUES
  ('설비 교체'), ('Tag 체계 변경'), ('오기 정정')
ON CONFLICT DO NOTHING;
