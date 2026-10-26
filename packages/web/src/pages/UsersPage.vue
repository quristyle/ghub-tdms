<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  EmploymentStatus, GroupListResponse, GroupMembersResponse, GroupPermissionsResponse,
  PartnerCompanyListResponse, PermissionNode, UserListResponse, UserRow,
} from '@tdms/contracts'
import DataTable, { type Column } from '@/ui/DataTable.vue'
import Modal from '@/ui/Modal.vue'
import Tabs from '@/ui/Tabs.vue'
import PermissionTree from '@/ui/PermissionTree.vue'
import { api, ApiError } from '@/lib/api'

/** 사용자 관리 + 권한 관리 — 기존 users.html · groups.html 을 한 화면 두 탭으로 합쳤다. */

const qc = useQueryClient()
const tab = ref<'users' | 'groups'>('users')
const TABS = [{ key: 'users', label: '사용자' }, { key: 'groups', label: '권한 관리' }]

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const say = (kind: 'ok' | 'err', text: string) => (message.value = { kind, text })
const fail = (e: unknown) => say('err', e instanceof ApiError ? e.message : '처리하지 못했습니다.')

// ── 사용자 ────────────────────────────────────────────────────────────
const keyword = ref('')
const { data: users } = useQuery({
  queryKey: ['users'],
  queryFn: () => api.get<UserListResponse>('/users'),
  staleTime: 30_000,
})
const { data: groups } = useQuery({
  queryKey: ['groups'],
  queryFn: () => api.get<GroupListResponse>('/groups'),
  staleTime: 30_000,
})

const { data: partners } = useQuery({
  queryKey: ['partner-companies'],
  queryFn: () => api.get<PartnerCompanyListResponse>('/partner-companies'),
  staleTime: 60_000,
})

interface StatusOption { key: EmploymentStatus; label: string; cls: string }
const STATUS: StatusOption[] = [
  { key: 'ACTIVE',  label: '재직', cls: '' },
  { key: 'RETIRED', label: '퇴직', cls: 'warn-tag' },
  { key: 'DELETED', label: '삭제', cls: 'tag-danger' },
]
const statusLabel = (k: EmploymentStatus) => STATUS.find((x) => x.key === k)?.label ?? k

// 처음 열었을 때는 재직만 보인다 — 퇴직·삭제까지 섞이면 목록이 쓸모없어진다
// (기존 시스템 2026-08-12 CM 요청과 같은 기본값).
const shown = ref(new Set<EmploymentStatus>(['ACTIVE']))
function toggleStatus(k: EmploymentStatus) {
  const next = new Set(shown.value)
  next.has(k) ? next.delete(k) : next.add(k)
  shown.value = next
}
const dept = ref('')
const departments = computed(() =>
  [...new Set((users.value?.items ?? []).map((u) => u.department).filter(Boolean))].sort() as string[],
)

const rows = computed(() =>
  (users.value?.items ?? []).filter((u) => {
    if (shown.value.size && !shown.value.has(u.employmentStatus)) return false
    if (dept.value && u.department !== dept.value) return false
    const k = keyword.value.trim().toLowerCase()
    if (!k) return true
    return [u.loginId, u.name, u.employeeNumber, u.email, u.phone, u.extensionNumber,
            u.department, u.position, u.partnerCompanyName]
      .some((v) => v?.toLowerCase().includes(k))
  }),
)

const userDialog = ref<'create' | 'edit' | null>(null)
type Form = {
  id: number; loginId: string; name: string
  role: 'ADMIN' | 'VIEWER'; groupId: string | number
  employmentStatus: EmploymentStatus
  employeeNumber: string; email: string; phone: string; extensionNumber: string
  department: string; position: string; companyCode: string
  partnerCompanyId: string | number; hireDate: string
}
const EMPTY: Form = {
  id: 0, loginId: '', name: '', role: 'VIEWER', groupId: '', employmentStatus: 'ACTIVE',
  employeeNumber: '', email: '', phone: '', extensionNumber: '',
  department: '', position: '', companyCode: 'SKGAS', partnerCompanyId: '', hireDate: '',
}
const form = ref<Form>({ ...EMPTY })

function openCreate() {
  form.value = { ...EMPTY }
  userDialog.value = 'create'
}
function openEdit(u: UserRow) {
  form.value = {
    id: u.id, loginId: u.loginId, name: u.name, role: u.role, groupId: u.groupId ?? '',
    employmentStatus: u.employmentStatus,
    employeeNumber: u.employeeNumber ?? '', email: u.email ?? '', phone: u.phone ?? '',
    extensionNumber: u.extensionNumber ?? '', department: u.department ?? '',
    position: u.position ?? '', companyCode: u.companyCode,
    partnerCompanyId: u.partnerCompanyId ?? '', hireDate: u.hireDate ?? '',
  }
  userDialog.value = 'edit'
}

