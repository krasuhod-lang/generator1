import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const routes = [
  { path: '/',         redirect: '/dashboard' },
  { path: '/login',    component: () => import('../views/LoginPage.vue'),      meta: { guest: true } },
  { path: '/register', component: () => import('../views/RegisterPage.vue'),   meta: { guest: true } },
  { path: '/dashboard',component: () => import('../views/DashboardPage.vue'),  meta: { auth: true } },
  { path: '/tasks/new',component: () => import('../views/CreateTaskPage.vue'), meta: { auth: true } },
  { path: '/tasks/:id/edit',    component: () => import('../views/CreateTaskPage.vue'), meta: { auth: true } },
  { path: '/tasks/:id/monitor', component: () => import('../views/MonitorPage.vue'),    meta: { auth: true } },
  { path: '/tasks/:id/result',  component: () => import('../views/ResultPage.vue'),     meta: { auth: true } },
  { path: '/meta-tags',    component: () => import('../views/MetaTagsPage.vue'),    meta: { auth: true } },
  { path: '/link-article', component: () => import('../views/LinkArticlePage.vue'), meta: { auth: true } },
  { path: '/info-article', component: () => import('../views/InfoArticlePage.vue'), meta: { auth: true } },
  { path: '/:pathMatch(.*)*',   redirect: '/dashboard' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Navigation guard
router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.auth && !auth.isLoggedIn) return '/login';
  if (to.meta.guest && auth.isLoggedIn)  return '/dashboard';
});

export default router;
