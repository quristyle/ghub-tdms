<script setup lang="ts">
import Modal from '@/ui/Modal.vue'
import MyPage from '@/pages/MyPage.vue'

/**
 * 마이페이지 팝업 — 상단 바의 사용자 이름을 누르면 뜬다.
 * 새롭게 만들어진 마이페이지 화면(MyPage.vue)을 팝업 형태로 제공한다.
 * 공통 Modal 을 사용하여 드래그 이동(movable) 및 크기 조절(resizable)이 가능하다.
 */
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Modal title="마이페이지" width="720px" @close="emit('close')">
    <MyPage :is-modal="true" @close="emit('close')" />
  </Modal>
</template>
