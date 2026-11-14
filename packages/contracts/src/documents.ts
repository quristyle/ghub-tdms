import { z } from 'zod'
import { BoolParam, PageQuery, SortDir, pageResult } from './common.js'

/** 기존 화면의 상태·보유·검색대상 필터를 그대로 옮긴 것 */

export const DocStatus = z.enum(['ACTIVE', 'PENDING', 'SUPERSEDED', 'MERGE_REQUIRED', 'RETIRED'])
export type DocStatus = z.infer<typeof DocStatus>

/** 기존 화면 라벨: 전체 / 정상 / 검수 / 반출 / 삭제 */
export const StatusFilter = z.enum(['all', 'normal', 'review', 'distributed', 'archived'])

/** 기존 화면 라벨: 원본/사본 있음 / 원본만 있음 / 사본만 있음 */
export const HoldFilter = z.enum(['all', 'both', 'dwg_only', 'pdf_only'])

/** 기존 화면 라벨: 자료명 / 폴더명 */
export const SearchTarget = z.enum(['title', 'folder'])

/**
 * 정렬할 수 있는 칸.
 *
 * **서버가 정렬한다.** 불러온 200건만 정렬하면 "가장 큰 값"이 실제로는 아닐 수 있다 —
 * 38,000건 중 앞 200건만 보고 고른 것이기 때문이다.
 * keyset 커서도 이 칸을 기준으로 움직인다.
 */
export const DocumentSort = z.enum(['updatedAt', 'drawingNo', 'title', 'currentRev', 'docType'])
export type DocumentSort = z.infer<typeof DocumentSort>

/** 수정일 구간 — 목록 '최종수정' 색 단계와 정확히 같은 구간을 쓴다 */
export const ModifiedScope = z.enum(['D30', 'D31_90', 'D91'])
export type ModifiedScope = z.infer<typeof ModifiedScope>

/** 쿼리스트링의 같은 이름 여러 개(?modified=D30&modified=D91) — 하나만 오면 문자열로 온다 */
const ModifiedParam = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : Array.isArray(v) ? v : [v]),
  z.array(ModifiedScope).max(3).optional(),
)

export const DocumentListQuery = PageQuery.extend({
  sort: DocumentSort.default('updatedAt'),
  dir: SortDir.default('desc'),
  folderId: z.coerce.number().int().optional(),
  /** 하위 폴더까지 포함할지. 기본 true (기존 트리 탐색 동작) */
  recursive: BoolParam.default(true),
  q: z.string().max(200).optional(),
  searchTarget: SearchTarget.default('title'),
  /** Isometric 보기 — 기본 false. 전체의 63%라 켜면 목록이 뒤덮인다 */
  includeIsometric: BoolParam.default(false),
  status: StatusFilter.default('all'),
  hold: HoldFilter.default('all'),
  projectId: z.coerce.number().int().optional(),
  rev: z.coerce.number().int().optional(),
  docType: z.string().max(100).optional(),
  /**
   * 수정일 — 여러 구간을 함께 고를 수 있다. 셋을 다 고르면 전체와 같다.
   * 세 구간은 겹치지 않는다(오늘~30일 / 31~90일 / 91일 이전).
   */
  modified: ModifiedParam.optional(),
})
export type DocumentListQuery = z.infer<typeof DocumentListQuery>

export const DocumentListItem = z.object({
  id: z.number().int(),
  drawingNo: z.string(),
  title: z.string(),
  folderId: z.number().int(),
  folderName: z.string(),
  docType: z.string().nullable(),
  currentRev: z.number().int(),
  status: DocStatus,
  isIsometric: z.boolean(),
  hasDwg: z.boolean(),
  hasPdf: z.boolean(),
  hasXlsx: z.boolean(),
  hasEtc: z.boolean(),
  updatedAt: z.string(),
  /**
   * 등록 뒤 실제로 손댄 적이 있는가 — 목록 '최종수정' 색을 칠할지 가른다.
   * 등록만 되고 손댄 적 없는 자료는 그 날짜가 '등록한 날'이라 색을 칠하지 않는다.
   */
  isModified: z.boolean(),
  /** 대여중 표시 — LATERAL 로 목록 쿼리 한 번에 가져온다(N+1 금지) */
  lentTo: z.string().nullable(),
  lentAt: z.string().nullable(),
})
export type DocumentListItem = z.infer<typeof DocumentListItem>

export const DocumentListResponse = pageResult(DocumentListItem)
export type DocumentListResponse = z.infer<typeof DocumentListResponse>

export const DocumentFile = z.object({
  id: z.number().int(),
  rev: z.number().int(),
  branch: z.string().nullable(),
  fileExt: z.string(),
  displayName: z.string(),
  byteSize: z.number().int(),
  reviewStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ISSUE']),
  isCurrent: z.boolean(),
  uploadedAt: z.string(),
  uploadedBy: z.string().nullable(),
  note: z.string().nullable(),
})

