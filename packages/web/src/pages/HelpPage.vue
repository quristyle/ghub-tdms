<script setup lang="ts">
import { ref } from 'vue'
import { useSession } from '@/lib/session'

/** 도움말 — 화면별 안내와 이 시스템의 핵심 규칙. */

const session = useSession()
const open = ref<string | null>('rules')
const toggle = (k: string) => (open.value = open.value === k ? null : k)
</script>

<template>
  <main class="app-main help">
    <div class="panel head">
      <h1>도움말</h1>
      <span class="muted sub">{{ session.me?.name }} 님이 쓸 수 있는 화면 {{ session.menu.length }}개</span>
    </div>

    <div class="panel body">
      <!-- 핵심 규칙 -->
      <section>
        <h2 @click="toggle('rules')">
          <span class="caret" :class="{ open: open === 'rules' }">▶</span> 꼭 알아 둘 규칙 4가지
        </h2>
        <div v-if="open === 'rules'" class="pad">
          <dl>
            <dt>① 자료를 지우는 기능이 없습니다</dt>
            <dd>
              보관함으로 옮길 뿐이고 되살릴 수 있습니다. 보관함은 두 가지입니다.
              <ul>
                <li><strong>삭제 보관함</strong> — 오류 등으로 못 쓰게 된 자료. 폴더째 묶여 한 줄입니다.
                    용량이 문제가 되면 <strong>완전 삭제</strong>까지 갈 수 있습니다.</li>
                <li><strong>폐기 보관함</strong> — 리비전이 진행되며 최신본에서 빠진 자료.
                    자료 1건이 한 줄입니다. 나중에 이력을 찾아야 하므로
                    <strong>완전 삭제가 없고 복구만</strong> 있습니다.</li>
              </ul>
            </dd>

            <dt>② 리비전 번호는 승인돼야만 올라갑니다</dt>
            <dd>
              반려를 몇 번 하든 번호는 그대로이고, 반려된 시도는 글자(a·b·c)가 붙어 이력에 남습니다.
              예: Rev2 를 두 번 반려하면 Rev2-a, Rev2-b 로 남고 다음 시도도 Rev2 를 향합니다.
            </dd>

            <dt>③ 시스템은 도면을 합쳐 주지 않습니다</dt>
            <dd>
              두 업체가 같은 자료를 동시에 고치면 분기 리비전(Rev3-a / Rev3-b)으로 <strong>각각</strong> 보관하고
              자료에 <strong>"병합 필요"</strong> 가 붙습니다.
              사람이 CAD 에서 통합한 파일을 올려야 정식 Rev 가 됩니다.
              <br />
              <span class="muted">시스템은 놓치지 않게 만드는 장치이지, 대신 합쳐 주는 도구가 아닙니다.</span>
            </dd>

            <dt>④ 한 일은 모두 기록됩니다</dt>
            <dd>
              로그인·열람·다운로드·반출·승인·반려·보관·백업이 시스템 로그에 남습니다.
              이 기록은 수정하거나 지울 수 없습니다.
            </dd>
          </dl>
        </div>
      </section>

      <!-- 화면별 안내 -->
      <section>
        <h2 @click="toggle('screens')">
          <span class="caret" :class="{ open: open === 'screens' }">▶</span> 화면별 안내
        </h2>
        <div v-if="open === 'screens'" class="pad">
          <table class="grid">
            <thead><tr><th>화면</th><th>하는 일</th><th>알아 둘 것</th></tr></thead>
            <tbody>
              <tr>
                <td>TDB 조회</td>
                <td>도면을 찾아 보고, 반출대기함에 담아 업체에 내보냅니다.</td>
                <td>Isometric 은 전체의 절반이 넘어 기본으로 숨깁니다. 보려면 토글을 켜세요.</td>
              </tr>
              <tr>
                <td>TDB 반입·검수</td>
                <td>업체가 보낸 수정본을 받아 검수하고 승인합니다.</td>
                <td>자료명이 맞지 않으면 <strong>확인 필요</strong>로 넘어갑니다. 파일은 사라지지 않습니다.</td>
              </tr>
              <tr>
                <td>TDB 관리</td>
                <td>폴더와 자료를 직접 정리합니다.</td>
                <td>폴더 이름 변경·이동은 자료를 건드리지 않습니다. 같은 자리 같은 이름은 거부됩니다.</td>
              </tr>
              <tr>
                <td>TDB 반출이력</td>
                <td>누가 무엇을 언제 가져갔고 돌아왔는지 봅니다.</td>
                <td><strong>미입고</strong>는 "곧 바뀔 수 있는 것" — 안 돌아온 것과 돌아왔지만 검수 전인 것을 함께 셉니다.</td>
              </tr>
              <tr>
                <td>MDB 조회 / 관리</td>
                <td>설비 데이터북을 찾아 보고 정리합니다.</td>
                <td>MDB 는 리비전·반출·검수가 없는 고정 기록입니다. Tag No 로도 찾을 수 있습니다.</td>
              </tr>
              <tr>
                <td>시스템 로그</td>
                <td>누가 무엇을 했는지 찾아봅니다.</td>
                <td>권한이 없으면 자기 기록만 보입니다.</td>
              </tr>
              <tr>
                <td>사용자 관리</td>
                <td>계정과 그룹 권한을 정합니다.</td>
                <td>초기 비밀번호는 <strong>ghub + 아이디</strong>. 첫 로그인 때 변경 화면이 열립니다(미루기 가능).</td>
              </tr>
              <tr>
                <td>백업 관리</td>
                <td>DB·자료·코드를 묶어 내려받습니다.</td>
                <td>이력 줄은 어떤 경우에도 지워지지 않습니다. 되살리기는 묶음 안 안내대로 사람이 합니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 권한 -->
      <section>
        <h2 @click="toggle('perm')">
          <span class="caret" :class="{ open: open === 'perm' }">▶</span> 권한이 동작하는 방식
        </h2>
        <div v-if="open === 'perm'" class="pad">
          <ul>
            <li>권한은 <strong>그룹</strong>에 매기고, 사람은 그룹에 속합니다.</li>
            <li>권한 트리의 구조는 코드에 고정되어 있습니다 — 화면에서 항목을 늘리거나 줄일 수 없습니다.
                실제로 없는 기능에 권한이 생기는 일을 막기 위해서입니다.</li>
            <li>상위 항목을 켜면 하위가 전부 켜집니다. 저장은 언제나 가장 아래 항목 기준입니다.</li>
            <li><strong>권한 트리에 없는 기능은 로그인한 사람 누구나 씁니다.</strong></li>
            <li>관리자(ADMIN)는 권한과 무관하게 전부 통과합니다.</li>
            <li>권한을 바꾸면 <strong>바로 적용</strong>됩니다. 다시 로그인하지 않아도 됩니다.</li>
          </ul>
          <h3>지금 내 권한</h3>
          <p class="muted">
            {{ session.isAdmin ? '관리자 — 모든 기능을 쓸 수 있습니다.'
               : `${session.me?.groupName ?? '그룹 없음'} · 권한 ${session.me?.permissions.length ?? 0}개` }}
          </p>
          <div v-if="!session.isAdmin" class="chips">
            <span v-for="p in session.me?.permissions ?? []" :key="p" class="chip">{{ p }}</span>
          </div>
        </div>
      </section>

      <!-- 자주 묻는 것 -->
      <section>
        <h2 @click="toggle('faq')">
          <span class="caret" :class="{ open: open === 'faq' }">▶</span> 자주 묻는 것
        </h2>
        <div v-if="open === 'faq'" class="pad">
          <dl>
            <dt>메뉴가 안 보입니다</dt>
            <dd>그 화면의 "페이지 접속" 권한이 없습니다. 관리자에게 요청하세요.</dd>

            <dt>DWG 를 화면에서 못 봅니다</dt>
            <dd>웹에서 DWG 를 여는 것은 지원하지 않습니다. 받아서 CAD 로 여세요. PDF 는 화면에서 바로 열립니다.</dd>

            <dt>엑셀·Zip 만들기가 바로 안 끝납니다</dt>
            <dd>뒤에서 만들고 있습니다. 진행률이 보이고, 끝나면 [받기] 가 나타납니다. 화면을 떠나도 계속 만듭니다.</dd>

            <dt>업체가 보낸 파일의 Rev 표기가 다릅니다</dt>
            <dd>경고만 뜨고 막지는 않습니다. 시스템이 매긴 번호가 기준입니다.</dd>

            <dt>잘못 보관함에 보냈습니다</dt>
            <dd>보관함에서 [복구] 하면 원래 자리로 돌아옵니다. 원래 폴더가 사라졌다면 먼저 그 폴더를 복구하세요.</dd>
          </dl>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.help { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { display: flex; align-items: baseline; gap: 10px; padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-h1); margin: 0; font-weight: 600; }
