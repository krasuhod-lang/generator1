<script setup>
import AdminLayout from '../../components/AdminLayout.vue';
import AdminStorageCard from '../../components/AdminStorageCard.vue';
</script>

<template>
  <AdminLayout>
    <div class="app-page">
      <div class="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-300/80">Storage operations</p>
          <h2 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Хранилище</h2>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-gray-500">Разбивка по диску, каталогам, таблицам PostgreSQL, Redis и артефактам задач. Очистка выполняется только через preview и дополнительное подтверждение.</p>
        </div>
        <div class="rounded-xl border border-amber-400/15 bg-amber-400/[0.04] px-3 py-2 text-xs text-amber-200">Данные защищены от случайного удаления</div>
      </div>
      <AdminStorageCard />
    </div>
  </AdminLayout>
</template>
