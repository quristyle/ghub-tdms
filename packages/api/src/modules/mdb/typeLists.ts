import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  ErrorResponse, NoteResult, TypeListQuery, TypeListResponse, TypeNameRequest, TypeRenameResult,
  type TypeListKind,
} from '@tdms/contracts'
import { AUTHENTICATED, defineRoute, permission } from '../../core/route.js'
import { many, tx } from '../../core/db.js'
import { Errors } from '../../core/errors.js'
import { invalidate } from '../../core/cache.js'
import { SEPARATOR, renameType } from './grouping.js'

/**
 * 드롭다운에서 고르는 "값 목록" 세 가지 — 설비유형 · 자료유형 · Tag No 변경사유.
 * 기존 type_lists.py 의 팩토리를 그대로 옮겼다 (한 벌로 만들고 표·컬럼·이름만 바꿔 끼운다).
 *
 * mdb_files 의 값은 이 표를 가리키는 외래키가 아니라 **이름 문자열**이다. 그래서
 *   · 이름을 바꾸면 그 이름을 들고 있는 자료의 값도 함께 갈아끼운다 ("Pump/Strainer" 의 조각만)
 *   · 목록에서 지워도 이미 지정된 자료의 값은 그대로 남는다 — 새로 고를 후보에서만 빠진다
 *   · 변경사유는 자료가 값을 들고 있지 않다(이력 문장에 이미 적혀 나간 것은 그때의 기록이다)
 * 이름에는 슬래시를 쓸 수 없다 — 여러 값을 잇는 구분자라 두 개로 쪼개져 보인다.
 */

interface ListSpec {
  kind: TypeListKind
  table: string
  /** 자료 쪽에서 이 값을 들고 있는 컬럼. 없으면 이름을 바꿔도 자료는 손대지 않는다. */
  column: 'equipment_type' | 'doc_type' | null
  /** 갈아끼운 뒤 알파벳순으로 다시 정렬할지 (자료유형만) */
  sort: boolean
  label: string
}

const SPECS: ListSpec[] = [
  { kind: 'equipment-types', table: 'equipment_types', column: 'equipment_type', sort: false, label: '설비유형' },
  { kind: 'mdb-doc-types', table: 'mdb_doc_types', column: 'doc_type', sort: true, label: '자료유형' },
  { kind: 'mdb-tag-reasons', table: 'mdb_tag_change_reasons', column: null, sort: false, label: '사유' },
]

const EDIT = 'MDB 관리'
const IdParam = z.object({ id: z.coerce.number().int() })

interface Row { id: number; name: string; isHidden: boolean }

function cleanName(raw: string, label: string): string {
  const name = (raw ?? '').trim()
  if (!name) throw Errors.invalid('NAME_REQUIRED', `${label}명을 입력해 주세요.`)
  if (name.includes(SEPARATOR)) {
    throw Errors.invalid(
      'NAME_HAS_SEPARATOR',
      `${label}명에는 '${SEPARATOR}' 를 쓸 수 없습니다 (여러 ${label}을 구분하는 기호입니다).`,
    )
  }
  return name
}

/** 고를 수 있는 이름 목록 — 다른 모듈(Tag 이력 meta 등)에서 쓴다 */
export async function visibleNames(kind: TypeListKind): Promise<string[]> {
  const spec = SPECS.find((s) => s.kind === kind)!
  const rows = await many<{ name: string }>(
    `SELECT name FROM ${spec.table} WHERE NOT is_hidden ORDER BY lower(name)`,
  )
  return rows.map((r) => r.name)
}

