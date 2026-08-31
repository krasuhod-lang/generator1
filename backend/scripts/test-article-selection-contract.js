#!/usr/bin/env node
/**
 * Source-level regression for opening saved blog/link articles from the task
 * history. This intentionally checks the UI contract without touching API or
 * production data.
 */

const fs = require('fs');
const path = require('path');

const views = [
  { name: 'blog', file: 'InfoArticlePage.vue' },
  { name: 'link', file: 'LinkArticlePage.vue' },
];

for (const view of views) {
  const file = path.resolve(__dirname, '../../frontend/src/views', view.file);
  const source = fs.readFileSync(file, 'utf8');

  const required = [
    ['task list passes the task id', '@click="selectTask(t.id)"'],
    ['detail is loaded by id', 'await store.getTask(id)'],
    ['selection has a loading state', 'selectedTaskLoading'],
    ['selection has a safe visible error state', 'selectedTaskError'],
    ['selected result has a scroll anchor', 'ref="selectedTaskSectionRef"'],
    ['selection waits for Vue DOM update', 'await nextTick()'],
    ['selection scrolls to the result', 'selectedTaskSectionRef.value?.scrollIntoView'],
    ['task row has an accessible button role', 'role="button"'],
    ['deep-link reads the open query', 'route.query.open'],
    ['deep-link changes are watched', 'watch(() => route.query.open'],
  ];

  for (const [description, fragment] of required) {
    if (!source.includes(fragment)) {
      throw new Error(`${view.name}: missing contract — ${description}`);
    }
  }

  if (!source.includes('@keydown.enter.prevent="selectTask(t.id)"')
      || !source.includes('@keydown.space.prevent="selectTask(t.id)"')) {
    throw new Error(`${view.name}: task row must be keyboard selectable`);
  }

  if (!source.includes('catch (_)')
      || source.includes('selectedTaskError.value = err.response?.data?.error')) {
    throw new Error(`${view.name}: selection must not expose raw detail errors in the client UI`);
  }
}

const infoSource = fs.readFileSync(
  path.resolve(__dirname, '../../frontend/src/views/InfoArticlePage.vue'),
  'utf8',
);
const infoFieldsStart = infoSource.indexOf('const ARTICLE_CONTENT_FIELDS');
const infoFields = infoSource.slice(infoFieldsStart, infoSource.indexOf(']);', infoFieldsStart) + 3);
if (infoFields.indexOf("'article_html'") < 0
    || infoFields.indexOf("'article_html'") > infoFields.indexOf("'article_html_with_schema'")) {
  throw new Error('blog: ordinary article_html must be preferred over schema HTML for preview');
}
if (!infoSource.includes('const sanitizeArticleCandidate = (candidate) => DOMPurify.sanitize')
    || !infoSource.includes('const sanitizedHtml = computed(() =>')
    || !infoSource.includes('const cleaned = sanitizeArticleCandidate(candidate)')
    || !infoSource.includes('catch (_)')) {
  throw new Error('blog: article rendering must use the direct fail-safe sanitizer viewer');
}
if (!infoSource.includes('<article ref="articlePreviewRef"')
    || !infoSource.includes('v-html="sanitizedHtml"')) {
  throw new Error('blog: the result panel must render the sanitized article directly');
}

const linkSource = fs.readFileSync(
  path.resolve(__dirname, '../../frontend/src/views/LinkArticlePage.vue'),
  'utf8',
);
if (!linkSource.includes('article_html_with_schema')
    || !linkSource.includes('article_plain')
    || !linkSource.includes('const hasResult = computed(() => Boolean(')) {
  throw new Error('link: saved legacy/schema/plain result fallback is missing');
}

console.log('article selection UX contract: OK');
