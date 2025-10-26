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

const { anyAuth, anyAuthWithId } = require('../middlewares/authMiddleware');

// Toggle (seguir / dejar de seguir) – requiere auth
router.post('/follow/toggle', anyAuthWithId, toggleFollow);

// Fallbacks explícitos – requiere auth
router.post('/users/:id/follow', anyAuthWithId, followUser);
router.delete('/users/:id/follow', anyAuthWithId, unfollowUser);

// Listas (públicas o protégelas si quieres)
router.get('/users/:id/followers', getFollowers);
router.get('/users/:id/following', getFollowing);

// Stats (el front las pide)
router.get('/users/:id/stats', anyAuth, getUserStats);

module.exports = router;
