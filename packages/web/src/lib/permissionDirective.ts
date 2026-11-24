import type { App, DirectiveBinding } from 'vue'
import { useSession } from './session'
import { router } from '../router'

/**
 * 버튼 및 요소에 대한 C, R, U, D 권한 제어.
 *
 * 1) Vue 디렉티브:
 *    <button v-permission="'c'">등록</button>
 *    <button v-permission="'u'">수정</button>
 *    <button v-permission="'d'">삭제</button>
 *    <button v-permission="'r'">조회</button>
 *    <button v-permission.disable="'d'">비활성화</button>
 *    <button v-permission="{ action: 'c', menu: 'tdb_editor' }">등록</button>
 *
 * 2) HTML 속성(HTML Attribute):
 *    <button permission="c">등록</button>
 *    <button permission="u">수정</button>
 *    <button permission="d">삭제</button>
 *    <button permission="r">조회</button>
 *
 * 여기서 지정한 권한은 사용자 그룹별 메뉴권한 관리 화면에서 설정한 내용에 따라 적용됩니다.
 */

export function checkActionPermission(action: string, menuCode?: string): boolean {
  try {
    const session = useSession()
    return session.canAction(action, menuCode)
  } catch {
    return true
  }
}

function parseBinding(value: unknown): { action: string; menuCode?: string } {
  if (typeof value === 'string') {
    return { action: value }
  }
  if (value && typeof value === 'object' && 'action' in value) {
    const obj = value as { action: string; menu?: string; menuCode?: string }
    return { action: String(obj.action), menuCode: obj.menu || obj.menuCode }
  }
  return { action: '' }
}

function applyElementPermission(el: HTMLElement, action: string, menuCode?: string, disableOnly = false) {
  if (!action) return
  const allowed = checkActionPermission(action, menuCode)

  if (!allowed) {
    if (disableOnly || el.hasAttribute('disabled-by-perm')) {
      ;(el as HTMLButtonElement).disabled = true
      el.setAttribute('disabled-by-perm', 'true')
    } else {
      if (el.style.display !== 'none') {
        el.dataset.origDisplay = el.style.display || ''
        el.style.display = 'none'
      }
    }
  } else {
    if (el.hasAttribute('disabled-by-perm')) {
      ;(el as HTMLButtonElement).disabled = false
      el.removeAttribute('disabled-by-perm')
    }
    if (el.style.display === 'none' && el.dataset.origDisplay !== undefined) {
      el.style.display = el.dataset.origDisplay
      delete el.dataset.origDisplay
    }
  }
}

export function setupPermissionDirectives(app: App) {
  // v-permission 디렉티브 등록
  app.directive('permission', {
    mounted(el: HTMLElement, binding: DirectiveBinding) {
      const { action, menuCode } = parseBinding(binding.value)
      const disableOnly = Boolean(binding.modifiers.disable)
      applyElementPermission(el, action, menuCode, disableOnly)
    },
    updated(el: HTMLElement, binding: DirectiveBinding) {
      const { action, menuCode } = parseBinding(binding.value)
      const disableOnly = Boolean(binding.modifiers.disable)
      applyElementPermission(el, action, menuCode, disableOnly)
    },
  })

  // 단축형 v-perm 디렉티브 등록
  app.directive('perm', {
    mounted(el: HTMLElement, binding: DirectiveBinding) {
      const { action, menuCode } = parseBinding(binding.value)
      const disableOnly = Boolean(binding.modifiers.disable)
      applyElementPermission(el, action, menuCode, disableOnly)
    },
    updated(el: HTMLElement, binding: DirectiveBinding) {
      const { action, menuCode } = parseBinding(binding.value)
      const disableOnly = Boolean(binding.modifiers.disable)
      applyElementPermission(el, action, menuCode, disableOnly)
    },
  })

  // DOM 상의 permission="c,r,u,d" 속성 자동 감지 및 처리
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    function scanPermissionAttributes() {
      const elements = document.querySelectorAll<HTMLElement>('[permission]')
      elements.forEach((el) => {
        const perm = el.getAttribute('permission')
        if (perm) {
          applyElementPermission(el, perm)
        }
      })
    }

    // 초기 및 라우트 변경 시 스캔
    router.afterEach(() => {
      setTimeout(scanPermissionAttributes, 50)
    })

    // DOM 동적 생성 감지
    const observer = new MutationObserver(() => {
      scanPermissionAttributes()
    })

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['permission'],
      })
    }
  }
}
