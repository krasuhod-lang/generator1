<script setup>
import AdminLayout from '../../components/AdminLayout.vue';
import AdminFunnelsCard from '../../components/AdminFunnelsCard.vue';
import AdminAegisCostsCard from '../../components/AdminAegisCostsCard.vue';
import AdminApiUsageCard from '../../components/AdminApiUsageCard.vue';
</script>

<template>
  <AdminLayout>
    <div class="app-page">
      <div class="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-300/80">Usage observability</p>
          <h2 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">API и расходы</h2>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-gray-500">Контроль токенов, стоимости моделей, кэширования и качества этапов. Каждый блок обновляется независимо и сохраняет свои фильтры.</p>
        </div>
        <div class="rounded-xl border border-violet-400/15 bg-violet-400/[0.04] px-3 py-2 text-xs text-violet-200">Финансовый и технический контроль</div>
      </div>

      <div class="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div class="rounded-xl border border-gray-800 bg-gray-900/50 p-4"><span class="text-lg text-violet-300">◈</span><h3 class="mt-3 text-sm font-medium text-gray-200">Расходы</h3><p class="mt-1 text-xs leading-5 text-gray-600">Стоимость и токены по дням, провайдерам и моделям.</p></div>
        <div class="rounded-xl border border-gray-800 bg-gray-900/50 p-4"><span class="text-lg text-blue-300">⌁</span><h3 class="mt-3 text-sm font-medium text-gray-200">Надёжность</h3><p class="mt-1 text-xs leading-5 text-gray-600">Стадии воронки, причины ошибок и длительные этапы.</p></div>
        <div class="rounded-xl border border-gray-800 bg-gray-900/50 p-4"><span class="text-lg text-amber-300">$</span><h3 class="mt-3 text-sm font-medium text-gray-200">Аномалии</h3><p class="mt-1 text-xs leading-5 text-gray-600">Независимые обращения API и потенциальный перерасход.</p></div>
      </div>

      <div class="space-y-6">
        <AdminFunnelsCard />
        <AdminAegisCostsCard />
        <AdminApiUsageCard />
      </div>
    </div>
  </AdminLayout>
</template>
