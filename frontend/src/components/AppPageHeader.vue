<script setup>
defineProps({
  eyebrow: { type: String, default: '' },
  title: { type: String, required: true },
  description: { type: String, default: '' },
});
</script>

<template>
  <header class="app-page-heading">
    <div class="min-w-0">
      <p v-if="eyebrow" class="app-page-kicker">{{ eyebrow }}</p>
      <h1 class="flex items-center gap-2 flex-wrap">
        {{ title }}
        <slot name="title-suffix" />
      </h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex items-center gap-2 flex-wrap">
      <slot name="actions" />
    </div>
  </header>
</template>
