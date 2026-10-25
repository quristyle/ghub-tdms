/** 업무 실패는 전부 코드가 있는 예외로 던진다. 화면이 code 로 분기한다. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const Errors = {
  unauthorized: () => new AppError('UNAUTHORIZED', 401, '로그인이 필요합니다.'),
  forbidden: (permission?: string) =>
    new AppError('FORBIDDEN', 403, '권한이 없습니다.', permission ? { requiredPermission: permission } : undefined),
  notFound: (what = '대상') => new AppError('NOT_FOUND', 404, `${what}을(를) 찾을 수 없습니다.`),
  conflict: (code: string, message: string, detail?: Record<string, unknown>) =>
    new AppError(code, 409, message, detail),
  invalid: (code: string, message: string, detail?: Record<string, unknown>) =>
    new AppError(code, 422, message, detail),
  locked: (minutes: number) =>
    new AppError('ACCOUNT_LOCKED', 429, `로그인 실패가 반복되어 ${minutes}분간 잠겼습니다.`),
} as const
