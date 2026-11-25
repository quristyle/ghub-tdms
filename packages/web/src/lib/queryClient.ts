import { QueryClient } from '@tanstack/vue-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 서버 상태 캐시 — 뒤로가기 시 네트워크 0회
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (count: number, err: unknown) => {
        // 권한·인증 오류는 재시도하지 않는다
        const status = (err as { status?: number }).status
        if (status === 401 || status === 403 || status === 404) return false
        return count < 2
      },
    },
  },
})
