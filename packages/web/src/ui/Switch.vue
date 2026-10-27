<script setup lang="ts">
/**
 * 체크 아이콘을 포함한 토글 스위치 컴포넌트.
 *
 * 셀 값 강조 또는 설정 변경 등에 사용할 수 있는 모던한 스위치입니다.
 * 활성화(checked) 시 스위치 노브(thumb) 내부에 체크 아이콘(✓)이 표시되어
 * On/Off 상태를 직관적이고 깔끔하게 구분할 수 있습니다.
 */

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    disabled?: boolean
    title?: string
    ariaLabel?: string
    size?: 'sm' | 'md'
  }>(),
  {
    modelValue: false,
    disabled: false,
    size: 'sm',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  change: [value: boolean]
}>()

function toggle() {
  if (props.disabled) return
  const next = !props.modelValue
  emit('update:modelValue', next)
  emit('change', next)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="ariaLabel ?? title"
    :disabled="disabled"
    class="check-switch"
    :class="[size, { checked: modelValue, disabled }]"
    :title="title"
    @click.stop="toggle"
  >
    <span class="switch-track">
      <span class="switch-thumb">
        <svg
          class="switch-check-icon"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="2.5 6.2 4.8 8.5 9.5 3.5" />
        </svg>
      </span>
    </span>
  </button>
</template>

<style scoped>
.check-switch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  cursor: pointer;
  outline: none;
  user-select: none;
  vertical-align: middle;
  line-height: 1;
}

.check-switch.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 트랙 (sm: 36px x 20px, md: 44px x 24px) */
.switch-track {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  background: var(--border-strong, #cbd5e1);
  border-radius: 999px;
  transition: background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 0.2s ease;
}

.check-switch.md .switch-track {
  width: 44px;
  height: 24px;
}

.check-switch:hover:not(.disabled) .switch-track {
  filter: brightness(0.96);
}

.check-switch.checked .switch-track {
  background: var(--ok, #15803d);
}

.check-switch:focus-visible .switch-track {
  box-shadow: 0 0 0 2px var(--surface, #ffffff), 0 0 0 4px var(--primary, #c8102e);
}

/* 썸 (노브: sm: 16px x 16px, md: 20px x 20px) */
.switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #ffffff;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), 0 1px 1px rgba(0, 0, 0, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1),
              background-color 0.2s ease;
}

.check-switch.md .switch-thumb {
  width: 20px;
  height: 20px;
}

/* On 상태일 때 슬라이드 이동 */
.check-switch.checked .switch-thumb {
  transform: translateX(16px);
}

.check-switch.md.checked .switch-thumb {
  transform: translateX(20px);
}

/* 체크 아이콘 */
.switch-check-icon {
  width: 10px;
  height: 10px;
  color: var(--ok, #15803d);
  opacity: 0;
  transform: scale(0.4);
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.check-switch.md .switch-check-icon {
  width: 12px;
  height: 12px;
}

.check-switch.checked .switch-check-icon {
  opacity: 1;
  transform: scale(1);
}
</style>
