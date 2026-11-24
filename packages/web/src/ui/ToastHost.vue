<script setup lang="ts">
import { toasts, dismissToast } from '@/lib/toast'
</script>

<template>
  <Teleport to="body">
    <aside class="toast-viewport" aria-label="알림" aria-live="polite">
      <TransitionGroup name="toast-anim" tag="div" class="toast-list">
        <div
          v-for="item in toasts"
          :key="item.id"
          class="toast-card"
          :class="item.kind"
          :role="item.kind === 'err' ? 'alert' : 'status'"
        >
          <div class="toast-icon" aria-hidden="true">
            <span v-if="item.kind === 'ok'">✓</span>
            <span v-else-if="item.kind === 'warn'">⚠</span>
            <span v-else-if="item.kind === 'err'">✕</span>
            <span v-else>ℹ</span>
          </div>

          <div class="toast-content">
            <div class="toast-text">{{ item.text }}</div>
            <div v-if="item.sub?.length" class="toast-sub-list">
              <div v-for="(s, idx) in item.sub" :key="idx" class="toast-sub">{{ s }}</div>
            </div>
          </div>

          <button
            type="button"
            class="toast-close"
            title="닫기"
            aria-label="알림 닫기"
            @click="dismissToast(item.id)"
          >
            ✕
          </button>
        </div>
      </TransitionGroup>
    </aside>
  </Teleport>
</template>

<style scoped>
.toast-viewport {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 10000;
  pointer-events: none;
  max-width: min(480px, calc(100vw - 32px));
}

.toast-list {
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  align-items: flex-end;
}

.toast-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 14px;
  border-radius: var(--radius-lg, 8px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18), 0 2px 4px rgba(0, 0, 0, 0.08);
  font-size: 13px;
  line-height: 1.45;
  pointer-events: auto;
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-sizing: border-box;
  width: auto;
  min-width: 240px;
  max-width: 100%;
  word-break: break-word;
}

.toast-card.ok {
  background: var(--ok, #3f6b52);
  color: #ffffff;
}

.toast-card.err {
  background: var(--danger, #97453e);
  color: #ffffff;
}

.toast-card.warn {
  background: var(--warn, #8a6636);
  color: #ffffff;
}

.toast-card.info {
  background: var(--info, #45607d);
  color: #ffffff;
}

.toast-icon {
  flex-shrink: 0;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.35;
}

.toast-content {
  flex: 1;
  min-width: 0;
}

.toast-text {
  font-weight: 500;
  white-space: pre-wrap;
}

.toast-sub-list {
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px solid rgba(255, 255, 255, 0.3);
  font-size: 11.5px;
  opacity: 0.95;
}

.toast-sub {
  line-height: 1.4;
}

.toast-close {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
  padding: 2px 5px;
  font-size: 12px;
  line-height: 1;
  border-radius: 4px;
  margin-left: 2px;
  margin-top: 1px;
}

.toast-close:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.2);
}

/* 애니메이션 */
.toast-anim-enter-active,
.toast-anim-leave-active {
  transition: all 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.toast-anim-enter-from {
  opacity: 0;
  transform: translateY(16px) scale(0.96);
}

.toast-anim-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.96);
}

@media (max-width: 600px) {
  .toast-viewport {
    bottom: 16px;
    right: 16px;
    left: 16px;
    max-width: none;
  }
  .toast-list {
    align-items: stretch;
  }
  .toast-card {
    min-width: 0;
    width: 100%;
  }
}
</style>
