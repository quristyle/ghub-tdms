-- 0007. 폴더 보조 함수와 자료 수 집계 트리거
--
-- ltree path 의 라벨은 폴더 id 다. id 는 INSERT 해 봐야 알 수 있으므로
-- 넣은 뒤 path 를 채운다. 이 두 단계를 한 함수로 묶어 호출부가 틀릴 수 없게 한다.

CREATE OR REPLACE FUNCTION folder_create(
  p_doc_class text,
  p_parent_id bigint,
  p_name      text,
  p_created_by bigint DEFAULT NULL,
  p_sort_key  text    DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_id          bigint;
  v_parent_path ltree;
BEGIN
  IF p_parent_id IS NOT NULL THEN
    SELECT path INTO v_parent_path FROM folders WHERE id = p_parent_id;
    IF v_parent_path IS NULL THEN
      RAISE EXCEPTION '상위 폴더를 찾을 수 없습니다: %', p_parent_id;
    END IF;
  END IF;

  INSERT INTO folders (parent_id, doc_class, name, path, created_by, sort_key)
  VALUES (p_parent_id, p_doc_class, p_name, 'tmp'::ltree, p_created_by, p_sort_key)
  RETURNING id INTO v_id;

  UPDATE folders
     SET path = CASE WHEN v_parent_path IS NULL
                     THEN v_id::text::ltree
                     ELSE v_parent_path || v_id::text::ltree END
   WHERE id = v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION folder_create IS
  'ltree 라벨에 폴더 id 를 쓴다. 이름을 바꿔도 path 가 변하지 않아 하위 갱신이 없다.';

-- 폴더 이동: 자신과 하위 전체의 path 접두어를 교체한다.
-- 이름 변경은 name 만 바꾸면 되므로 별도 함수가 필요 없다.
CREATE OR REPLACE FUNCTION folder_reparent(
  p_id            bigint,
  p_new_parent_id bigint
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_old_path ltree;
  v_new_path ltree;
  v_parent   ltree;
  v_count    integer;
BEGIN
  SELECT path INTO v_old_path FROM folders WHERE id = p_id;
  IF v_old_path IS NULL THEN
    RAISE EXCEPTION '폴더를 찾을 수 없습니다: %', p_id;
  END IF;

  IF p_new_parent_id IS NULL THEN
    v_new_path := p_id::text::ltree;
  ELSE
    SELECT path INTO v_parent FROM folders WHERE id = p_new_parent_id;
    IF v_parent IS NULL THEN
      RAISE EXCEPTION '상위 폴더를 찾을 수 없습니다: %', p_new_parent_id;
    END IF;
    -- 자기 자신 또는 자기 하위로 옮기는 것은 막는다 (순환 방지)
    IF v_parent <@ v_old_path THEN
      RAISE EXCEPTION '폴더를 자기 하위로 옮길 수 없습니다';
    END IF;
    v_new_path := v_parent || p_id::text::ltree;
  END IF;

  UPDATE folders
     SET path = v_new_path || subpath(path, nlevel(v_old_path)),
         updated_at = now()
   WHERE path <@ v_old_path AND id <> p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE folders
     SET path = v_new_path, parent_id = p_new_parent_id, updated_at = now()
   WHERE id = p_id;

  RETURN v_count;
END $$;

-- ── doc_count 유지 (트리 배지) ──────────────────────────────────────────
-- 자기 폴더와 모든 조상의 수를 함께 올리고 내린다.

CREATE OR REPLACE FUNCTION bump_folder_count(p_folder_id bigint, p_delta integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE folders a
     SET doc_count = GREATEST(0, a.doc_count + p_delta)
    FROM folders f
   WHERE f.id = p_folder_id AND a.path @> f.path;
END $$;

CREATE OR REPLACE FUNCTION trg_document_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.is_archived THEN PERFORM bump_folder_count(NEW.folder_id, 1); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT OLD.is_archived THEN PERFORM bump_folder_count(OLD.folder_id, -1); END IF;
  ELSE
    IF OLD.folder_id IS DISTINCT FROM NEW.folder_id
       OR OLD.is_archived IS DISTINCT FROM NEW.is_archived THEN
      IF NOT OLD.is_archived THEN PERFORM bump_folder_count(OLD.folder_id, -1); END IF;
      IF NOT NEW.is_archived THEN PERFORM bump_folder_count(NEW.folder_id, 1); END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_documents_count
  AFTER INSERT OR UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION trg_document_count();

CREATE OR REPLACE FUNCTION trg_mdb_file_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.is_archived THEN PERFORM bump_folder_count(NEW.folder_id, 1); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT OLD.is_archived THEN PERFORM bump_folder_count(OLD.folder_id, -1); END IF;
  ELSE
    IF OLD.folder_id IS DISTINCT FROM NEW.folder_id
       OR OLD.is_archived IS DISTINCT FROM NEW.is_archived THEN
      IF NOT OLD.is_archived THEN PERFORM bump_folder_count(OLD.folder_id, -1); END IF;
      IF NOT NEW.is_archived THEN PERFORM bump_folder_count(NEW.folder_id, 1); END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_mdb_files_count
  AFTER INSERT OR UPDATE OR DELETE ON mdb_files
  FOR EACH ROW EXECUTE FUNCTION trg_mdb_file_count();

-- ── 감사 로그 불변 강제 ─────────────────────────────────────────────────
-- 애플리케이션이 쓰는 역할이 따로 있을 때 REVOKE 로 막는 것이 원칙이지만,
-- 현재는 소유자 한 계정으로 운영하므로 트리거로 막는다.
CREATE OR REPLACE FUNCTION trg_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '감사 로그는 수정·삭제할 수 없습니다';
END $$;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION trg_audit_immutable();
