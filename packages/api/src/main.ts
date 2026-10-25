import { config } from './core/config.js'
import { closePool } from './core/db.js'
import { stopCacheListener } from './core/cache.js'
import { buildApp } from './app.js'

const app = await buildApp()

// API_LISTEN 이 '/' 로 시작하면 유닉스 소켓 (운영), 아니면 host:port (개발)
const target = config.listen.startsWith('/')
  ? { path: config.listen }
  : {
      host: config.listen.split(':')[0] ?? '0.0.0.0',
      port: Number(config.listen.split(':')[1] ?? 8080),
    }

await app.listen(target)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    void (async () => {
      app.log.info({ sig }, '종료 신호 — 연결 드레인')
      await app.close()
      await stopCacheListener()
      await closePool()
      process.exit(0)
    })()
  })
}
