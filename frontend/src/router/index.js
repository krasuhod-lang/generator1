import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useAdminStore } from '../stores/admin.js';

const routes = [
  { path: '/',         redirect: '/dashboard' },
  { path: '/login',    component: () => import('../views/LoginPage.vue'),      meta: { guest: true } },
  { path: '/register', component: () => import('../views/RegisterPage.vue'),   meta: { guest: true } },
  { path: '/dashboard',component: () => import('../views/DashboardPage.vue'),  meta: { auth: true } },
  { path: '/tasks/new',component: () => import('../views/CreateTaskPage.vue'), meta: { auth: true } },
  { path: '/tasks/:id/edit',    component: () => import('../views/CreateTaskPage.vue'), meta: { auth: true } },
  { path: '/tasks/:id/monitor', component: () => import('../views/MonitorPage.vue'),    meta: { auth: true } },
  { path: '/tasks/:id/result',  component: () => import('../views/ResultPage.vue'),     meta: { auth: true } },
  { path: '/copilot',           component: () => import('../views/CopilotHubPage.vue'), meta: { auth: true } },
  { path: '/tasks/:id/copilot', component: () => import('../views/EditorCopilotPage.vue'), meta: { auth: true } },
  { path: '/meta-tags',    component: () => import('../views/MetaTagsPage.vue'),    meta: { auth: true } },
  { path: '/meta-tags/:id',component: () => import('../views/MetaTagsResultPage.vue'), meta: { auth: true } },
  { path: '/link-article', component: () => import('../views/LinkArticlePage.vue'), meta: { auth: true } },
  { path: '/info-article', component: () => import('../views/InfoArticlePage.vue'), meta: { auth: true } },
  { path: '/article-topics', component: () => import('../views/ArticleTopicsPage.vue'), meta: { auth: true } },
  { path: '/acf-json',     component: () => import('../views/AcfJsonPage.vue'),     meta: { auth: true } },
  { path: '/relevance',    component: () => import('../views/RelevancePage.vue'),    meta: { auth: true } },
  { path: '/relevance/:id',component: () => import('../views/RelevanceResultPage.vue'), meta: { auth: true } },
  { path: '/forecaster',           component: () => import('../views/ForecasterPage.vue'),       meta: { auth: true } },
  { path: '/forecaster/:id',       component: () => import('../views/ForecasterResultPage.vue'), meta: { auth: true } },
  { path: '/forecast/share/:token',component: () => import('../views/ForecasterSharedPage.vue'), meta: { guest: false, public: true } },

  { path: '/category-lead',        component: () => import('../views/CategoryLeadPage.vue'),       meta: { auth: true } },
  { path: '/category-lead/:id',    component: () => import('../views/CategoryLeadResultPage.vue'), meta: { auth: true } },

  { path: '/serp-b2b',             component: () => import('../views/SerpB2bPage.vue'),            meta: { auth: true } },

  { path: '/projects',             component: () => import('../views/ProjectsPage.vue'),        meta: { auth: true } },
  { path: '/projects/:id',         component: () => import('../views/ProjectDetailPage.vue'),   meta: { auth: true } },
  { path: '/share/project/:token', component: () => import('../views/ProjectSharedPage.vue'),   meta: { guest: false, public: true } },

  { path: '/aegis',                component: () => import('../views/AegisPage.vue'),            meta: { auth: true } },

  // Smart Report Builder
  { path: '/reports',              component: () => import('../views/ReportsPage.vue'),       meta: { auth: true } },
  { path: '/reports/new',          component: () => import('../views/ReportNewPage.vue'),     meta: { auth: true } },
  { path: '/reports/shared',       component: () => import('../views/SharedReportsPage.vue'), meta: { auth: true } },
  { path: '/reports/:id/edit',     component: () => import('../views/ReportEditorPage.vue'),  meta: { auth: true } },
  { path: '/r/:uuid',              component: () => import('../views/PublicReportPage.vue'),  meta: { public: true } },

  // Admin routes
  { path: '/admin/login',     component: () => import('../views/admin/AdminLoginPage.vue'),      meta: { adminGuest: true } },
  { path: '/admin',           component: () => import('../views/admin/AdminDashboardPage.vue'),  meta: { admin: true } },
  { path: '/admin/users/:id', component: () => import('../views/admin/AdminUserDetailPage.vue'), meta: { admin: true } },
  { path: '/admin/tasks/:id', component: () => import('../views/admin/AdminTaskDetailPage.vue'), meta: { admin: true } },

  { path: '/:pathMatch(.*)*',   redirect: '/dashboard' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Navigation guard
router.beforeEach((to) => {
  const auth  = useAuthStore();
  const admin = useAdminStore();

  // User routes
  if (to.meta.auth && !auth.isLoggedIn) return '/login';
  if (to.meta.guest && auth.isLoggedIn)  return '/dashboard';

  // Admin routes
  if (to.meta.admin && !admin.isAdminLoggedIn) return '/admin/login';
  if (to.meta.adminGuest && admin.isAdminLoggedIn) return '/admin';
});

export default router;
