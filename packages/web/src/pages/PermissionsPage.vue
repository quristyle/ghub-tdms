<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  GroupListResponse, GroupPermissionsResponse, MenuListResponse, PermissionNode,
  UserListResponse, UserPermissionsResponse,
} from '@tdms/contracts'
import PermissionTree from '@/ui/PermissionTree.vue'
import Tabs from '@/ui/Tabs.vue'
import { api, ApiError } from '@/lib/api'

/**
 * 접속권한 관리 — 권한을 **그룹과 사람 양쪽**에 매긴다.
 *
 * 최종 권한 = 그룹 권한 ∪ 개인 권한 (빼기는 없다 — 0016 머리글 참조).
 * 사람을 고르면 그룹에서 오는 권한은 "그룹에서 상속" 으로 켜진 채 잠긴다. 개인에
 * 중복으로 적으면 나중에 그룹에서 내려도 개인 쪽이 남아 안 내려가므로 서버도 막는다.
 *
 * 그룹 권한은 기존 [사용자 관리 > 권한 관리] 탭과 **같은 API**(/groups/:id/permissions)를
 * 쓴다. 두 화면 어느 쪽에서 고쳐도 결과가 같다 — 화면이 둘이어도 정본은 하나다.
 *
 * 아래쪽 "열리는 메뉴" 는 menus 테이블과 맞대어 계산한다. 권한 키만 보고는
 * 그 사람이 무엇을 쓸 수 있는지 알기 어렵기 때문이다.
 */

const qc = useQueryClient()

const kind = ref<'groups' | 'users'>('groups')
const KINDS = [{ key: 'groups', label: '그룹' }, { key: 'users', label: '사용자' }]

const pickedGroup = ref<number | null>(null)
const pickedUser = ref<number | null>(null)
const userFilter = ref('')

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (k: 'ok' | 'err', text: string) => (message.value = { kind: k, text })
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '저장하지 못했습니다.')
const saving = ref(false)

// ── 바탕 자료 ──────────────────────────────────────────────────────────
const { data: tree } = useQuery({
  queryKey: ['permission-tree'],
  queryFn: () => api.get<{ tree: PermissionNode[] }>('/groups/permission-tree'),
  staleTime: Infinity,
})
const { data: groups } = useQuery({
  queryKey: ['groups'],
  queryFn: () => api.get<GroupListResponse>('/groups'),
  staleTime: 30_000,
})
const { data: users } = useQuery({
  queryKey: ['users'],
  queryFn: () => api.get<UserListResponse>('/users'),
  staleTime: 30_000,
})
const { data: menus } = useQuery({
  queryKey: ['menus'],
  queryFn: () => api.get<MenuListResponse>('/menus'),
  staleTime: 30_000,
})
const { data: counts } = useQuery({
  queryKey: ['user-permission-counts'],
  queryFn: () => api.get<{ items: { userId: number; count: number }[] }>('/users/permission-counts'),
  staleTime: 30_000,
})

const ownCount = computed(() => new Map((counts.value?.items ?? []).map((c) => [c.userId, c.count])))

// 재직자만 — 퇴직·삭제 계정에 권한을 매길 일이 없다
const userList = computed(() => {
  const q = userFilter.value.trim().toLowerCase()
  return (users.value?.items ?? [])
    .filter((u) => u.employmentStatus === 'ACTIVE')
    .filter((u) => !q || u.name.toLowerCase().includes(q) || u.loginId.toLowerCase().includes(q))
})

// ── 고른 대상의 권한 ───────────────────────────────────────────────────
const { data: groupPerms } = useQuery({
  queryKey: computed(() => ['group-perms', pickedGroup.value]),
  queryFn: () => api.get<GroupPermissionsResponse>(`/groups/${pickedGroup.value}/permissions`),
  enabled: computed(() => kind.value === 'groups' && pickedGroup.value !== null),
})
const { data: userPerms } = useQuery({
  queryKey: computed(() => ['user-perms', pickedUser.value]),
  queryFn: () => api.get<UserPermissionsResponse>(`/users/${pickedUser.value}/permissions`),
  enabled: computed(() => kind.value === 'users' && pickedUser.value !== null),
})

