<script setup>
import { onMounted } from 'vue';
import { useAuthStore } from './stores/auth.js';
import { useAdminStore } from './stores/admin.js';

const auth  = useAuthStore();
const admin = useAdminStore();

// Восстанавливаем сессии из localStorage при старте
onMounted(() => {
  auth.restoreSession();
  admin.restoreSession();
});
</script>

<template>
  <RouterView />
</template>
