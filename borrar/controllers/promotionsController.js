// controllers/promotionsController.js
const mongoose = require('mongoose');

const PromotionLevelTemplate = require('../models/PromotionLevelTemplate');
const UserClubPromotionProgress = require('../models/UserClubPromotionProgress');
const PromotionClaim = require('../models/PromotionClaim');

// Opcionales (si existen en tu backend)
let UserModel = null;
let ClubModel = null;
try { UserModel = require('../models/User'); } catch (_) {}
try { ClubModel = require('../models/Club'); } catch (_) {}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function now() {
  return new Date();
}

/**
 * Intenta obtener info del usuario autenticado.
 * - Si req.user es un doc de Mongo, lo usa.
 * - Si no, intenta sacar firebase uid de varios sitios.
 * - Si existe modelo User, intenta mapear firebase uid -> user mongo.
 */
async function getAuthUser(req) {
  // Caso típico: middleware ya mete usuario mongo
  if (req.user && req.user._id) {
    return { mongoUser: req.user, firebaseUid: req.user.firebaseUid || req.user.uid || null };
  }

  // Firebase uid en diferentes shapes posibles
  const firebaseUid =
    req.firebaseUser?.uid ||
    req.user?.uid ||
    req.user?.firebaseUid ||
    req.auth?.uid ||
    req.uid ||
    req.headers['x-firebase-uid'] ||
    null;

  if (!firebaseUid) {
    return { mongoUser: null, firebaseUid: null };
  }

  // Intentar mapear a Mongo User si el modelo existe
  if (UserModel) {
    // Ajusta aquí si tu campo se llama distinto:
    // firebaseUid / uid / providerId...
    const mongoUser =
      (await UserModel.findOne({ firebaseUid }).lean()) ||
      (await UserModel.findOne({ uid: firebaseUid }).lean()) ||
      null;

    if (mongoUser) return { mongoUser, firebaseUid };
  }

  return { mongoUser: null, firebaseUid };
}

/**
 * Permisos club/admin para validar claims.
 * Ajusta según tu esquema real de roles.
 */
function canManageClub(req, clubId) {
  const u = req.user || {};
  const role = (u.role || u.type || u.userType || '').toString().toLowerCase();

  if (role === 'admin') return true;
  if (role === 'club') return true;

  // Algunos backends usan el propio userId como clubId
  if (u._id && clubId && u._id.toString() === clubId.toString()) return true;

  // Si tienes clubId en user
  if (u.clubId && clubId && u.clubId.toString() === clubId.toString()) return true;

  return false;
}

function pickClubName(clubDoc) {
  if (!clubDoc) return 'Tu club';
  return (
    clubDoc.username ||
    clubDoc.name ||
    clubDoc.displayName ||
    clubDoc.entityName ||
    'Tu club'
  ).toString();
}

function pickClubAvatar(clubDoc) {
  if (!clubDoc) return null;
  return (
    clubDoc.profilePictureUrl ||
    clubDoc.profilePicture ||
    clubDoc.avatar ||
    null
  );
}

function computeMissionRatio(m) {
  const target = Number(m.target || 1);
  const cur = Number(m.current || 0);
  if (target <= 0) return 0;
  return Math.max(0, Math.min(1, cur / target));
}

function computeLevelProgress(level) {
  const missions = Array.isArray(level.missions) ? level.missions : [];
  if (missions.length === 0) return 0;

  // pending cuenta como progreso completo visualmente? (yo lo dejo como ratio real)
  const ratios = missions.map(computeMissionRatio);
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Math.max(0, Math.min(1, avg));
}

function normalizeEvidence(evidence) {
  if (!evidence) return [];
  if (Array.isArray(evidence)) return evidence;
  return [evidence];
}

async function getTemplatesForClub(clubId) {
  // Si existe override por club, lo usamos; si no, global
  const clubTemplates = await PromotionLevelTemplate.find({
    scope: 'club',
    club: clubId,
    active: true,
  }).lean();

  if (clubTemplates && clubTemplates.length) {
    return clubTemplates.sort((a, b) => a.levelNumber - b.levelNumber);
  }

  const globalTemplates = await PromotionLevelTemplate.find({
    scope: 'global',
    active: true,
  }).lean();

  return (globalTemplates || []).sort((a, b) => a.levelNumber - b.levelNumber);
}