export function registerTypeListRoutes(app: FastifyInstance): void {
  for (const spec of SPECS) {
    const base = `/${spec.kind}`
    const SELECT = `SELECT id, name, is_hidden AS "isHidden" FROM ${spec.table}`

    // 대소문자·공백 차이만으로 다른 값이 되지 않게 숨김 여부와 무관하게 검사한다
    const duplicateOf = async (c: import('pg').PoolClient, name: string, exceptId: number | null) => {
      const r = await c.query<{ name: string }>(
        `SELECT name FROM ${spec.table}
          WHERE lower(name) = lower($1) AND ($2::bigint IS NULL OR id <> $2) LIMIT 1`,
        [name, exceptId],
      )
      return r.rows[0]?.name ?? null
    }
    const getOr404 = async (c: import('pg').PoolClient, id: number) => {
      const r = await c.query<Row>(`${SELECT} WHERE id = $1 FOR UPDATE`, [id])
      if (!r.rows[0]) throw Errors.notFound(spec.label)
      return r.rows[0]
    }

    // 드롭다운은 숨긴 것을 빼고, 목록 편집 팝업은 includeHidden=true 로 숨긴 것까지 받는다
    defineRoute(app, {
      method: 'GET',
      url: base,
      access: AUTHENTICATED,
      schema: { querystring: TypeListQuery, response: { 200: TypeListResponse } },
      handler: async (req) => {
        const { includeHidden } = TypeListQuery.parse(req.query)
        const items = await many<Row>(
          `${SELECT} ${includeHidden ? '' : 'WHERE NOT is_hidden'} ORDER BY lower(name)`,
        )
        return { items }
      },
    })

    defineRoute(app, {
      method: 'POST',
      url: base,
      access: permission('screen.mdb_editor.document'),
      audit: { screen: EDIT, action: `${spec.label} 목록 추가` },
      schema: {
        body: TypeNameRequest,
        response: { 200: TypeRenameResult, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
      },
      handler: async (req) => {
        const name = cleanName(TypeNameRequest.parse(req.body).name, spec.label)
        const item = await tx(async (c) => {
          const dup = await duplicateOf(c, name, null)
          if (dup) throw Errors.conflict('DUPLICATE', `이미 등록된 ${spec.label}입니다: ${dup}`)
          const r = await c.query<Row>(
            `INSERT INTO ${spec.table} (name) VALUES ($1)
             RETURNING id, name, is_hidden AS "isHidden"`,
            [name],
          )
          return r.rows[0]!
        })
        req.setAuditTarget(name, { id: item.id })
        return { item, updatedFiles: 0 }
      },
    })

    defineRoute(app, {
      method: 'PATCH',
      url: `${base}/:id`,
      access: permission('screen.mdb_editor.document'),
      audit: { screen: EDIT, action: `${spec.label} 목록 이름 변경` },
      schema: {
        params: IdParam, body: TypeNameRequest,
        response: {
          200: TypeRenameResult, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse,
        },
      },
      handler: async (req) => {
        const { id } = IdParam.parse(req.params)
        const name = cleanName(TypeNameRequest.parse(req.body).name, spec.label)
        const out = await tx(async (c) => {
          const item = await getOr404(c, id)
          const dup = await duplicateOf(c, name, id)
          if (dup) throw Errors.conflict('DUPLICATE', `이미 등록된 ${spec.label}입니다: ${dup}`)

          // 이 이름을 들고 있는 자료의 값도 함께 바꾼다 — 조각 단위로 (Pump/Strainer)
          let updatedFiles = 0
          if (spec.column) {
            const col = spec.column
            const rows = await c.query<{ id: number; v: string }>(
              `SELECT id, ${col} AS v FROM mdb_files
                WHERE ${col} IS NOT NULL AND position(lower($1) in lower(${col})) > 0`,
              [item.name],
            )
            const ids: number[] = []
            const vals: (string | null)[] = []
            for (const r of rows.rows) {
              const next = renameType(r.v, item.name, name, spec.sort)
              if (next.changed) { ids.push(r.id); vals.push(next.value) }
            }
            if (ids.length) {
              const u = await c.query(
                `UPDATE mdb_files m SET ${col} = u.v, updated_at = now()
                   FROM unnest($1::bigint[], $2::text[]) AS u(id, v)
                  WHERE m.id = u.id`,
                [ids, vals],
              )
              updatedFiles = u.rowCount ?? 0
            }
          }
          const r = await c.query<Row>(
            `UPDATE ${spec.table} SET name = $2 WHERE id = $1
             RETURNING id, name, is_hidden AS "isHidden"`,
            [id, name],
          )
          return { item: r.rows[0]!, updatedFiles, oldName: item.name }
        })
        await invalidate('cache_types')
        req.setAuditTarget(`${out.oldName} → ${name}`, { id, updatedFiles: out.updatedFiles })
        return { item: out.item, updatedFiles: out.updatedFiles }
      },
    })

    for (const [action, hidden, label] of [
      ['hide', true, '숨기기'], ['unhide', false, '숨김 해제'],
    ] as const) {
      defineRoute(app, {
        method: 'POST',
        url: `${base}/:id/${action}`,
        access: permission('screen.mdb_editor.document'),
        audit: { screen: EDIT, action: `${spec.label} 목록 ${label}` },
        schema: { params: IdParam, response: { 200: NoteResult, 403: ErrorResponse, 404: ErrorResponse } },
        handler: async (req) => {
          const { id } = IdParam.parse(req.params)
          const name = await tx(async (c) => {
            const item = await getOr404(c, id)
            await c.query(`UPDATE ${spec.table} SET is_hidden = $2 WHERE id = $1`, [id, hidden])
            return item.name
          })
          req.setAuditTarget(name, { id })
          return { ok: true as const }
        },
      })
    }

    // 완전히 지운다. 이미 이 값으로 지정된 자료는 그대로 둔다 (후보에서만 빠진다).
    defineRoute(app, {
      method: 'DELETE',
      url: `${base}/:id`,
      access: permission('screen.mdb_editor.document'),
      audit: { screen: EDIT, action: `${spec.label} 목록 삭제` },
      schema: { params: IdParam, response: { 200: NoteResult, 403: ErrorResponse, 404: ErrorResponse } },
      handler: async (req) => {
        const { id } = IdParam.parse(req.params)
        const name = await tx(async (c) => {
          const item = await getOr404(c, id)
          await c.query(`DELETE FROM ${spec.table} WHERE id = $1`, [id])
          return item.name
        })
        req.setAuditTarget(name, { id })
        return { ok: true as const }
      },
    })
  }
}
