-- 샘플 폴더·도면. 성능 검증용으로 충분한 양을 만든다.
-- 실제 이행 때는 이 파일 대신 기존 DB 에서 ETL 한다.

DO $$
DECLARE
  v_root     bigint;
  v_draw     bigint;
  v_piping   bigint;
  v_inst     bigint;
  v_iso      bigint;
  v_pid      bigint;
  v_mdb_root bigint;
  v_admin    bigint;
  v_proj     bigint;
  i          integer;
  v_folder   bigint;
BEGIN
  SELECT id INTO v_admin FROM users WHERE login_id = 'admin';
  SELECT id INTO v_proj  FROM projects WHERE name = 'G.Hub 신설';

  IF EXISTS (SELECT 1 FROM folders WHERE doc_class = 'TDB' AND parent_id IS NULL) THEN
    RAISE NOTICE '폴더가 이미 있습니다 — 건너뜀';
    RETURN;
  END IF;

  -- 원본 공유폴더 구조를 그대로 재현한 모양
  v_root   := folder_create('TDB', NULL,   '5. DRAWINGS',   v_admin, '05');
  v_draw   := folder_create('TDB', v_root, '5.1 PIPING',    v_admin, '01');
  v_piping := folder_create('TDB', v_draw, 'ISBL',          v_admin, '01');
  v_iso    := folder_create('TDB', v_draw, 'Isometric',     v_admin, '02');
  v_pid    := folder_create('TDB', v_root, '5.2 P&ID',      v_admin, '02');
  v_inst   := folder_create('TDB', v_root, '5.3 INSTRUMENT', v_admin, '03');

  v_mdb_root := folder_create('MDB', NULL, '7. DATA BOOK',  v_admin, '07');
  PERFORM folder_create('MDB', v_mdb_root, '7.1 기계',      v_admin, '01');
  PERFORM folder_create('MDB', v_mdb_root, '7.2 검사',      v_admin, '02');

  -- 일반 도면 600건
  FOR i IN 1..600 LOOP
    v_folder := CASE (i % 3) WHEN 0 THEN v_piping WHEN 1 THEN v_pid ELSE v_inst END;
    INSERT INTO documents (folder_id, drawing_no, title, doc_type, discipline,
                           isbl_osbl, area, project_id, is_isometric,
                           current_rev, status, has_dwg, has_pdf, updated_at)
    VALUES (v_folder,
            'GH-' || lpad(i::text, 5, '0'),
            CASE (i % 4)
              WHEN 0 THEN 'Piping Plan Area ' || (i % 12 + 1)
              WHEN 1 THEN 'P&ID ' || (i % 12 + 1) || ' 계통도'
              WHEN 2 THEN 'Instrument Loop ' || (i % 12 + 1)
              ELSE        'General Arrangement ' || (i % 12 + 1) END,
            CASE (i % 3) WHEN 0 THEN 'PIPING' WHEN 1 THEN 'P&ID' ELSE 'INSTRUMENT' END,
            CASE (i % 3) WHEN 0 THEN '배관' WHEN 1 THEN '공정' ELSE '계장' END,
            CASE WHEN i % 2 = 0 THEN 'ISBL' ELSE 'OSBL' END,
            'A' || (i % 12 + 1),
            v_proj, false,
            i % 4, 'ACTIVE',
            i % 2 = 0, true,
            now() - (i || ' hours')::interval);
  END LOOP;

  -- Isometric 1,400건 (전체의 약 70% — 실제 분포 재현)
  FOR i IN 1..1400 LOOP
    INSERT INTO documents (folder_id, drawing_no, title, doc_type, discipline,
                           project_id, is_isometric, current_rev, status,
                           has_dwg, has_pdf, updated_at)
    VALUES (v_iso,
            'GH-ISO-' || lpad(i::text, 5, '0'),
            'Isometric Line ' || lpad(i::text, 4, '0') || '-' || (i % 20 + 1) || '"',
            'Isometric', '배관', v_proj, true,
            i % 3, 'ACTIVE', true, true,
            now() - (i || ' minutes')::interval);
  END LOOP;

  RAISE NOTICE '폴더 9개, 도면 2000건 생성';
END $$;
