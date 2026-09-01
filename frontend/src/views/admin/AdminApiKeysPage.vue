<script setup>
import { computed, onMounted, ref } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { useAdminStore } from '../../stores/admin.js';

const admin = useAdminStore();
const loading = ref(true);
const saving = ref(null);
const removing = ref(null);
const probing = ref(null);
const probingAll = ref(false);
const health = ref({});
const error = ref('');
const notice = ref('');
const secrets = ref([]);
const audit = ref([]);
const draftValues = ref({});

const groups = computed(() => {
  const map = new Map();
  for (const item of secrets.value) {
    if (!map.has(item.group)) map.set(item.group, []);
    map.get(item.group).push(item);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
});

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function sourceLabel(item) {
  if (item.source === 'vault') return 'Админ-хранилище';
  if (item.source === 'env') return '.env fallback';
  if (item.source === 'disabled') return 'Отключено';
  return 'Не настроен';
}

function sourceClass(item) {
  if (item.source === 'vault') return 'text-emerald-300 bg-emerald-950/50 border-emerald-800';
  if (item.source === 'env') return 'text-blue-300 bg-blue-950/50 border-blue-800';
  if (item.source === 'disabled') return 'text-gray-400 bg-gray-900 border-gray-700';
  return 'text-amber-300 bg-amber-950/40 border-amber-800';
}

function healthLabel(item) {
  const result = health.value[item.envName];
  if (!result) return item.configured ? 'Не проверен' : 'Нет ключа';
  if (result.status === 'active') return 'Ключ активен';
  if (result.status === 'not_configured') return 'Не настроен';
  if (result.status === 'configured_unprobed' || result.status === 'unsupported') return 'Проверка недоступна';
  if (result.status === 'timeout') return 'Тайм-аут проверки';
  return 'Ключ не подтверждён';
}

function healthClass(item) {
  const result = health.value[item.envName];
  if (result?.active === true) return 'text-emerald-300 bg-emerald-950/50 border-emerald-800';
  if (result?.active === false) return 'text-red-300 bg-red-950/40 border-red-800';
  return 'text-gray-400 bg-gray-900 border-gray-700';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [keyData, auditData] = await Promise.all([
      admin.fetchIntegrationKeys(),
      admin.fetchIntegrationKeyAudit(),
    ]);
    secrets.value = keyData.secrets || [];
    audit.value = auditData.audit || [];
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось загрузить API keys';
  } finally {
    loading.value = false;
  }
}

async function save(item) {
  const value = String(draftValues.value[item.envName] || '').trim();
  if (!value) {
    error.value = 'Введите новый ключ перед сохранением';
    return;
  }
  saving.value = item.envName;
  error.value = '';
  notice.value = '';
  try {
    await admin.saveIntegrationKey(item.envName, value, true);
    delete draftValues.value[item.envName];
    notice.value = `${item.label}: ключ сохранён и будет использоваться всеми backend/worker-вызовами.`;
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось сохранить ключ';
  } finally {
    saving.value = null;
  }
}

async function probe(item) {
  probing.value = item.envName;
  error.value = '';
  try {
    const data = await admin.probeIntegrationKey(item.envName);
    health.value = { ...health.value, [item.envName]: data.result || {} };
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось проверить ключ';
  } finally {
    probing.value = null;
  }
}

async function probeAll() {
  probingAll.value = true;
  error.value = '';
  try {
    const data = await admin.probeAllIntegrationKeys();
    health.value = Object.fromEntries((data.results || []).map((item) => [item.envName, item]));
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось проверить ключи';
  } finally {
    probingAll.value = false;
  }
}

async function removeOverride(item) {
  if (item.source !== 'vault') return;
  if (!window.confirm(`Удалить override для «${item.label}»?\n\nПосле этого система вернётся к значению из .env, если оно задано.`)) return;
  removing.value = item.envName;
  error.value = '';
  notice.value = '';
  try {
    const result = await admin.removeIntegrationKey(item.envName);
    notice.value = result.result?.fallbackSource === 'env'
      ? `${item.label}: override удалён, используется .env fallback.`
      : `${item.label}: override удалён, ключ теперь не настроен.`;
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось удалить override';
  } finally {
    removing.value = null;
  }
}

onMounted(load);
</script>