/** 편집용 사본 — 저장을 누를 때까지 서버에 보내지 않는다 */
const draft = ref<Set<string>>(new Set())
watch([groupPerms, userPerms, kind], () => {
  const src = kind.value === 'groups' ? groupPerms.value?.granted : userPerms.value?.granted
  draft.value = new Set(src ?? [])
  message.value = null
}, { immediate: true })

/** 사람을 고른 경우에만 상속분이 있다 */
const inherited = computed(() =>
  kind.value === 'users' ? new Set(userPerms.value?.fromGroup ?? []) : new Set<string>(),
)
const isAdmin = computed(() => kind.value === 'users' && userPerms.value?.isAdmin === true)

const hasTarget = computed(() =>
  kind.value === 'groups' ? pickedGroup.value !== null : pickedUser.value !== null)

const saved = computed(() =>
  new Set(kind.value === 'groups' ? groupPerms.value?.granted ?? [] : userPerms.value?.granted ?? []))

const dirty = computed(() => {
  if (!hasTarget.value) return false
  if (draft.value.size !== saved.value.size) return true
  for (const k of draft.value) if (!saved.value.has(k)) return true
  return false
})

function onToggle(keys: string[], on: boolean) {
  const next = new Set(draft.value)
  for (const k of keys) {
    if (on) next.add(k)
    else next.delete(k)
  }
  draft.value = next
}

/** 이 권한으로 실제로 열리는 메뉴 — 꺼 둔 메뉴는 권한이 있어도 안 열린다 */
const openMenus = computed(() => {
  const eff = new Set([...draft.value, ...inherited.value])
  return (menus.value?.items ?? []).map((m) => ({
    label: m.label,
    path: m.path,
    enabled: m.isEnabled,
    allowed: isAdmin.value || eff.has(m.permissionKey),
  }))
})

async function save() {
  if (!dirty.value || !hasTarget.value) return
  saving.value = true
  try {
    const granted = [...draft.value]
    if (kind.value === 'groups') {
      const out = await api.put<GroupPermissionsResponse>(
        `/groups/${pickedGroup.value}/permissions`, { granted })
      qc.setQueryData(['group-perms', pickedGroup.value], out)
      await qc.invalidateQueries({ queryKey: ['groups'] })
      say('ok', '그룹 권한을 저장했습니다. 소속된 사람 모두에게 바로 적용됩니다.')
    } else {
      const out = await api.put<UserPermissionsResponse>(
        `/users/${pickedUser.value}/permissions`, { granted })
      qc.setQueryData(['user-perms', pickedUser.value], out)
      await qc.invalidateQueries({ queryKey: ['user-permission-counts'] })
      say('ok', '개인 권한을 저장했습니다. 그룹 권한에 더해져 바로 적용됩니다.')
    }
  } catch (e) {
    fail(e)
  } finally {
    saving.value = false
  }
}

function reset() {
  draft.value = new Set(saved.value)
  message.value = null
}
</script>

