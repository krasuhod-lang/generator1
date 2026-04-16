import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    redirect: '/dashboard'
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/LoginPage.vue'),
    meta: { guest: true }
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('../views/RegisterPage.vue'),
    meta: { guest: true }
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('../views/DashboardPage.vue'),
    meta: { auth: true }
  },
  {
    path: '/tasks/create',
    name: 'CreateTask',
    component: () => import('../views/CreateTaskPage.vue'),
    meta: { auth: true }
  },
  {
    path: '/tasks/:id/monitor',
    name: 'Monitor',
    component: () => import('../views/MonitorPage.vue'),
    meta: { auth: true }
  },
  {
    path: '/tasks/:id/result',
    name: 'Result',
    component: () => import('../views/ResultPage.vue'),
    meta: { auth: true }
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('token');

  if (to.meta.auth && !token) {
    return next('/login');
  }
  if (to.meta.guest && token) {
    return next('/dashboard');
  }
  next();
});

export default router;