<template>
  <AdminLayout>
    <div class="max-w-7xl mx-auto px-6 py-6 space-y-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="text-xs uppercase tracking-[0.18em] text-emerald-400 font-semibold">Control plane</p>
          <h1 class="text-2xl font-bold text-white mt-1">API ключи и интеграции</h1>
          <p class="text-sm text-gray-400 mt-2 max-w-3xl">
            Единый реестр секретов для AI-моделей, поиска, рассылок и внутренних сервисов.
            Значения шифруются на сервере и никогда не отображаются целиком.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn-ghost" :disabled="loading" @click="load">
            {{ loading ? 'Обновляем…' : 'Обновить' }}
          </button>
          <button type="button" class="btn-primary" :disabled="probingAll || loading" @click="probeAll">
            {{ probingAll ? 'Проверяем ключи…' : 'Проверить все ключи' }}
          </button>
        </div>
      </div>

      <div class="rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
        <strong>Безопасность:</strong> новое значение передаётся только по защищённому admin API,
        сохраняется в AES-256-GCM и не попадает в ответ, логи или audit trail. Удаление override
        возвращает использование ключа из `.env`, если он там задан.
      </div>

      <div v-if="error" class="rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
        {{ error }}
      </div>
      <div v-if="notice" class="rounded-xl border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
        {{ notice }}
      </div>

      <div v-if="loading" class="card text-sm text-gray-400">Загружаем реестр интеграций…</div>
      <template v-else>
        <section v-for="group in groups" :key="group.name" class="space-y-3">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-gray-300">{{ group.name }}</h2>
            <span class="text-xs text-gray-600">{{ group.items.length }} интеграций</span>
          </div>

          <div class="grid gap-3">
            <article
              v-for="item in group.items"
              :key="item.envName"
              class="rounded-xl border border-gray-800 bg-gray-900/70 p-4 shadow-lg shadow-black/10"
            >
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="font-semibold text-gray-100">{{ item.label }}</h3>
                    <span class="rounded-full border px-2 py-0.5 text-[11px]" :class="sourceClass(item)">
                      {{ sourceLabel(item) }}
                    </span>
                    <span class="rounded-full border px-2 py-0.5 text-[11px]" :class="healthClass(item)">
                      {{ healthLabel(item) }}
                    </span>
                  </div>
                  <p class="mt-1 text-sm text-gray-400">{{ item.description }}</p>
                  <p class="mt-2 font-mono text-xs text-gray-600">{{ item.envName }}</p>
                </div>
                <div class="text-right text-xs text-gray-500">
                  <div v-if="item.configured" class="font-mono text-gray-300">{{ item.masked || '••••••••••••' }}</div>
                  <div v-else class="text-amber-400">Не настроен</div>
                  <div class="mt-1">Ротация: {{ fmtDate(item.last_rotated_at) }}</div>
                  <div v-if="health[item.envName]?.latencyMs" class="mt-1">Проверка: {{ health[item.envName].latencyMs }} мс</div>
                </div>
              </div>

              <div class="mt-4 flex flex-col lg:flex-row gap-2">
                <input
                  v-model="draftValues[item.envName]"
                  type="password"
                  autocomplete="new-password"
                  class="input flex-1 font-mono text-sm"
                  :placeholder="item.configured ? 'Введите новый ключ для ротации' : 'Введите API-ключ'"
                  @keyup.enter="save(item)"
                />
                <button
                  type="button"
                  class="btn-primary whitespace-nowrap"
                  :disabled="saving === item.envName || !draftValues[item.envName]"
                  @click="save(item)"
                >
                  {{ saving === item.envName ? 'Сохраняем…' : 'Сохранить ключ' }}
                </button>
                <button
                  type="button"
                  class="btn-ghost whitespace-nowrap text-cyan-300"
                  :disabled="probing === item.envName || !item.configured"
                  @click="probe(item)"
                >
                  {{ probing === item.envName ? 'Проверяем…' : 'Проверить ключ' }}
                </button>
                <button
                  v-if="item.source === 'vault'"
                  type="button"
                  class="btn-ghost whitespace-nowrap text-amber-300"
                  :disabled="removing === item.envName"
                  @click="removeOverride(item)"
                >
                  {{ removing === item.envName ? 'Удаляем…' : 'Вернуть .env' }}
                </button>
              </div>
            </article>
          </div>
        </section>
      </template>

      <section class="card overflow-x-auto">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 class="font-semibold text-white">История ротаций</h2>
            <p class="text-xs text-gray-500 mt-1">Хранятся только имя интеграции, действие и маска.</p>
          </div>
          <span class="text-xs text-gray-600">Последние 100 событий</span>
        </div>
        <table class="w-full min-w-[680px] text-sm">
          <thead>
            <tr class="border-b border-gray-800 text-left text-gray-500">
              <th class="px-3 py-2 font-medium">Дата</th>
              <th class="px-3 py-2 font-medium">Интеграция</th>
              <th class="px-3 py-2 font-medium">Действие</th>
              <th class="px-3 py-2 font-medium">Маска</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in audit" :key="`${row.env_name}-${row.created_at}-${row.action}`" class="border-b border-gray-800/50">
              <td class="px-3 py-2 text-gray-400 whitespace-nowrap">{{ fmtDate(row.created_at) }}</td>
              <td class="px-3 py-2 font-mono text-gray-300">{{ row.env_name }}</td>
              <td class="px-3 py-2 text-gray-400">{{ row.action === 'upsert' ? 'Ротация' : 'Удаление override' }}</td>
              <td class="px-3 py-2 font-mono text-gray-500">{{ row.masked_value || '—' }}</td>
            </tr>
            <tr v-if="!audit.length">
              <td colspan="4" class="px-3 py-6 text-center text-gray-600">Событий пока нет</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </AdminLayout>
</template>