async function ensureProgressDoc({ userId, clubId, templates }) {
  let progress = await UserClubPromotionProgress.findOne({ user: userId, club: clubId });

  if (!progress) {
    const built = UserClubPromotionProgress.buildFromTemplates({ templates, startLevel: 1 });
    progress = await UserClubPromotionProgress.create({
      user: userId,
      club: clubId,
      ...built,
    });
  }

  return progress;
}

function findLevel(progress, levelNumber) {
  return (progress.levels || []).find((l) => Number(l.levelNumber) === Number(levelNumber));
}

function findMission(level, missionKey) {
  return (level?.missions || []).find((m) => m.missionKey === missionKey);
}

function unlockNextLevel(progress, completedLevelNumber) {
  const nextLevelNumber = Number(completedLevelNumber) + 1;
  const next = findLevel(progress, nextLevelNumber);
  if (!next) return;

  if (next.status === 'locked') {
    next.status = 'in_progress';
    // Desbloquea misiones del siguiente nivel
    for (const m of next.missions || []) {
      if (m.status === 'locked') m.status = 'in_progress';
      if (!m.startedAt) m.startedAt = now();
      m.updatedAt = now();
    }
  }

  progress.currentLevel = nextLevelNumber;
  progress.currentRewardTitle = next.reward?.title || '';
}

function refreshCurrentSnapshot(progress) {
  const curLevel = findLevel(progress, progress.currentLevel);
  if (!curLevel) {
    progress.currentProgress = 0;
    return;
  }
  curLevel.progress = computeLevelProgress(curLevel);
  progress.currentProgress = curLevel.progress;
  progress.currentRewardTitle = curLevel.reward?.title || '';
}

async function updatePendingClaimsCount(userId, clubId) {
  const count = await PromotionClaim.countDocuments({ user: userId, club: clubId, status: 'pending' });
  await UserClubPromotionProgress.updateOne(
    { user: userId, club: clubId },
    { $set: { pendingClaimsCount: count } }
  );
}

// ===========================
// CONTROLLERS
// ===========================

