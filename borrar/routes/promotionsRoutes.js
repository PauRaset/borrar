// routes/promotionsRoutes.js
const express = require('express');
const router = express.Router();

const promotionsController = require('../controllers/promotionsController');
const requireFirebase = require('../middlewares/requireFirebase');

// ===========================
// USER (app)
// ===========================

// Lista de promos del usuario (para pintar la pantalla principal)
// GET /api/promotions/my
router.get('/my', requireFirebase, promotionsController.getMyPromotions);

// Devuelve niveles (10) + progreso del usuario para un club
// GET /api/promotions/:clubId/levels
router.get('/:clubId/levels', requireFirebase, promotionsController.getClubLevelsForUser);

// Crear un claim (subir prueba: foto/qr/text) para una misión
// POST /api/promotions/:clubId/claims
router.post('/:clubId/claims', requireFirebase, promotionsController.createClaim);

// Cancelar un claim propio (opcional)
// POST /api/promotions/claims/:claimId/cancel
router.post('/claims/:claimId/cancel', requireFirebase, promotionsController.cancelClaim);

// ===========================
// CLUB (panel)
// ===========================

// Listar claims pendientes para un club (opcional pero MUY útil para el panel)
// GET /api/promotions/clubs/:clubId/claims?status=pending
router.get('/clubs/:clubId/claims', requireFirebase, promotionsController.listClubClaims);

// Aprobar claim (club valida)
// POST /api/promotions/claims/:claimId/approve
router.post('/claims/:claimId/approve', requireFirebase, promotionsController.approveClaim);

// Rechazar claim (club valida)
// POST /api/promotions/claims/:claimId/reject
router.post('/claims/:claimId/reject', requireFirebase, promotionsController.rejectClaim);

// Editar niveles/premios del club (override) — lo dejamos preparado
// PUT /api/promotions/clubs/:clubId/levels
router.put('/clubs/:clubId/levels', requireFirebase, promotionsController.upsertClubLevelOverrides);

module.exports = router;