// ── 표 칸 ──────────────────────────────────────────────────────────────
// render 는 **글자값**이다 — 거르기·엑셀이 이것을 쓴다. 슬롯은 그리는 법만 바꾼다.
const COLUMNS: Column<UserRow>[] = [
  { key: 'loginId', label: '아이디', width: '130px' },
  { key: 'name', label: '이름', width: '96px' },
  { key: 'employeeNumber', label: '사번', width: '88px', align: 'center', render: (u) => u.employeeNumber ?? '' },
  { key: 'department', label: '부서', width: '120px', render: (u) => u.department ?? '' },
  { key: 'position', label: '직위', width: '92px', align: 'center', render: (u) => u.position ?? '' },
  { key: 'company', label: '소속사', width: '130px',
    render: (u) => u.partnerCompanyName ?? u.companyCode },
  { key: 'extensionNumber', label: '내선', width: '126px', align: 'center', render: (u) => u.extensionNumber ?? '' },
  { key: 'phone', label: '휴대전화', width: '126px', align: 'center', render: (u) => u.phone ?? '' },
  { key: 'email', label: '이메일', width: '180px', render: (u) => u.email ?? '' },
  { key: 'role', label: '권한', width: '74px', align: 'center',
    render: (u) => (u.role === 'ADMIN' ? '관리자' : '일반') },
  { key: 'groupName', label: '그룹', width: '110px', align: 'center', render: (u) => u.groupName ?? '' },
  { key: 'employmentStatus', label: '상태', width: '110px',
    // 엑셀에도 "초기비번"이 함께 나가야 화면과 같은 뜻이 된다
    render: (u) => [statusLabel(u.employmentStatus), u.mustChangePassword ? '초기비번' : '']
      .filter(Boolean).join(' ') },
  { key: 'hireDate', label: '입사일', width: '100px', align: 'center', render: (u) => u.hireDate ?? '' },
  { key: 'lastLoginAt', label: '접속일', width: '100px', align: 'center',
    render: (u) => u.lastLoginAt?.slice(0, 10) ?? '' },
  { key: 'act', label: '조치', width: '152px', align: 'center', filterable: false, render: () => '' },
]

/** 빈 칸은 null 로 보낸다 — ''를 저장하면 "값이 있는데 비어 있는" 칸이 생긴다. */
const n = (v: string) => (v.trim() === '' ? null : v.trim())

async function submitUser() {
  const mode = userDialog.value
  const f = form.value
  userDialog.value = null
  try {
    const profile = {
      employeeNumber: n(f.employeeNumber), email: n(f.email), phone: n(f.phone),
      extensionNumber: n(f.extensionNumber), department: n(f.department),
      position: n(f.position), companyCode: f.companyCode.trim() || 'SKGAS',
      partnerCompanyId: f.partnerCompanyId === '' ? null : Number(f.partnerCompanyId),
      hireDate: n(f.hireDate),
    }
    const groupId = f.groupId === '' ? null : Number(f.groupId)
    if (mode === 'create') {
      await api.post('/users', { loginId: f.loginId, name: f.name, role: f.role, groupId, ...profile })
      say('ok', `"${f.loginId}" 계정을 만들었습니다. 초기 비밀번호는 ghub${f.loginId} 입니다.`)
    } else {
      await api.patch(`/users/${f.id}`, {
        name: f.name, role: f.role, groupId, employmentStatus: f.employmentStatus, ...profile,
      })
      say('ok', '계정을 수정했습니다.')
    }
    void qc.invalidateQueries({ queryKey: ['users'] })
    void qc.invalidateQueries({ queryKey: ['partner-companies'] })
  } catch (e) { fail(e) }
}

const resetTarget = ref<UserRow | null>(null)
async function confirmReset() {
  const u = resetTarget.value
  resetTarget.value = null
  if (!u) return
  try {
    const r = await api.post<{ rule: string }>(`/users/${u.id}/reset-password`)
    say('ok', `"${u.loginId}" 의 비밀번호를 초기화했습니다. ${r.rule}`)
    void qc.invalidateQueries({ queryKey: ['users'] })
  } catch (e) { fail(e) }
}

// ── 권한 관리 ─────────────────────────────────────────────────────────
const selectedGroup = ref<number | null>(null)
const granted = ref(new Set<string>())
const dirty = ref(false)

