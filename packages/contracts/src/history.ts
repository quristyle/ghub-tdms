import { z } from 'zod'

/** Revision 이력 — 기존 detail.html 의 'Revision 이력' 탭 */
export const RevisionEntry = z.object({
  rev: z.number().int(),
  branch: z.string().nullable(),
  /** 분기 리비전 표시: Rev3-a */
  label: z.string(),
  isCurrent: z.boolean(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  files: z.array(
    z.object({
      id: z.number().int(),
      fileExt: z.string(),
      displayName: z.string(),
      byteSize: z.number().int(),
      reviewStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ISSUE']),
      uploadedAt: z.string(),
    }),
  ),
})
export type RevisionEntry = z.infer<typeof RevisionEntry>

export const RevisionListResponse = z.object({ items: z.array(RevisionEntry) })
export type RevisionListResponse = z.infer<typeof RevisionListResponse>

/** 반출 이력 — 기존 detail.html 의 '반출 이력' 탭 */
export const DistributionPurpose = z.enum(['MODIFY', 'REFERENCE', 'ETC'])

export const DistributionEntry = z.object({
  id: z.number().int(),
  revAtDistribution: z.number().int(),
  vendorName: z.string(),
  projectName: z.string().nullable(),
  purpose: DistributionPurpose,
  purposeNote: z.string().nullable(),
  zipName: z.string().nullable(),
  distributedBy: z.string().nullable(),
  distributedAt: z.string(),
  returnedAt: z.string().nullable(),
  returnNote: z.string().nullable(),
  manualReturn: z.boolean(),
  note: z.string().nullable(),
  /** 화면 라벨: 반입완료 / 반입미완료 / 확인필요 / 검수대기 */
  state: z.enum(['RETURNED', 'OUTSTANDING', 'ISSUE', 'PENDING_REVIEW']),
})
export type DistributionEntry = z.infer<typeof DistributionEntry>

export const DistributionListResponse = z.object({ items: z.array(DistributionEntry) })
export type DistributionListResponse = z.infer<typeof DistributionListResponse>

/** 비고 작성 — 권한 common.note_edit.* 가 막는다 */
export const NoteRequest = z.object({ note: z.string().max(2000).nullable() })
export const NoteResult = z.object({ ok: z.literal(true) })

// 스키마에 대응하는 타입 — 화면에서 응답 타입을 그대로 쓴다
export type NoteRequest = z.infer<typeof NoteRequest>
export type NoteResult = z.infer<typeof NoteResult>
