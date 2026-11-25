import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { queryClient } from './lib/queryClient'
import App from './App.vue'
import { router } from './router'
import { installPreloadErrorHandler } from './lib/chunkReload'
import { initTheme } from './lib/theme'
import { setupPermissionDirectives } from './lib/permissionDirective'
import './styles/base.css'

installPreloadErrorHandler()
initTheme()

const app = createApp(App)
setupPermissionDirectives(app)

app
  .use(createPinia())
  .use(router)
  .use(VueQueryPlugin, { queryClient })
  .mount('#app')
