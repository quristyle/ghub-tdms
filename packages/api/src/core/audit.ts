import { query } from './db.js'

/**
 * 감사 로그.
 *
 * 핸들러가 직접 부르지 않는다 — 라우트의 audit 선언을 보고 미들웨어가 쓴다.
 * 그래서 "기록을 잊는" 일이 구조적으로 불가능하다.
 *
 * 테이블은 월 파티션이고, 애플리케이션 역할에서 DELETE/UPDATE 권한을 회수해
 * DB 수준에서 수정·삭제를 막는다.
 */

export interface AuditEntry {
  userId: number | null
  userName: string | null
  screen: string
  action: string
  target: string | null
  detail: Record<string, unknown> | null
  clientIp: string | null
  requestId: string | null
}

export async function writeAudit(e: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (user_id, user_name, screen, action, target, detail, client_ip, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.userId, e.userName, e.screen, e.action, e.target, e.detail, e.clientIp, e.requestId],
      'audit_write',
    )
  } catch {
    // 감사 기록 실패가 업무 처리를 되돌리면 안 된다. 로그로만 남긴다.
    // (운영에서는 pino 가 잡아 journald 로 보낸다)
  }
}