<template>
  <main class="app-main perms">
    <div class="panel head">
      <h1>접속권한 관리</h1>
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div class="cols">
      <!-- 대상 고르기 -->
      <div class="panel side">
        <div class="panel-head">누구에게</div>
        <div class="pad"><Tabs v-model="kind" :tabs="KINDS" /></div>

        <template v-if="kind === 'groups'">
          <div
            v-for="g in groups?.items ?? []" :key="g.id"
            class="pick" :class="{ on: pickedGroup === g.id }"
            @click="pickedGroup = g.id"
          >
            <strong>{{ g.name }}</strong>
            <div class="muted sub">구성원 {{ g.memberCount }} · 권한 {{ g.permissionCount }}</div>
          </div>
          <div v-if="!groups?.items.length" class="pad muted">그룹이 없습니다.</div>
        </template>

        <template v-else>
          <div class="pad">
            <input v-model="userFilter" class="in" placeholder="이름·아이디로 거르기" />
          </div>
          <div class="scroll">
            <div
              v-for="u in userList" :key="u.id"
              class="pick" :class="{ on: pickedUser === u.id }"
              @click="pickedUser = u.id"
            >
              <strong>{{ u.name }}</strong>
              <span class="muted"> ({{ u.loginId }})</span>
              <span v-if="u.role === 'ADMIN'" class="tag">관리자</span>
              <span v-else-if="ownCount.get(u.id)" class="tag">개인 {{ ownCount.get(u.id) }}</span>
              <div class="muted sub">{{ u.groupName ?? '그룹 없음' }}</div>
            </div>
            <div v-if="!userList.length" class="pad muted">해당하는 사람이 없습니다.</div>
          </div>
        </template>
      </div>

      <!-- 권한 트리 -->
      <div class="panel main">
        <div class="panel-head">
          어떤 권한
          <span style="flex:1" />
          <button class="btn btn-sm" :disabled="!dirty || saving" @click="reset">되돌리기</button>
          <button
            class="btn btn-sm btn-primary" :disabled="!dirty || saving || isAdmin"
            @click="save"
          >{{ saving ? '저장 중…' : '저장' }}</button>
        </div>

        <div v-if="!hasTarget" class="pad muted">왼쪽에서 그룹이나 사람을 고르세요.</div>

        <template v-else>
          <div v-if="isAdmin" class="pad msg warn">
            관리자(ADMIN)는 권한 트리와 무관하게 전부 통과합니다. 이 사람에게는 매길 것이 없습니다.
          </div>
          <div v-else-if="kind === 'users'" class="pad muted sub">
            <strong>{{ userPerms?.groupName ?? '그룹 없음' }}</strong> 에서 오는 권한은
            <em>그룹에서 상속</em> 으로 잠겨 있습니다. 여기서 켜는 것은 이 사람에게만 더해집니다.
          </div>

          <div class="pad tree">
            <PermissionTree
              v-if="tree"
              :tree="tree.tree" :granted="draft" :inherited="inherited" :readonly="isAdmin"
              @toggle="onToggle"
            />
          </div>
        </template>
      </div>

      <!-- 열리는 메뉴 -->
      <div class="panel side">
        <div class="panel-head">열리는 메뉴</div>
        <div v-if="!hasTarget" class="pad muted">대상을 고르면 보입니다.</div>
        <template v-else>
          <div class="pad muted sub">
            지금 켜 둔 권한으로 왼쪽 메뉴에 뜰 것들입니다. 저장 전에도 바로 비칩니다.
          </div>
          <div
            v-for="m in openMenus" :key="m.path"
            class="menu-row" :class="{ no: !m.allowed || !m.enabled }"
          >
            <span class="dot">{{ m.allowed && m.enabled ? '●' : '○' }}</span>
            <span>{{ m.label }}</span>
            <span style="flex:1" />
            <span v-if="!m.enabled" class="tag">메뉴 꺼짐</span>
          </div>
          <div class="pad muted sub">
            메뉴가 꺼져 있으면 권한이 있어도 열리지 않습니다 —
            <RouterLink to="/menus">메뉴 관리</RouterLink> 에서 켭니다.
          </div>
        </template>
      </div>
    </div>
  </main>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: 260px minmax(0, 1fr) 260px; gap: var(--sp-3); align-items: start; }
@media (max-width: 1100px) { .cols { grid-template-columns: 1fr; } }
.side { max-height: 72vh; display: flex; flex-direction: column; }
.scroll { overflow-y: auto; }
.main { min-height: 420px; }
.tree { overflow: auto; max-height: 62vh; }
.in { width: 100%; }
.pick { padding: 7px 12px; cursor: pointer; border-left: 3px solid transparent; }
.pick:hover { background: var(--surface-2); }
.pick.on { background: var(--primary-soft); border-left-color: var(--primary); }
.sub { font-size: var(--fs-xs); }
.tag {
  font-size: var(--fs-xs); color: var(--fg-muted); margin-left: 6px;
  border: 1px solid var(--border); border-radius: 999px; padding: 0 6px;
}
.menu-row { display: flex; align-items: center; gap: 7px; padding: 5px 12px; }
.menu-row .dot { color: var(--ok); }
.menu-row.no { color: var(--fg-muted); }
.menu-row.no .dot { color: var(--border-strong); }
.menu-row a { text-decoration: underline; }
</style>
