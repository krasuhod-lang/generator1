'use strict';

const express        = require('express');
const adminAuth      = require('../middleware/adminAuth');
const {
  adminLogin,
  listUsers,
  getUserDetail,
  getUserTasks,
  getStats,
} = require('../controllers/admin.controller');

const router = express.Router();

// POST /api/admin/login — публичный
router.post('/login', adminLogin);

// Все остальные — через adminAuth middleware
router.get('/users',              adminAuth, listUsers);
router.get('/users/:userId',      adminAuth, getUserDetail);
router.get('/users/:userId/tasks', adminAuth, getUserTasks);
router.get('/stats',              adminAuth, getStats);

module.exports = router;