const { data: tree } = useQuery({
  queryKey: ['permission-tree'],
  queryFn: () => api.get<{ tree: PermissionNode[] }>('/groups/permission-tree'),
  staleTime: Infinity,
})

const { data: perms } = useQuery({
  queryKey: computed(() => ['group-permissions', selectedGroup.value]),
  queryFn: () => api.get<GroupPermissionsResponse>(`/groups/${selectedGroup.value}/permissions`),
  enabled: computed(() => selectedGroup.value !== null),
})

const { data: members } = useQuery({
  queryKey: computed(() => ['group-members', selectedGroup.value]),
  queryFn: () => api.get<GroupMembersResponse>(`/groups/${selectedGroup.value}/members`),
  enabled: computed(() => selectedGroup.value !== null),
})

watch(perms, (p) => {
  if (p) { granted.value = new Set(p.granted); dirty.value = false }
})

/** 상위 노드를 켜면 하위 리프가 전부 켜진다. 저장은 언제나 leaf 키로 한다. */
function toggle(keys: string[], on: boolean) {
  const next = new Set(granted.value)
  for (const k of keys) on ? next.add(k) : next.delete(k)
  granted.value = next
  dirty.value = true
}

async function savePermissions() {
  if (selectedGroup.value === null) return
  try {
    const r = await api.put<GroupPermissionsResponse>(
      `/groups/${selectedGroup.value}/permissions`, { granted: [...granted.value] },
    )
    dirty.value = false
    say('ok', `권한 ${r.granted.length}개를 저장했습니다. 바로 적용됩니다.`)
    void qc.invalidateQueries({ queryKey: ['groups'] })
    void qc.invalidateQueries({ queryKey: ['group-permissions'] })
  } catch (e) { fail(e) }
}
</script>

