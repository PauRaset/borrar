// routes/socialRoutes.js
const express = require('express');
const router = express.Router();
const {
  toggleFollow,
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  getUserStats,
} = require('../controllers/socialController');

const { anyAuth } = require('../middlewares/authMiddleware');

// Toggle (seguir / dejar de seguir) – requiere auth
router.post('/social/follow/toggle', anyAuth, toggleFollow);

// Fallbacks explícitos – requiere auth
router.post('/users/:id/follow', anyAuth, followUser);
router.delete('/users/:id/follow', anyAuth, unfollowUser);

// Listas (públicas o protégelas si quieres)
router.get('/users/:id/followers', getFollowers);
router.get('/users/:id/following', getFollowing);

// Stats (el front las pide)
router.get('/users/:id/stats', anyAuth, getUserStats);

module.exports = router;