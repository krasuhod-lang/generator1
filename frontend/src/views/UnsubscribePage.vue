<template>
  <div class="unsub-root">
    <div class="unsub-card">
      <div v-if="loading" class="state">
        <div class="spinner"></div>
        <p>Обрабатываем запрос…</p>
      </div>

      <div v-else-if="success" class="state">
        <div class="icon ok">✓</div>
        <h1>Вы успешно отписались от рассылки</h1>
        <p>Ваш email больше не будет получать письма от нас.</p>
      </div>

      <div v-else class="state">
        <div class="icon err">!</div>
        <h1>Не удалось обработать отписку</h1>
        <p>{{ errorMessage || 'Ссылка недействительна или устарела.' }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * UnsubscribePage — публичная страница отписки от Outreach-рассылки.
 * Читает email + token из query и вызывает GET /api/outreach/unsubscribe.
 */
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import api from '../api.js';

const route = useRoute();
const loading = ref(true);
const success = ref(false);
const errorMessage = ref('');

onMounted(async () => {
  const email = route.query.email;
  const token = route.query.token;
  if (!email || !token) {
    loading.value = false;
    errorMessage.value = 'В ссылке отсутствует email или token.';
    return;
  }
  try {
    const { data } = await api.get('/outreach/unsubscribe', { params: { email, token } });
    success.value = !!data?.ok;
    if (!success.value) errorMessage.value = data?.error || '';
  } catch (err) {
    success.value = false;
    errorMessage.value = err.response?.data?.error || err.message || '';
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.unsub-root {
  min-height: 100vh;
  background: #f5f5f7;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif;
}
.unsub-card {
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.08);
  padding: 48px 40px;
  max-width: 460px;
  width: 100%;
  text-align: center;
}
.state { display: flex; flex-direction: column; align-items: center; gap: 14px; }
h1 { font-size: 22px; font-weight: 700; color: #1d1d1f; margin: 0; }
p { color: #6e6e73; font-size: 15px; margin: 0; line-height: 1.5; }
.icon {
  width: 64px; height: 64px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 32px; font-weight: 700; color: #fff;
}
.icon.ok { background: #34c759; }
.icon.err { background: #ff9f0a; }
.spinner {
  width: 40px; height: 40px;
  border: 4px solid #e5e5ea; border-top-color: #0071e3;
  border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