exports.getMyPromotions = async (req, res) => {
  try {
    const { mongoUser } = await getAuthUser(req);

    if (!mongoUser || !mongoUser._id) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing mongo user' });
    }

    const docs = await UserClubPromotionProgress.find({ user: mongoUser._id })
      .sort({ updatedAt: -1 })
      .lean();

    if (!docs.length) return res.json({ ok: true, promotions: [] });

    // Cargar clubs (si modelo existe) para nombre/avatar
    const clubIds = docs.map((d) => d.club).filter(Boolean);
    let clubsById = {};
    if (ClubModel && clubIds.length) {
      const clubs = await ClubModel.find({ _id: { $in: clubIds } }).lean();
      clubsById = Object.fromEntries(clubs.map((c) => [c._id.toString(), c]));
    }

    const promotions = docs.map((d) => {
      const clubDoc = clubsById[d.club?.toString()] || null;

      return {
        id: d._id.toString(),
        clubId: d.club?.toString(),
        clubName: pickClubName(clubDoc),
        clubAvatarUrl: pickClubAvatar(clubDoc),
        level: d.currentLevel || 1,
        progress: Number(d.currentProgress || 0),
        description:
          d.pendingClaimsCount > 0
            ? `Tienes ${d.pendingClaimsCount} validación(es) pendiente(s)`
            : (d.currentRewardTitle ? `Premio: ${d.currentRewardTitle}` : ''),
        pendingClaimsCount: d.pendingClaimsCount || 0,
      };
    });

    return res.json({ ok: true, promotions });
  } catch (e) {
    console.error('[promotions] getMyPromotions error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.getClubLevelsForUser = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    const { mongoUser } = await getAuthUser(req);
    if (!mongoUser || !mongoUser._id) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing mongo user' });
    }

    const templates = await getTemplatesForClub(clubId);
    if (!templates.length) {
      return res.status(500).json({
        ok: false,
        error: 'No templates found. Seed PromotionLevelTemplate first.',
      });
    }

    const progress = await ensureProgressDoc({
      userId: mongoUser._id,
      clubId,
      templates,
    });

    // recalcular snapshot
    refreshCurrentSnapshot(progress);
    progress.lastActivityAt = now();
    await progress.save();

    return res.json({
      ok: true,
      clubId,
      currentLevel: progress.currentLevel,
      currentProgress: progress.currentProgress,
      pendingClaimsCount: progress.pendingClaimsCount || 0,
      levels: progress.levels,
    });
  } catch (e) {
    console.error('[promotions] getClubLevelsForUser error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.createClaim = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    const { mongoUser } = await getAuthUser(req);
    if (!mongoUser || !mongoUser._id) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing mongo user' });
    }

    const {
      levelNumber,
      missionKey,
      missionType,
      evidence,
      userNote,
      eventId,
    } = req.body || {};

    if (!levelNumber || !missionKey || !missionType) {
      return res.status(400).json({
        ok: false,
        error: 'Missing fields: levelNumber, missionKey, missionType',
      });
    }

    const templates = await getTemplatesForClub(clubId);
    if (!templates.length) {
      return res.status(500).json({ ok: false, error: 'No templates found (seed first).' });
    }

    const progress = await ensureProgressDoc({
      userId: mongoUser._id,
      clubId,
      templates,
    });

    const level = findLevel(progress, levelNumber);
    if (!level) {
      return res.status(404).json({ ok: false, error: 'Level not found in progress' });
    }

    const mission = findMission(level, missionKey);
    if (!mission) {
      return res.status(404).json({ ok: false, error: 'Mission not found in progress' });
    }

    if (!mission.requiresApproval) {
      return res.status(400).json({
        ok: false,
        error: 'This mission does not require approval; it should be auto-completed.',
      });
    }

    // Evitar claims duplicados pending
    const existing = await PromotionClaim.findOne({
      user: mongoUser._id,
      club: clubId,
      levelNumber: Number(levelNumber),
      missionKey,
      status: 'pending',
    }).lean();

    if (existing) {
      return res.status(409).json({ ok: false, error: 'A pending claim already exists for this mission.' });
    }

    const claim = await PromotionClaim.create({
      user: mongoUser._id,
      club: clubId,
      event: isValidObjectId(eventId) ? eventId : null,
      levelNumber: Number(levelNumber),
      missionType: String(missionType),
      missionKey: String(missionKey),
      status: 'pending',
      evidence: normalizeEvidence(evidence),
      userNote: (userNote || '').toString(),
      ip: (req.ip || '').toString(),
      userAgent: (req.headers['user-agent'] || '').toString(),
    });

    // Actualizar misión en progreso
    mission.status = 'pending';
    mission.claimId = claim._id;
    mission.updatedAt = now();

    level.progress = computeLevelProgress(level);
    refreshCurrentSnapshot(progress);
    progress.lastEventId = isValidObjectId(eventId) ? eventId : progress.lastEventId;
    progress.lastActivityAt = now();

    await progress.save();
    await updatePendingClaimsCount(mongoUser._id, clubId);

    return res.status(201).json({ ok: true, claim });
  } catch (e) {
    console.error('[promotions] createClaim error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.cancelClaim = async (req, res) => {
  try {
    const { claimId } = req.params;
    if (!isValidObjectId(claimId)) {
      return res.status(400).json({ ok: false, error: 'Invalid claimId' });
    }

    const { mongoUser } = await getAuthUser(req);
    if (!mongoUser || !mongoUser._id) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing mongo user' });
    }

    const claim = await PromotionClaim.findById(claimId);
    if (!claim) return res.status(404).json({ ok: false, error: 'Claim not found' });

    if (claim.user.toString() !== mongoUser._id.toString()) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (claim.status !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Only pending claims can be cancelled' });
    }

    claim.status = 'cancelled';
    claim.reviewedAt = now();
    await claim.save();

    // Revertir misión pending -> in_progress
    const progress = await UserClubPromotionProgress.findOne({ user: mongoUser._id, club: claim.club });
    if (progress) {
      const level = findLevel(progress, claim.levelNumber);
      const mission = findMission(level, claim.missionKey);
      if (mission && mission.status === 'pending') {
        mission.status = 'in_progress';
        mission.claimId = null;
        mission.updatedAt = now();
        if (level) level.progress = computeLevelProgress(level);
        refreshCurrentSnapshot(progress);
        progress.lastActivityAt = now();
        await progress.save();
      }
      await updatePendingClaimsCount(mongoUser._id, claim.club);
    }

    return res.json({ ok: true, claim });
  } catch (e) {
    console.error('[promotions] cancelClaim error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.listClubClaims = async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!isValidObjectId(clubId)) {
      return res.status(400).json({ ok: false, error: 'Invalid clubId' });
    }

    if (!canManageClub(req, clubId)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const status = (req.query.status || 'pending').toString();
    const q = { club: clubId };
    if (status) q.status = status;

    const claims = await PromotionClaim.find(q)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({ ok: true, claims });
  } catch (e) {
    console.error('[promotions] listClubClaims error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.approveClaim = async (req, res) => {
  try {
    const { claimId } = req.params;
    if (!isValidObjectId(claimId)) {
      return res.status(400).json({ ok: false, error: 'Invalid claimId' });
    }

    const claim = await PromotionClaim.findById(claimId);
    if (!claim) return res.status(404).json({ ok: false, error: 'Claim not found' });

    if (!canManageClub(req, claim.club.toString())) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (claim.status !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Only pending claims can be approved' });
    }

    const reviewNote = (req.body?.reviewNote || '').toString();

    claim.status = 'approved';
    claim.reviewedBy = req.user?._id || null;
    claim.reviewedAt = now();
    claim.reviewNote = reviewNote;
    await claim.save();

    // Aplicar a progreso
    const progress = await UserClubPromotionProgress.findOne({ user: claim.user, club: claim.club });
    if (!progress) {
      return res.status(200).json({ ok: true, claim, warning: 'Progress doc not found' });
    }

    const level = findLevel(progress, claim.levelNumber);
    const mission = findMission(level, claim.missionKey);

    if (mission) {
      mission.status = 'completed';
      mission.current = mission.target || 1;
      mission.completedAt = now();
      mission.updatedAt = now();
    }

    if (level) {
      // Si todas misiones completadas => nivel completado
      const missions = level.missions || [];
      const allDone = missions.length > 0 && missions.every((m) => m.status === 'completed');
      level.progress = computeLevelProgress(level);

      if (allDone && level.status !== 'completed') {
        level.status = 'completed';
        level.completedAt = now();

        // desbloquear siguiente
        unlockNextLevel(progress, level.levelNumber);
      }
    }

    refreshCurrentSnapshot(progress);
    progress.lastActivityAt = now();
    await progress.save();

    await updatePendingClaimsCount(claim.user, claim.club);

    return res.json({ ok: true, claim });
  } catch (e) {
    console.error('[promotions] approveClaim error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.rejectClaim = async (req, res) => {
  try {
    const { claimId } = req.params;
    if (!isValidObjectId(claimId)) {
      return res.status(400).json({ ok: false, error: 'Invalid claimId' });
    }

    const claim = await PromotionClaim.findById(claimId);
    if (!claim) return res.status(404).json({ ok: false, error: 'Claim not found' });

    if (!canManageClub(req, claim.club.toString())) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (claim.status !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Only pending claims can be rejected' });
    }

    const reviewNote = (req.body?.reviewNote || '').toString();

    claim.status = 'rejected';
    claim.reviewedBy = req.user?._id || null;
    claim.reviewedAt = now();
    claim.reviewNote = reviewNote;
    await claim.save();

    // Aplicar a progreso
    const progress = await UserClubPromotionProgress.findOne({ user: claim.user, club: claim.club });
    if (progress) {
      const level = findLevel(progress, claim.levelNumber);
      const mission = findMission(level, claim.missionKey);
      if (mission) {
        mission.status = 'rejected';
        mission.claimId = null;
        mission.updatedAt = now();
      }
      if (level) level.progress = computeLevelProgress(level);
      refreshCurrentSnapshot(progress);
      progress.lastActivityAt = now();
      await progress.save();
      await updatePendingClaimsCount(claim.user, claim.club);
    }

    return res.json({ ok: true, claim });
  } catch (e) {
    console.error('[promotions] rejectClaim error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

exports.upsertClubLevelOverrides = async (req, res) => {
  // Esto lo implementamos cuando lleguemos a “clubs pueden editar premios/misiones”.
  return res.status(501).json({
    ok: false,
    error: 'Not implemented yet: club level overrides',
  });
};
