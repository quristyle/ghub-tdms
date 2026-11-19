<script setup lang="ts">
/**
 * 떠 있는 라벨(floating label) 입력 칸 — 조회영역 공용.
 *
 *   <FloatField label="분류"><select v-model="x">…</select></FloatField>
 *   <FloatField label="자료명 검색" class="filter-search"><input v-model="q" type="text" /></FloatField>
 *   <FloatField label="상태" group><button …/><button …/></FloatField>
 *
 * 라벨은 칸 위쪽 테두리에 살짝 걸쳐 그린다(Material 'outlined' 꼴).
 *  · 글 입력 칸이 비어 있고 포커스가 없으면 라벨이 칸 안에 자리표시자처럼 앉아 있다.
 *    포커스를 받거나 값이 있으면 작게 줄며 테두리 위로 올라간다.
 *  · select·날짜·드롭다운은 늘 값이 보이므로 라벨이 처음부터 테두리 위에 걸쳐 있고,
 *    포커스를 받으면 조금 더 작아지고 살짝 더 올라가며 진해진다.
 *
 * 상태 판정은 CSS 만으로 한다(:placeholder-shown / :focus-within). 그래서 v-model 로 값을
 * 지워도(조건 초기화) 이벤트 없이 라벨이 제자리로 돌아온다. 글 입력 칸에 자리표시자가 없으면
 * 공백 하나를 넣어 :placeholder-shown 이 동작하게 한다.
 *
 * 컨트롤에 id 가 없으면 만들어 붙여 <label for> 로 잇는다. group 은 버튼 묶음이라
 * for 대신 role="group" + aria-labelledby 로 잇는다(라벨을 누르면 첫 버튼이 눌리는 일이 없게).
 */
import { onMounted, ref, useId } from 'vue'

const props = defineProps<{ label: string; group?: boolean }>()

const root = ref<HTMLElement>()
const uid = `ff-${useId()}`
const forId = ref<string>()

onMounted(() => {
  if (props.group) return
  const el = root.value?.querySelector<HTMLElement>('input, select, textarea, button')
  if (!el) return
  if (!el.id) el.id = `${uid}-c`
  forId.value = el.id
  if (el instanceof HTMLInputElement && !el.placeholder) el.placeholder = ' '
})
</script>

<template>
  <div
    ref="root" class="ff" :class="{ 'ff-is-group': group }"
    :role="group ? 'group' : undefined" :aria-labelledby="group ? `${uid}-l` : undefined"
  >
    <div v-if="group" class="ff-group"><slot /></div>
    <slot v-else />
    <label :id="`${uid}-l`" class="ff-label" :for="group ? undefined : forId">{{ label }}</label>
  </div>
</template>

<style>
/* 전역 — 슬롯으로 들어온 컨트롤과 형제 선택자(~)로 엮여야 해서 scoped 로 두지 않는다. */
.ff {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  /* 테두리 위로 튀어나온 라벨 몫 — 줄바꿈될 때 윗줄과 겹치지 않게 */
  margin-top: 7px;
}

.ff > select,
.ff > input[type="text"],
.ff > input[type="search"],
.ff > input[type="number"],
.ff > input[type="date"],
.ff > .hideable-dropdown,
.ff > .ms-dropdown .dropdown-toggle {
  width: var(--field-w, 128px);
  max-width: none;
}

/* 검색창 — 기존 .filter-search 폭(220px)을 감싼 쪽이 갖고 안의 입력은 꽉 채운다 */
.ff.filter-search { height: auto; }
.ff.filter-search > input[type="text"] { width: 100%; }

.ff-label {
  position: absolute;
  left: 7px;
  top: 0;
  transform: translateY(-50%);
  max-width: calc(100% - 14px);
  padding: 0 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.02em;
  color: var(--text-dark-gray);
  /* 테두리 선을 끊어 보이게 — 바탕색으로 칠한다 */
  background: var(--ff-bg, var(--surface));
  border-radius: 3px;
  pointer-events: none;
  z-index: 1;
  transition: top 0.15s ease, transform 0.15s ease, font-size 0.15s ease, color 0.15s ease;
}

/* 포커스 — 살짝 작게, 살짝 위로, 진하게 */
.ff:focus-within > .ff-label {
  font-size: 10.5px;
  color: var(--text);
  transform: translateY(-62%);
}

/* 빈 글 입력 칸 + 포커스 없음 — 라벨이 칸 안에 자리표시자처럼 앉는다 */
.ff > input:placeholder-shown:not(:focus) ~ .ff-label {
  top: 50%;
  transform: translateY(-50%);
  font-size: 12.5px;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--text-faint);
  background: transparent;
}
.ff > input:disabled ~ .ff-label { color: var(--text-faint); }

/* 버튼 묶음(상태 토글 등)을 입력 칸과 같은 테두리 상자에 담는다 */
.ff-group {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  /* 위쪽은 걸친 라벨 몫을 비워 둔다 */
  padding: 5px 3px 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
}
.ff-group > button { height: 22px; }
</style>
