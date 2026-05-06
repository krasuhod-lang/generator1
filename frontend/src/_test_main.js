import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import RelevanceResultPage from './views/RelevanceResultPage.vue';
import './style.css';
import api from './api.js';

window.__errors = [];
window.addEventListener('error', e => window.__errors.push('error:' + e.message));
window.addEventListener('unhandledrejection', e => window.__errors.push('reject:' + (e.reason?.message || e.reason)));

const fakeReport = {
  id: 'r1', query: 'тест', lr: '213', top_n: 20, status: 'done',
  current_stage: null, fetched_count: 5, serp: [
    { url: 'http://a.com/p', title: 'A' },
    { url: 'http://b.com/p', title: 'B' },
  ],
  failed_urls: [], error_message: null, duration_ms: 1234,
  created_at: new Date().toISOString(), started_at: null, completed_at: null,
  has_raw: false, has_cocoons: false, raw_expires_at: null, raw_storage: 'pg',
  exclude_aggregators: false, our_url: null, our_report: null, comparison: null,
  cocoons: null,
  report: {
    stats: { parsed_doc_count: 5, doc_count: 5, total_tokens: 100, avg_doc_length: 200 },
    vocabulary: [
      { lemma: 'ремонт', df: 5, median_count: 4, bm25_score: 1.5, tf_idf_score: 0.4, status: 'important' },
      { lemma: 'квартира', df: 4, median_count: 3, bm25_score: 1.2, tf_idf_score: 0.3, status: 'important' },
      { lemma: 'ключ', df: 3, median_count: 2, bm25_score: 0.8, tf_idf_score: 0.2, status: 'additional' },
    ],
    ngrams: [
      { phrase: 'ремонт квартир', df: 5, df_share_pct: 100, median_count: 2, type: 'bigram', pos_pattern: 'NOUN+NOUN' },
    ],
    document_diagnostics: [
      { url: 'http://a.com/p', method: 'axios', text_chars: 1234, word_count: 200, parsed_preview: 'hello', tag_zone_chars: 100, headings: [{level:'h2',text:'one'}] },
    ],
    fail_breakdown: {},
    filter: { exclude_aggregators: false, removed_aggregators: [], skipped_same_host: [] },
    tag_zone_vocabulary: [
      { lemma: 'москва', df: 4, median_count: 3, bm25_score: 1.0, status: 'important' },
    ],
    headings_intersection: [
      { text: 'виды работ', sample: 'Виды работ', df: 4, df_share_pct: 80, levels: ['h2','h3'] },
    ],
  },
};

api.get = async (url) => {
  if (url.includes('/relevance/')) return { data: { report: fakeReport } };
  return { data: {} };
};
api.post = async () => ({ data: {} });
api.delete = async () => ({ data: {} });

// Mock auth store too — AppLayout might use it
import { useAuthStore } from './stores/auth.js';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div/>' } },
    { path: '/login', component: { template: '<div>login</div>' } },
    { path: '/relevance', component: { template: '<div/>' } },
    { path: '/relevance/:id', component: RelevanceResultPage },
  ],
});

import { h } from 'vue';
import { RouterView } from 'vue-router';
const app = createApp({ render: () => h(RouterView) });
app.config.errorHandler = (err, ins, info) => {
  window.__errors.push('vue:' + (err?.message || err) + ' info:' + info + (err?.stack ? '\n' + err.stack : ''));
  console.error('VUE ERROR', err, info);
};
app.use(createPinia());
app.use(router);

const auth = useAuthStore();
auth.user = { id: 'u1', email: 't@t', role: 'user' };
auth.token = 'tok';

router.push('/relevance/r1').then(() => {
  app.mount('#app');
});
