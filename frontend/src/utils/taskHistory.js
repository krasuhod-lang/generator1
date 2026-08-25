export const TASK_ACTIVE_STATUSES = Object.freeze([
  'queued',
  'pending',
  'running',
  'processing',
  'in_progress',
]);

export function isTaskActiveStatus(status) {
  return TASK_ACTIVE_STATUSES.includes(String(status || '').toLowerCase());
}

export function taskTimestamp(task, field = 'created_at') {
  const value = task?.[field] || (field === 'created_at' ? task?.updated_at : task?.created_at);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusMatches(status, filter) {
  const value = String(status || '').toLowerCase();
  if (filter === 'all') return true;
  if (filter === 'active') return isTaskActiveStatus(value);
  if (filter === 'done') return value === 'done';
  if (filter === 'error') return value === 'error' || value === 'timeout';
  return value === filter;
}

export function filterAndSortTasks(tasks, { search = '', status = 'all', sort = 'newest' } = {}) {
  const needle = String(search || '').trim().toLocaleLowerCase('ru-RU');
  const source = Array.isArray(tasks) ? tasks : [];
  const filtered = source.filter((task) => {
    if (!statusMatches(task?.status, status)) return false;
    if (!needle) return true;
    const haystack = [
      task?.topic,
      task?.brand_name,
      task?.region,
      task?.anchor_text,
      task?.anchor_url,
      task?.error_message,
    ].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU');
    return haystack.includes(needle);
  });

  return filtered.sort((a, b) => {
    const aTime = taskTimestamp(a, sort === 'recently_updated' ? 'updated_at' : 'created_at');
    const bTime = taskTimestamp(b, sort === 'recently_updated' ? 'updated_at' : 'created_at');
    const direction = sort === 'oldest' ? 1 : -1;
    return (aTime - bTime) * direction || String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

export function taskGroupLabel(value, now = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Без даты';
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today - day) / 86400000);
  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return 'Вчера';
  if (diffDays >= 0 && diffDays < 7) return 'Последние 7 дней';
  return date.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
}

export function groupTasksByDate(tasks) {
  const groups = [];
  const byLabel = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const label = taskGroupLabel(task?.created_at || task?.updated_at);
    let group = byLabel.get(label);
    if (!group) {
      group = { label, tasks: [] };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}
