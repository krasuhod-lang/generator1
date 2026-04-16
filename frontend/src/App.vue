<script setup>
import { onMounted } from 'vue';
import { useAuthStore } from './stores/auth.js';

const auth = useAuthStore();

// Восстанавливаем сессию из localStorage при старте
onMounted(() => {
  auth.restoreSession();
});
</script>

<template>
  <RouterView />
</template>
