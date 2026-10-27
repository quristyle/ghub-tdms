/**
 * 권한 트리 — 기존 시스템 permission_tree.py 를 그대로 옮긴 것.
 *
 * 규칙 (2026-08-12 CM 확정, 그대로 승계)
 *  1. 트리 구조는 코드에 고정한다. 화면에서 노드를 추가·삭제할 수 없다.
 *     (화면에서 고치게 하면 실제 없는 기능에 권한이 생기거나, 새 기능에 권한 항목이
 *      안 생기는 어긋남이 발생한다.)
 *  2. 상위 노드를 Y 로 켜면 하위가 전부 Y 가 된다(화면 cascade). 저장은 항상 leaf 키.
 *  3. role=ADMIN 은 항상 전체 통과.
 *  4. 트리에 없는 기능은 로그인한 사람 누구나 쓴다.
 *  5. 화면 파일을 내려줄 때 서버가 먼저 권한을 본다. 화면 코드만으로 막지 않는다.
 */

export interface PermissionNode {
  key: string
  label: string
  desc?: string
  children?: PermissionNode[]
}

export const PERMISSION_TREE: readonly PermissionNode[] = [
  {
    key: 'screen.tdb_list',
    label: 'TDB 조회',
    children: [
      { key: 'screen.tdb_list.access', label: '페이지 접속', desc: 'N 선택시 TDB 조회 화면 접속이 안됨' },
      {
        key: 'screen.tdb_list.distribute',
        label: '반출 실행',
        children: [{ key: 'screen.tdb_list.distribute.modify', label: '수정용' }],
      },
    ],
  },
  {
    key: 'screen.tdb_import',
    label: 'TDB 반입·검수',
    children: [
      { key: 'screen.tdb_import.access', label: '페이지 접속', desc: 'N 선택시 TDB 반입·검수 화면 접속이 안됨' },
      { key: 'screen.tdb_import.register', label: '반입등록', desc: 'ALL은 조회, 클릭 등을 포함한 모든 기능' },
      {
        key: 'screen.tdb_import.review',
        label: '검수 대기',
        children: [
          { key: 'screen.tdb_import.review.approve', label: '승인' },
          { key: 'screen.tdb_import.review.reject', label: '반려' },
        ],
      },
      {
        key: 'screen.tdb_import.issue',
        label: '확인 필요',
        children: [
          { key: 'screen.tdb_import.issue.reattach', label: '자료 재첨부' },
          { key: 'screen.tdb_import.issue.repath', label: '경로 재선택' },
          { key: 'screen.tdb_import.issue.recheck', label: '재검수' },
          { key: 'screen.tdb_import.issue.reject', label: '반려' },
        ],
      },
    ],
  },
  {
    key: 'screen.tdb_editor',
    label: 'TDB 관리',
    children: [
      { key: 'screen.tdb_editor.access', label: '페이지 접속', desc: 'N 선택시 TDB 관리 화면 접속이 안됨' },
      { key: 'screen.tdb_editor.folder', label: '폴더편집' },
      { key: 'screen.tdb_editor.document', label: '자료편집' },
      { key: 'screen.tdb_editor.zip_register', label: 'Zip 폴더 업로드' },
      { key: 'screen.tdb_editor.retire', label: '폐기 보관함' },
      { key: 'screen.tdb_editor.restore', label: '삭제 보관함' },
    ],
  },
  {
    key: 'screen.tdb_distributions',
    label: 'TDB 반출이력',
    children: [
      { key: 'screen.tdb_distributions.access', label: '페이지 접속', desc: 'N 선택시 TDB 반출이력 화면 접속이 안됨' },
      {
        key: 'screen.tdb_distributions.viewer',
        label: '반출자 조회',
        children: [
          { key: 'screen.tdb_distributions.viewer.other_user', label: '다른 사용자 선택', desc: 'N 선택시 이름만 조회 가능' },
        ],
      },
      {
        key: 'screen.tdb_distributions.confirm',
        label: '확인',
        children: [
          { key: 'screen.tdb_distributions.confirm.manual_return', label: '수정없이 반납처리' },
        ],
      },
    ],
  },
  {
    key: 'screen.mdb_list',
    label: 'MDB 조회',
    children: [
      { key: 'screen.mdb_list.access', label: '페이지 접속', desc: 'N 선택시 MDB 조회 화면 접속이 안됨' },
    ],
  },
  {
    key: 'screen.mdb_editor',
    label: 'MDB 관리',
    children: [
      { key: 'screen.mdb_editor.access', label: '페이지 접속', desc: 'N 선택시 MDB 관리 화면 접속이 안됨' },
      { key: 'screen.mdb_editor.tag', label: '폴더 편집' },
      { key: 'screen.mdb_editor.document', label: '자료 편집' },
      { key: 'screen.mdb_editor.zip_register', label: 'Zip 폴더 업로드' },
      { key: 'screen.mdb_editor.retire', label: '폐기 보관함' },
      { key: 'screen.mdb_editor.restore', label: '삭제 보관함' },
    ],
  },
  {
    key: 'screen.audit',
    label: '시스템 로그',
    children: [
      { key: 'screen.audit.access', label: '페이지 접속', desc: 'N 선택시 시스템 로그 화면 접속이 안됨' },
      {
        key: 'screen.audit.viewer',
        label: '사용자 조회',
        children: [
          { key: 'screen.audit.viewer.other_user', label: '다른 사용자 선택', desc: 'N 선택시 이름만 조회 가능' },
        ],
      },
    ],
  },
  {
    key: 'screen.users',
    label: '사용자 관리',
    children: [
      { key: 'screen.users.access', label: '페이지 접속', desc: 'N 선택시 사용자 관리 화면 접속이 안됨' },
    ],
  },
  {
    key: 'screen.backup',
    label: '백업 관리',
    children: [
      { key: 'screen.backup.access', label: '페이지 접속', desc: 'N 선택시 백업 관리 화면 접속이 안됨' },
      { key: 'screen.backup.run', label: '백업 만들기·받기', desc: 'N 선택시 이력만 보이고 만들기·받기·비고 작성이 안됨' },
      {
        key: 'screen.backup.delete_file',
        label: '백업 파일 삭제',
        desc: 'N 선택시 이력 표의 [파일 삭제] 버튼이 눌리지 않음(이력 줄은 어떤 경우에도 안 지워짐)',
      },
    ],
  },
  {
    key: 'common',
    label: '공통',
    children: [
      {
        key: 'common.note_edit',
        label: '비고 작성',
        children: [
          { key: 'common.note_edit.revision', label: 'Revision 이력 비고 작성' },
          { key: 'common.note_edit.distribution', label: '반출 이력 비고 작성' },
          { key: 'common.note_edit.tdb_trash', label: 'TDB 삭제 보관함 비고 작성' },
          { key: 'common.note_edit.mdb_trash', label: 'MDB 삭제 보관함 비고 작성' },
        ],
      },
    ],
  },
] as const

