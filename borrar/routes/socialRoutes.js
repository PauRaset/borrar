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

/**
 * Compat notes:
 * - El front llama primero a:  POST /api/social/follow/toggle  (body: {targetId})
 * - Si falla, intenta:         POST /api/users/:id/follow      (legacy)
 *                              DELETE /api/users/:id/follow
 *
 * Aquí exponemos:
 *   1) /follow/toggle                (body.targetId)                ✅ principal
 *   2) /follow/toggle/:id            (usa req.params.id)            ✅ compat
 *   3) /users/:id/follow (POST)      (legacy dentro de /api/social) ✅ compat interna
 *   4) /users/:id/follow (DELETE)    (legacy dentro de /api/social) ✅ compat interna
 *   5) /users/:id/followers          (listar seguidores)
 *   6) /users/:id/following          (listar seguidos)
 *   7) /users/:id/stats              (stats; dejamos anyAuth para que si hay token sepamos isFollowing)
 */

// ---- Follow / Unfollow (toggle) ----
router.post('/follow/toggle', anyAuthWithId, toggleFollow);

// Variante con parámetro por URL para compatibilidad
router.post('/follow/toggle/:id', anyAuthWithId, (req, res, next) => {
  // normaliza a body.targetId
  req.body = req.body || {};
  if (!req.body.targetId && req.params.id) {
    req.body.targetId = req.params.id;
  }
  return toggleFollow(req, res, next);
});

// ---- Legacy explicit endpoints (dentro de /api/social) ----
router.post('/users/:id/follow', anyAuthWithId, followUser);
router.delete('/users/:id/follow', anyAuthWithId, unfollowUser);

// ---- Lists ----
router.get('/users/:id/followers', getFollowers);
router.get('/users/:id/following', getFollowing);

// ---- Stats ----
// Usamos anyAuth para poder calcular `isFollowing` si viene autenticado.
// Si prefieres público 100%, cámbialo por `router.get('/users/:id/stats', getUserStats);`
router.get('/users/:id/stats', anyAuth, getUserStats);

// --- Preflight CORS (por si alguno hace OPTIONS) ---
router.options('/follow/toggle', (_req, res) => res.sendStatus(200));
router.options('/follow/toggle/:id', (_req, res) => res.sendStatus(200));
router.options('/users/:id/follow', (_req, res) => res.sendStatus(200));

module.exports = router;
