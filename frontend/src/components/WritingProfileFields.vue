<script setup>
const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const genres = [
  'Информационная экспертная статья',
  'Коммерческая статья / страница услуги',
  'Обзор / сравнение',
  'Инструкция / how-to',
  'FAQ / справочный материал',
  'Кейс / практическое исследование',
  'Новость / аналитический обзор',
];
const tones = [
  'Дружески-экспертный',
  'Строго деловой',
  'Нейтральный справочный',
  'Премиальный консультационный',
  'Технический профессиональный',
];
const complexity = ['Простой', 'Средний', 'Продвинутый'];
const professionalLevels = ['Практик', 'Отраслевой эксперт', 'Редакция с экспертной проверкой'];

function update(key, value) {
  emit('update:modelValue', { ...(props.modelValue || {}), [key]: value });
}
</script>

<template>
  <div class="space-y-3 rounded-lg border border-gray-800 bg-gray-900/30 p-3">
    <div class="text-xs font-medium uppercase tracking-wider text-indigo-300">Профиль написания</div>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label class="label">Жанр текста</label>
        <select :value="modelValue?.genre || ''" class="input" :disabled="disabled" @change="update('genre', $event.target.value)">
          <option value="">Определить по нише</option>
          <option v-for="item in genres" :key="item" :value="item">{{ item }}</option>
        </select>
      </div>
      <div>
        <label class="label">Тональность</label>
        <select :value="modelValue?.tone || ''" class="input" :disabled="disabled" @change="update('tone', $event.target.value)">
          <option value="">Определить по бренду и ЦА</option>
          <option v-for="item in tones" :key="item" :value="item">{{ item }}</option>
        </select>
      </div>
      <div>
        <label class="label">Сложность текста</label>
        <select :value="modelValue?.complexity || ''" class="input" :disabled="disabled" @change="update('complexity', $event.target.value)">
          <option value="">Определить по аудитории</option>
          <option v-for="item in complexity" :key="item" :value="item">{{ item }}</option>
        </select>
      </div>
      <div>
        <label class="label">Уровень профессионализма</label>
        <select :value="modelValue?.professional_level || ''" class="input" :disabled="disabled" @change="update('professional_level', $event.target.value)">
          <option value="">Определить по нише</option>
          <option v-for="item in professionalLevels" :key="item" :value="item">{{ item }}</option>
        </select>
      </div>
    </div>
    <div>
      <label class="label">Особые требования к стилю</label>
      <textarea :value="modelValue?.voice_notes || ''" class="textarea h-20" :disabled="disabled"
        placeholder="Например: обращаться на «вы», избегать канцелярита, не обещать гарантированный результат."
        @input="update('voice_notes', $event.target.value)" />
    </div>
    <div class="flex flex-col gap-2 text-xs text-gray-400">
      <label class="inline-flex items-center gap-2">
        <input type="checkbox" :checked="modelValue?.freshness_required === true" :disabled="disabled"
          @change="update('freshness_required', $event.target.checked)" />
        Проверять актуальность данных на дату подготовки текста
      </label>
      <label class="inline-flex items-center gap-2">
        <input type="checkbox" :checked="modelValue?.current_law_required === true" :disabled="disabled"
          @change="update('current_law_required', $event.target.checked)" />
        Требуется проверка законов, правил или регуляторных изменений
      </label>
    </div>
  </div>
</template>