function collectLeaves(nodes: readonly PermissionNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.children?.length) out.push(...collectLeaves(n.children))
    else out.push(n.key)
  }
  return out
}

/** 리프 권한 36개. 이 배열에 없는 키는 라우트에서 쓸 수 없다. */
export const LEAF_KEYS = collectLeaves(PERMISSION_TREE)
export const LEAF_KEY_SET: ReadonlySet<string> = new Set(LEAF_KEYS)

/** 라우트에 선언할 수 있는 권한 키. 오타가 컴파일 에러가 된다. */
export type PermissionKey = (typeof LEAF_KEYS)[number]

export function isPermissionKey(k: string): k is PermissionKey {
  return LEAF_KEY_SET.has(k)
}

/** 상위 노드를 켰을 때 함께 켜지는 리프들 (화면 cascade 용) */
export function leavesUnder(key: string): string[] {
  const find = (nodes: readonly PermissionNode[]): PermissionNode | undefined => {
    for (const n of nodes) {
      if (n.key === key) return n
      const hit = n.children && find(n.children)
      if (hit) return hit
    }
    return undefined
  }
  const node = find(PERMISSION_TREE)
  if (!node) return []
  return node.children?.length ? collectLeaves(node.children) : [node.key]
}

// ── 화면 ↔ 접속 권한 ────────────────────────────────────────────────────
// 서버(화면 파일 배포)와 클라이언트(상단 메뉴 숨김)가 이 한 곳을 함께 본다.
// 자료 상세는 여러 화면에서 공유하므로 넣지 않는다.