export const DocumentDetail = DocumentListItem.extend({
  category: z.string().nullable(),
  discipline: z.string().nullable(),
  isblOsbl: z.string().nullable(),
  elevation: z.string().nullable(),
  area: z.string().nullable(),
  equipmentTag: z.string().nullable(),
  projectName: z.string().nullable(),
  folderPath: z.array(z.object({ id: z.number().int(), name: z.string() })),
  note: z.string().nullable(),
  files: z.array(DocumentFile),
})
export type DocumentDetail = z.infer<typeof DocumentDetail>

// ── 상세 화면의 처음·이전·다음·끝 ───────────────────────────────────────
// 기존 detail.js 는 "방금 다녀온 목록의 순서" 를 따라간다. 목록 화면이 지금 검색조건을
// sessionStorage 에 남기고, 상세 화면이 그 조건 그대로 여기에 묻는다.

export const DocumentNavQuery = DocumentListQuery.omit({ cursor: true, limit: true }).extend({
  /** 지금 보고 있는 자료 */
  id: z.coerce.number().int().optional(),
  /** "n / 전체" 칸에 번호를 넣었을 때 — 1부터. 주면 id 대신 이 자리를 기준으로 삼는다 */
  at: z.coerce.number().int().min(1).optional(),
})
export type DocumentNavQuery = z.infer<typeof DocumentNavQuery>

export const DocumentNav = z.object({
  /** 기준 자료 — at 으로 물었으면 그 자리의 자료 */
  currentId: z.number().int().nullable(),
  /** 1부터. 목록에 없으면(직접 접근·조건 밖) null — 화면은 버튼을 끈다 */
  position: z.number().int().nullable(),
  total: z.number().int(),
  firstId: z.number().int().nullable(),
  prevId: z.number().int().nullable(),
  nextId: z.number().int().nullable(),
  lastId: z.number().int().nullable(),
})
export type DocumentNav = z.infer<typeof DocumentNav>

// ── 폴더 반출 ────────────────────────────────────────────────────────────
// 체크와 무관하게, 고른 폴더(하위 포함)의 자료 전부를 반출대기함에 담는다 (기존 ids-by-path).
// 대기함 표(자료명·분류·경로)를 그리려면 id 만으로는 모자라 목록 줄 그대로 준다.

export const FolderDocumentsQuery = z.object({
  folderId: z.coerce.number().int(),
  recursive: BoolParam.default(true),
  includeIsometric: BoolParam.default(false),
})
export type FolderDocumentsQuery = z.infer<typeof FolderDocumentsQuery>

export const FolderDocumentsResponse = z.object({ items: z.array(DocumentListItem) })
export type FolderDocumentsResponse = z.infer<typeof FolderDocumentsResponse>

// ── TDB 수정 (최근수정본) ────────────────────────────────────────────────
// 기존 documents.py recent-changes. "요즘 뭐가 바뀌었나" 를 한 번에 본다.
// 수정 판단은 documents.updated_at 하나로 한다 — 목록의 "최종수정" 과 같은 값이라
// 화면과 팝업이 어긋나지 않는다.

/** 기존 화면의 기준일 — 오늘~30일(진한 색) / 31~90일(연한 색) */
export const RECENT_STRONG_DAYS = 30
export const RECENT_SOFT_DAYS = 90

export const RecentChangesQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(RECENT_SOFT_DAYS),
})
export type RecentChangesQuery = z.infer<typeof RecentChangesQuery>

/** 화면 라벨: Rev a → b / 일반 수정 */
export const RecentChangeKind = z.enum(['REVISION', 'INFO'])

export const RecentChangeItem = z.object({
  /** 그리드 열쇠 — 자료 id */
  id: z.number().int(),
  drawingNo: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  path: z.string(),
  updatedAt: z.string(),
  currentRev: z.number().int(),
  changeKind: RecentChangeKind,
  revFrom: z.number().int().nullable(),
  revTo: z.number().int().nullable(),
  vendorName: z.string().nullable(),
  projectName: z.string().nullable(),
  changedBy: z.string().nullable(),
})
export type RecentChangeItem = z.infer<typeof RecentChangeItem>

export const RecentChangesResponse = z.object({
  days: z.number().int(),
  total: z.number().int(),
  revisionCount: z.number().int(),
  items: z.array(RecentChangeItem),
})
export type RecentChangesResponse = z.infer<typeof RecentChangesResponse>

export const RecentChangesSummary = z.object({ count: z.number().int() })
export type RecentChangesSummary = z.infer<typeof RecentChangesSummary>
