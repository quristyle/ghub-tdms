import type { DocumentListQuery } from '@tdms/contracts'
import { Errors } from '../../core/errors.js'
import { encodeCursor } from '../../core/cursor.js'
import * as folders from '../folders/service.js'
import * as q from './queries.js'

export async function list(qp: DocumentListQuery) {
  const folderIds = await folders.scopeIds('TDB', qp.folderId, qp.recursive)

  const rows = await q.listDocuments(folderIds, qp)
  const hasMore = rows.length > qp.limit
  const items = hasMore ? rows.slice(0, qp.limit) : rows

  const last = items.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeCursor({ sortValue: last.updatedAt.toISOString(), id: last.id })
      : null

  // 총 건수는 비싸다 — 첫 페이지에서만 센다
  const total = qp.cursor ? null : await q.countDocuments(folderIds, qp)

  return {
    items: items.map(toListItem),
    nextCursor,
    total,
  }
}

export async function detail(id: number) {
  const row = await q.findDocument(id)
  if (!row) throw Errors.notFound('자료')

  const [chain, files] = await Promise.all([
    folders.ancestorChain(row.folderId),
    q.listDocumentFiles(id),
  ])

  return {
    ...toListItem(row),
    category: row.category,
    discipline: row.discipline,
    isblOsbl: row.isblOsbl,
    elevation: row.elevation,
    area: row.area,
    equipmentTag: row.equipmentTag,
    projectName: row.projectName,
    note: row.note,
    folderPath: chain,
    files: files.map((f) => ({
      ...f,
      uploadedAt: f.uploadedAt.toISOString(),
    })),
  }
}

function toListItem(r: q.DocumentListRow) {
  return {
    id: r.id,
    drawingNo: r.drawingNo,
    title: r.title,
    folderId: r.folderId,
    folderName: r.folderName,
    docType: r.docType,
    currentRev: r.currentRev,
    status: r.status as never,
    isIsometric: r.isIsometric,
    hasDwg: r.hasDwg,
    hasPdf: r.hasPdf,
    hasXlsx: r.hasXlsx,
    hasEtc: r.hasEtc,
    updatedAt: r.updatedAt.toISOString(),
    lentTo: r.lentTo,
    lentAt: r.lentAt ? r.lentAt.toISOString() : null,
  }
}