export const PAGE_PERMISSIONS = {
  'index.html': 'screen.tdb_list.access',
  'import.html': 'screen.tdb_import.access',
  'editor.html': 'screen.tdb_editor.access',
  'distributions.html': 'screen.tdb_distributions.access',
  'mdb.html': 'screen.mdb_list.access',
  'mdb-editor.html': 'screen.mdb_editor.access',
  'audit.html': 'screen.audit.access',
  'users.html': 'screen.users.access',
  'groups.html': 'screen.users.access',
  'backup.html': 'screen.backup.access',
} as const satisfies Record<string, PermissionKey>

/**
 * 상단 메뉴의 **씨앗이자 비상용 기본값**.
 *
 * 운영 중에는 DB 의 menus 테이블이 정본이다(0015 마이그레이션). 운영자가 메뉴관리
 * 화면에서 이름·순서·사용여부를 바꾸면 그쪽이 바뀐다. 이 배열은 두 가지로만 쓴다.
 *   1. 마이그레이션이 처음 채워 넣는 내용과 같아야 하는 기준
 *   2. menus 를 한 줄도 읽지 못했을 때의 되돌아갈 자리 (/auth/me)
 *
 * 앞의 9개는 레거시에서 그대로 옮겨 온 것이라 순서와 권한 키를 바꾸지 않는다.
 * 로그인 후 보낼 첫 화면을 고를 때도 이 차례를 쓴다.
 */
export const MENU: readonly {
  id: number
  code: string
  path: string
  label: string
  permission: PermissionKey
}[] = [
  { id: 1,  code: 'tdb_list',          path: '/',              label: 'TDB 조회',      permission: 'screen.tdb_list.access' },
  { id: 2,  code: 'tdb_import',        path: '/import',        label: 'TDB 반입·검수', permission: 'screen.tdb_import.access' },
  { id: 3,  code: 'tdb_editor',        path: '/editor',        label: 'TDB 관리',      permission: 'screen.tdb_editor.access' },
  { id: 4,  code: 'tdb_distributions', path: '/distributions', label: 'TDB 반출이력',  permission: 'screen.tdb_distributions.access' },
  { id: 5,  code: 'mdb_list',          path: '/mdb',           label: 'MDB 조회',      permission: 'screen.mdb_list.access' },
  { id: 6,  code: 'mdb_editor',        path: '/mdb-editor',    label: 'MDB 관리',      permission: 'screen.mdb_editor.access' },
  { id: 7,  code: 'audit',             path: '/audit',         label: '시스템 로그',   permission: 'screen.audit.access' },
  { id: 8,  code: 'users',             path: '/users',         label: '사용자 관리',   permission: 'screen.users.access' },
  { id: 9,  code: 'backup',            path: '/backup',        label: '백업 관리',     permission: 'screen.backup.access' },
  // 10번째 — 레거시에 없던 화면. 새 권한 리프를 만들지 않고 사용자·권한 관리와 같은 것을
  // 쓴다(리프 36개 패리티를 지키기 위해서다 — groups.html 이 쓰던 방식과 같다).
  { id: 10, code: 'menus',             path: '/menus',         label: '메뉴 관리',     permission: 'screen.users.access' },
  { id: 11, code: 'permissions',       path: '/permissions',   label: '접속권한 관리', permission: 'screen.users.access' },
  { id: 12, code: 'stamps',            path: '/stamps',        label: '스탬프 관리',   permission: 'screen.users.access' },
] as const