<template>
  <main class="app-main users">
    <div class="panel head">
      <h1>사용자 및 권한 관리</h1>
    </div>

    <div v-if="message" class="panel msg" :class="message.kind">
      {{ message.text }}<span style="flex:1" />
      <button class="btn btn-sm" @click="message = null">닫기</button>
    </div>

    <div class="panel body">
      <Tabs v-model="tab" :tabs="TABS" />

      <!-- 사용자 -->
      <section v-if="tab === 'users'" class="pad users-tab">
        <div class="bar">
          <input v-model="keyword" type="text" placeholder="아이디·이름·사번·부서·연락처" style="width:240px" />
          <select v-model="dept" style="width:140px">
            <option value="">부서 전체</option>
            <option v-for="d in departments" :key="d" :value="d">{{ d }}</option>
          </select>
          <span class="seg">
            <button
              v-for="st in STATUS" :key="st.key" type="button"
              class="btn btn-sm" :class="{ on: shown.has(st.key) }"
              @click="toggleStatus(st.key)"
            >{{ st.label }}</button>
          </span>
          <!-- 건수는 그리드 아래쪽이 적는다. 두 군데 적으면 서로 어긋난다. -->
          <span style="flex:1" />
          <button class="btn btn-sm btn-primary" @click="openCreate">사용자 추가</button>
        </div>
        <div class="tablewrap">
          <DataTable
            :columns="COLUMNS" :rows="rows" :total="rows.length"
            :row-class="(u) => (u.isActive ? '' : 'off')"
            storage-key="users" excel-name="사용자 목록"
            empty-text="조건에 맞는 사용자가 없습니다."
            @row-click="openEdit"
          >
            <template #cell:company="{ row }">
              <span v-if="row.partnerCompanyName" class="tag tag-info">{{ row.partnerCompanyName }}</span>
              <span v-else class="muted">{{ row.companyCode }}</span>
            </template>

            <template #cell:role="{ row }">
              <span :class="{ tag: row.role === 'ADMIN' }">{{ row.role === 'ADMIN' ? '관리자' : '일반' }}</span>
            </template>

            <template #cell:employmentStatus="{ row }">
              <span class="tag" :class="STATUS.find(x => x.key === row.employmentStatus)?.cls">
                {{ statusLabel(row.employmentStatus) }}
              </span>
              <span v-if="row.mustChangePassword" class="tag warn-tag"
                    title="첫 로그인 때 변경 화면이 열립니다">초기비번</span>
            </template>

            <template #cell:lastLoginAt="{ row }">
              <span :title="row.previousLoginAt ? `직전 ${row.previousLoginAt.slice(0, 10)}` : ''">
                {{ row.lastLoginAt?.slice(0, 10) ?? '-' }}
              </span>
            </template>

            <template #cell:act="{ row }">
              <button class="btn btn-sm" @click.stop="openEdit(row)">수정</button>
              <button class="btn btn-sm" @click.stop="resetTarget = row">비번 초기화</button>
            </template>
          </DataTable>
        </div>
      </section>

      <!-- 권한 관리 -->
      <section v-else class="perm">
        <div class="glist">
          <div
            v-for="g in groups?.items ?? []" :key="g.id"
            class="grow" :class="{ sel: selectedGroup === g.id }"
            @click="selectedGroup = g.id"
          >
            <strong>{{ g.name }}</strong>
            <div class="muted sub">구성원 {{ g.memberCount }} · 권한 {{ g.permissionCount }}</div>
          </div>
          <div v-if="!groups?.items.length" class="muted pad">그룹이 없습니다.</div>
        </div>

        <div class="pbody">
          <template v-if="selectedGroup !== null">
            <div class="bar">
              <strong>{{ groups?.items.find(g => g.id === selectedGroup)?.name }}</strong>
              <span class="muted">구성원 {{ members?.items.length ?? 0 }}명 · 권한 {{ granted.size }}개</span>
              <span v-if="dirty" class="tag warn-tag">저장하지 않은 변경사항이 있습니다</span>
              <span style="flex:1" />
              <button class="btn btn-sm btn-primary" :disabled="!dirty" @click="savePermissions">저장</button>
            </div>
            <p class="muted note">
              상위 항목을 켜면 하위가 전부 켜집니다. 저장은 언제나 가장 아래 항목(리프) 기준입니다.
              <strong>트리에 없는 기능은 로그인한 사람 누구나 씁니다.</strong>
              관리자(ADMIN)는 권한과 무관하게 전부 통과합니다.
            </p>
            <PermissionTree v-if="tree" :tree="tree.tree" :granted="granted" @toggle="toggle" />
            <div v-if="members?.items.length" class="members">
              <h3>구성원</h3>
              <span v-for="m in members.items" :key="m.id" class="chip">{{ m.name }} ({{ m.loginId }})</span>
            </div>
          </template>
          <div v-else class="muted pad">왼쪽에서 그룹을 고르세요.</div>
        </div>
      </section>
    </div>

    <!-- 사용자 추가·수정 -->
    <Modal v-if="userDialog" :title="userDialog === 'create' ? '사용자 추가' : '사용자 수정'"
           @close="userDialog = null">
      <table class="form">
        <tbody>
          <tr>
            <th>아이디</th>
            <td>
              <input v-model="form.loginId" type="text" :disabled="userDialog === 'edit'" style="width:100%" />
              <div v-if="userDialog === 'create'" class="muted sub">
                초기 비밀번호는 <strong>ghub{{ form.loginId || '아이디' }}</strong> 입니다.
                첫 로그인 때 변경 화면이 열립니다(미루기 가능).
              </div>
            </td>
          </tr>
          <tr><th>이름</th><td><input v-model="form.name" type="text" style="width:100%" /></td></tr>
          <tr>
            <th>권한</th>
            <td>
              <label class="r"><input v-model="form.role" type="radio" value="VIEWER" /> 일반</label>
              <label class="r"><input v-model="form.role" type="radio" value="ADMIN" /> 관리자</label>
              <div class="muted sub">관리자는 권한 트리와 무관하게 전부 통과합니다.</div>
            </td>
          </tr>
          <tr>
            <th>그룹</th>
            <td>
              <select v-model="form.groupId" style="width:100%">
                <option value="">그룹 없음</option>
                <option v-for="g in groups?.items ?? []" :key="g.id" :value="g.id">{{ g.name }}</option>
              </select>
            </td>
          </tr>
          <tr v-if="userDialog === 'edit'">
            <th>재직 상태</th>
            <td>
              <label v-for="st in STATUS" :key="st.key" class="r">
                <input v-model="form.employmentStatus" type="radio" :value="st.key" /> {{ st.label }}
              </label>
              <div class="muted sub">
                퇴직·삭제로 바꾸면 로그인이 막히고 열려 있던 세션도 끊깁니다.
                계정과 기록은 지우지 않습니다.
              </div>
            </td>
          </tr>

          <tr><th colspan="2" class="sect">신원 · 조직</th></tr>
          <tr>
            <th>사번</th>
            <td class="two">
              <input v-model="form.employeeNumber" type="text" placeholder="0038" />
              <label>입사일 <input v-model="form.hireDate" type="date" /></label>
            </td>
          </tr>
          <tr>
            <th>부서 / 직위</th>
            <td class="two">
              <input v-model="form.department" type="text" placeholder="설비기술팀" />
              <input v-model="form.position" type="text" placeholder="과장" />
            </td>
          </tr>
          <tr>
            <th>소속</th>
            <td class="two">
              <input v-model="form.companyCode" type="text" placeholder="SKGAS" />
              <select v-model="form.partnerCompanyId">
                <option value="">협력업체 아님</option>
                <option v-for="c in partners?.items ?? []" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </td>
          </tr>

          <tr><th colspan="2" class="sect">연락처</th></tr>
          <tr>
            <th>전화</th>
            <td class="two">
              <input v-model="form.extensionNumber" type="text" placeholder="내선 052-916-2016" />
              <input v-model="form.phone" type="text" placeholder="휴대전화 010-0000-0000" />
            </td>
          </tr>
          <tr>
            <th>이메일</th>
            <td><input v-model="form.email" type="text" placeholder="name@skgas.kr" style="width:100%" /></td>
          </tr>
        </tbody>
      </table>
      <template #footer>
        <button class="btn" @click="userDialog = null">취소</button>
        <button class="btn btn-primary" :disabled="!form.loginId || !form.name" @click="submitUser">확인</button>
      </template>
    </Modal>

    <Modal v-if="resetTarget" title="비밀번호 초기화" @close="resetTarget = null">
      <p>
        <strong>{{ resetTarget.loginId }}</strong> 의 비밀번호를
        <strong>ghub{{ resetTarget.loginId }}</strong> 로 되돌립니다.
      </p>
      <p class="muted">그 사람의 모든 로그인이 끊기고, 다음 로그인 때 변경 화면이 열립니다.</p>
      <template #footer>
        <button class="btn" @click="resetTarget = null">취소</button>
        <button class="btn btn-primary" @click="confirmReset">초기화</button>
      </template>
    </Modal>
  </main>
