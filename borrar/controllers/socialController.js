const User = require('../models/User');
// controllers/socialController.js
const mongoose = require('mongoose');

// Helpers
const oid = (v) => {
  try {
    return typeof v === 'string' && mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : v;
  } catch {
    return v;
  }
};
const isObjectId = (v) => {
  try {
    return mongoose.Types.ObjectId.isValid(v);
  } catch {
    return false;
  }
};
const pickUserId = (req) => req.userId || req.user?.id || req.user?._id;

// Safe resolve user by key (either ObjectId or firebaseUid)
const resolveUserByKey = async (key) => {
  if (!key) return null;
  if (isObjectId(key)) {
    try {
      return await User.findById(key);
    } catch {
      // ignore cast errors
      return null;
    }
  }
  // fallback to firebaseUid
  return await User.findOne({ firebaseUid: key });
};

// ———————————————————————————————————————————————————————————————————————
// Toggle follow (atomic, idempotent, robust a llamadas repetidas)
// ———————————————————————————————————————————————————————————————————————
exports.toggleFollow = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const targetId = req.body?.targetId;

    console.log('[toggleFollow] meId=', meId, 'targetId=', targetId);

    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    if (!targetId) return res.status(400).json({ message: 'targetId requerido o inválido' });

    if (String(meId) === String(targetId)) {
      return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });
    }

    // Resolve me and target safely
    const me = isObjectId(meId) ? await resolveUserByKey(meId) : await resolveUserByKey(meId);
    let target;
    if (isObjectId(targetId)) {
      target = await resolveUserByKey(targetId);
    } else {
      target = await User.findOne({ firebaseUid: targetId });
    }

    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!target) return res.status(404).json({ message: 'Usuario objetivo no encontrado' });

    // ¿ya lo sigo?
    const already = !!target.followers?.some((f) => String(f) === String(me._id));

    // Ejecutar actualización atómica en ambos lados
    if (already) {
      await Promise.all([
        User.updateOne({ _id: oid(me._id) }, { $pull: { following: oid(target._id) }, $inc: { followingCount: -1 } }),
        User.updateOne({ _id: oid(target._id) }, { $pull: { followers: oid(me._id) }, $inc: { followersCount: -1 } }),
      ]);
    } else {
      await Promise.all([
        User.updateOne({ _id: oid(me._id) }, { $addToSet: { following: oid(target._id) }, $inc: { followingCount: 1 } }),
        User.updateOne({ _id: oid(target._id) }, { $addToSet: { followers: oid(me._id) }, $inc: { followersCount: 1 } }),
      ]);
    }

    // Leer contadores consistentes tras la operación
    const t2 = await User.findById(target._id).select('_id followersCount followingCount followers');

    const payload = {
      ok: true,
      isFollowing: !already,
      target: {
        id: t2._id,
        followers: t2.followersCount ?? (t2.followers?.length ?? 0),
        following: t2.followingCount ?? 0,
      },
    };

    return res.json(payload);
  } catch (err) {
    console.error('[toggleFollow] err', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Follow explícito (legacy)
// ———————————————————————————————————————————————————————————————————————
exports.followUser = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const targetId = req.params.id;

    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    if (!targetId) return res.status(400).json({ message: 'targetId inválido' });
    if (String(meId) === String(targetId)) return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });

    // Resolve me and target safely
    const me = isObjectId(meId) ? await resolveUserByKey(meId) : await resolveUserByKey(meId);
    let target;
    if (isObjectId(targetId)) {
      target = await resolveUserByKey(targetId);
    } else {
      target = await User.findOne({ firebaseUid: targetId });
    }

    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!target) return res.status(404).json({ message: 'Usuario objetivo no encontrado' });

    // Idempotente (si ya sigue, no duplica)
    const already = !!target.followers?.some((f) => String(f) === String(me._id));
    if (!already) {
      await Promise.all([
        User.updateOne({ _id: oid(me._id) }, { $addToSet: { following: oid(target._id) }, $inc: { followingCount: 1 } }),
        User.updateOne({ _id: oid(target._id) }, { $addToSet: { followers: oid(me._id) }, $inc: { followersCount: 1 } }),
      ]);
    }

    const t2 = await User.findById(target._id).select('_id followersCount followingCount followers');
    return res.json({
      ok: true,
      isFollowing: true,
      target: {
        id: t2._id,
        followers: t2.followersCount ?? (t2.followers?.length ?? 0),
        following: t2.followingCount ?? 0,
      },
    });
  } catch (err) {
    console.error('[followUser] err', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Unfollow explícito (legacy)
// ———————————————————————————————————————————————————————————————————————
exports.unfollowUser = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const targetId = req.params.id;

    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    if (!targetId) return res.status(400).json({ message: 'targetId inválido' });
    if (String(meId) === String(targetId)) return res.status(400).json({ message: 'No puedes dejar de seguirte' });

    // Resolve me and target safely
    const me = isObjectId(meId) ? await resolveUserByKey(meId) : await resolveUserByKey(meId);
    let target;
    if (isObjectId(targetId)) {
      target = await resolveUserByKey(targetId);
    } else {
      target = await User.findOne({ firebaseUid: targetId });
    }

    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!target) return res.status(404).json({ message: 'Usuario objetivo no encontrado' });

    await Promise.all([
      User.updateOne({ _id: oid(me._id) }, { $pull: { following: oid(target._id) }, $inc: { followingCount: -1 } }),
      User.updateOne({ _id: oid(target._id) }, { $pull: { followers: oid(me._id) }, $inc: { followersCount: -1 } }),
    ]);

    const t2 = await User.findById(target._id).select('_id followersCount followingCount followers');
    return res.json({
      ok: true,
      isFollowing: false,
      target: {
        id: t2._id,
        followers: t2.followersCount ?? (t2.followers?.length ?? 0),
        following: t2.followingCount ?? 0,
      },
    });
  } catch (err) {
    console.error('[unfollowUser] err', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Listas
// ———————————————————————————————————————————————————————————————————————
exports.getFollowers = async (req, res) => {
  try {
    const u = await User.findById(req.params.id)
      .select('followers')
      .populate('followers', '_id username profilePicture');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ count: u.followers.length, followers: u.followers });
  } catch (err) {
    console.error('[getFollowers] error', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.getFollowing = async (req, res) => {
  try {
    const u = await User.findById(req.params.id)
      .select('following')
      .populate('following', '_id username profilePicture');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ count: u.following.length, following: u.following });
  } catch (err) {
    console.error('[getFollowing] error', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Stats
// ———————————————————————————————————————————————————————————————————————
exports.getUserStats = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const u = await User.findById(req.params.id)
      .select('followersCount followingCount followers following');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });

    res.json({
      followers: u.followersCount ?? u.followers?.length ?? 0,
      following: u.followingCount ?? u.following?.length ?? 0,
      attending: 0, // el front calcula el grid y puede ajustar esto
      isFollowing: !!(meId && u.followers?.some((f) => String(f) === String(meId))),
    });
  } catch (err) {
    console.error('[getUserStats] err', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};