.sub { font-size: var(--fs-sm); }
.body { flex: 1; overflow: auto; min-height: 0; }
section + section { border-top: 1px solid var(--border); }
h2 {
  font-size: var(--fs-lg); margin: 0; padding: 11px 14px; cursor: pointer;
  display: flex; align-items: center; gap: 7px; font-weight: 600;
}
h2:hover { background: var(--bg); }
.caret { font-size: 9px; color: var(--text-muted); transition: transform .12s; }
.caret.open { transform: rotate(90deg); }
.pad { padding: 4px 14px 18px 32px; }
h3 { font-size: var(--fs-base); margin: 16px 0 6px; }
dl { margin: 0; }
dt { font-weight: 600; margin-top: 14px; }
dt:first-child { margin-top: 0; }
dd { margin: 4px 0 0 0; line-height: 1.65; }
ul { margin: 6px 0; padding-left: 20px; line-height: 1.8; }
.grid { border: 1px solid var(--border); }
.grid th, .grid td { border: 1px solid var(--border); padding: 7px 9px; vertical-align: top; text-align: left; }
.grid th { background: var(--bg); font-weight: 600; white-space: nowrap; }
.grid td:first-child { white-space: nowrap; font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  font-size: 11px; padding: 1px 7px; border: 1px solid var(--border-strong);
  border-radius: 9px; color: var(--text-muted);
}
</style>