</template>

<style scoped>
.users { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
/* `.body > section` 이 overflow:auto 라 그대로 두면 바깥이 한 번 더 스크롤되어
   그리드의 머리글 고정이 깨진다. 사용자 절만 끈다(권한 절은 그대로 스크롤). */
.body > section.users-tab {
  display: flex; flex-direction: column; gap: var(--sp-2);
  min-height: 0; flex: 1; overflow: hidden;
}

/* 가로·세로 스크롤은 DataTable 이 자기 안에서 맡는다. 여기서는 자리만 내준다. */
.tablewrap { flex: 1; min-height: 420px; display: flex; }
.tablewrap > * { flex: 1; min-width: 0; }

/* 재직/퇴직/삭제 — 붙은 세 칸으로 묶어 "거르개"임을 보이게 한다 */
.seg { display: inline-flex; }
.seg .btn { border-radius: 0; margin-left: -1px; }
.seg .btn:first-child { border-radius: var(--r) 0 0 var(--r); margin-left: 0; }
.seg .btn:last-child  { border-radius: 0 var(--r) var(--r) 0; }
.seg .btn.on { background: var(--primary-soft); border-color: var(--primary-line); color: var(--primary); font-weight: 600; }

/* 폼 구역 머리 */
.form .sect {
  text-align: left; padding-top: var(--sp-4);
  color: var(--fg-muted); font-size: var(--fs-sm); font-weight: 600;
}
.form td.two { display: flex; gap: var(--sp-2); }
.form td.two > * { flex: 1; min-width: 0; }
.form td.two label { display: flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--fg-muted); }
.head { padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.body > section { flex: 1; overflow: auto; min-height: 0; }
.pad { padding: 14px; }
.bar { display: flex; gap: var(--gap-sm); align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.grid tr.off { color: var(--text-muted); background: var(--bg); }
.tag {
  display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: var(--accent); color: var(--primary-fg);
}
.tag.warn-tag { background: var(--warn); margin-left: 4px; }
.perm { display: flex; min-height: 0; }
.glist { width: 220px; min-width: 220px; border-right: 1px solid var(--border); overflow: auto; }
.grow { padding: 9px 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
.grow:hover { background: var(--bg); }
.grow.sel { background: var(--accent-soft); }
.pbody { flex: 1; overflow: auto; padding: 14px; }
.note { font-size: var(--fs-sm); margin: 0 0 10px; }
.sub { font-size: 11px; margin-top: 2px; }
.members { margin-top: 18px; }
.members h3 { font-size: var(--fs-base); margin: 0 0 6px; }
.chip {
  display: inline-block; font-size: 11px; padding: 2px 8px; margin: 0 4px 4px 0;
  border: 1px solid var(--border-strong); border-radius: 10px;
}
.form th, .form td { padding: 6px 8px; text-align: left; vertical-align: top; }
.form th { width: 70px; font-weight: 600; white-space: nowrap; }
.r { margin-right: 12px; }
</style>
