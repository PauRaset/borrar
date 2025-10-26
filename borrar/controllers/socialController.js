// controllers/socialController.js
const User = require('../models/User');

exports.toggleFollow = async (req, res) => {
  console.log('[toggleFollow] middleware userId check', req.userId);
  try {
    const meId = req.userId;            // <-- asegúrate que tu auth middleware setea esto
    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    const targetId = req.body.targetId;

    if (!targetId) return res.status(400).json({ message: 'targetId requerido' });
    const me = await User.findById(meId).select('_id username following followers');
    if (!me) {
      console.error('[toggleFollow] err User not found for id:', meId);
      return res.status(401).json({ message: 'No autorizado' });
    }

    // ¿ya le sigo?
    const already = me.following.some(id => id.equals(targetId));
    const result = already ? await me.unfollow(targetId) : await me.follow(targetId);

    // devolver stats ligeros del target
    const target = await User.findById(targetId).select('_id followersCount followingCount');
    return res.json({
      ok: true,
      isFollowing: result.isFollowing,
      target: {
        id: target._id,
        followers: target.followersCount,
        following: target.followingCount,
      }
    });
  } catch (err) {
    console.error('[toggleFollow] err', err.message);
    if (err?.message === 'NO_SELF_FOLLOW' || err?.message === 'NO_SELF_UNFOLLOW') {
      return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });
    }
    if (err?.message === 'TARGET_NOT_FOUND') {
      return res.status(404).json({ message: 'Usuario objetivo no encontrado' });
    }
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.followUser = async (req, res) => {
  try {
    const meId = req.userId;
    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    const targetId = req.params.id;
    const me = await User.findById(meId);
    if (!me) {
      console.error('[followUser] err User not found for id:', meId);
      return res.status(401).json({ message: 'No autorizado' });
    }

    const result = await me.follow(targetId);
    const target = await User.findById(targetId).select('_id followersCount followingCount');

    return res.json({
      ok: true,
      isFollowing: result.isFollowing,
      target: {
        id: target._id,
        followers: target.followersCount,
        following: target.followingCount,
      }
    });
  } catch (err) {
    console.error('[followUser] err', err.message);
    if (err?.message === 'NO_SELF_FOLLOW') {
      return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });
    }
    if (err?.message === 'TARGET_NOT_FOUND') {
      return res.status(404).json({ message: 'Usuario objetivo no encontrado' });
    }
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.unfollowUser = async (req, res) => {
  try {
    const meId = req.userId;
    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    const targetId = req.params.id;
    const me = await User.findById(meId);
    if (!me) {
      console.error('[unfollowUser] err User not found for id:', meId);
      return res.status(401).json({ message: 'No autorizado' });
    }

    const result = await me.unfollow(targetId);
    const target = await User.findById(targetId).select('_id followersCount followingCount');

    return res.json({
      ok: true,
      isFollowing: result.isFollowing,
      target: {
        id: target._id,
        followers: target.followersCount,
        following: target.followingCount,
      }
    });
  } catch (err) {
    console.error('[unfollowUser] err', err.message);
    if (err?.message === 'NO_SELF_UNFOLLOW') {
      return res.status(400).json({ message: 'No puedes dejar de seguirte' });
    }
    if (err?.message === 'TARGET_NOT_FOUND') {
      return res.status(404).json({ message: 'Usuario objetivo no encontrado' });
    }
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.getFollowers = async (req, res) => {
  try {
    const u = await User.findById(req.params.id).select('followers').populate('followers', '_id username profilePicture');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ count: u.followers.length, followers: u.followers });
  } catch (err) {
    console.error('[getFollowers] error', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.getFollowing = async (req, res) => {
  try {
    const u = await User.findById(req.params.id).select('following').populate('following', '_id username profilePicture');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ count: u.following.length, following: u.following });
  } catch (err) {
    console.error('[getFollowing] error', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.getUserStats = async (req, res) => {
  try {
    const meId = req.userId;
    if (!meId) console.error('[getUserStats] warning: no userId in request');
    const u = await User.findById(req.params.id).select('followersCount followingCount followers following');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({
      followers: u.followersCount ?? u.followers?.length ?? 0,
      following: u.followingCount ?? u.following?.length ?? 0,
      // attending lo calculáis por otro lado; aquí devolvemos 0 y que el front lo compute si hace falta
      attending: 0,
      isFollowing: !!(meId && u.followers?.some(f => f.equals?.(meId))),
    });
  } catch (err) {
    console.error('[getUserStats] err', err.message);
    res.status(500).json({ message: 'Error en servidor' });
  }
};
// controllers/socialController.js
const mongoose = require('mongoose');
const User = require('../models/User');

// Helpers
const oid = (v) => (typeof v === 'string' ? new mongoose.Types.ObjectId(v) : v);
const isValidId = (v) => {
  try { return mongoose.Types.ObjectId.isValid(v); } catch { return false; }
};
const pickUserId = (req) => req.userId || req.user?.id || req.user?._id;

// ———————————————————————————————————————————————————————————————————————
// Toggle follow (atomic, idempotent, robust a llamadas repetidas)
// ———————————————————————————————————————————————————————————————————————
exports.toggleFollow = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const targetId = req.body?.targetId;

    console.log('[toggleFollow] meId=', meId, 'targetId=', targetId);

    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    if (!targetId || !isValidId(targetId)) return res.status(400).json({ message: 'targetId requerido o inválido' });

    if (String(meId) === String(targetId)) {
      return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });
    }

    const [me, target] = await Promise.all([
      User.findById(meId).select('_id'),
      User.findById(targetId).select('_id followers following followersCount followingCount'),
    ]);
    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!target) return res.status(404).json({ message: 'Usuario objetivo no encontrado' });

    // ¿ya lo sigo?
    const already = !!target.followers?.some((f) => String(f) === String(meId));

    // Ejecutar actualización atómica en ambos lados
    if (already) {
      await Promise.all([
        User.updateOne({ _id: oid(meId) }, { $pull: { following: oid(targetId) }, $inc: { followingCount: -1 } }),
        User.updateOne({ _id: oid(targetId) }, { $pull: { followers: oid(meId) }, $inc: { followersCount: -1 } }),
      ]);
    } else {
      await Promise.all([
        User.updateOne({ _id: oid(meId) }, { $addToSet: { following: oid(targetId) }, $inc: { followingCount: 1 } }),
        User.updateOne({ _id: oid(targetId) }, { $addToSet: { followers: oid(meId) }, $inc: { followersCount: 1 } }),
      ]);
    }

    // Leer contadores consistentes tras la operación
    const t2 = await User.findById(targetId).select('_id followersCount followingCount followers');

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
    if (!targetId || !isValidId(targetId)) return res.status(400).json({ message: 'targetId inválido' });
    if (String(meId) === String(targetId)) return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });

    const [me, target] = await Promise.all([
      User.findById(meId).select('_id'),
      User.findById(targetId).select('_id followers followersCount followingCount'),
    ]);
    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!target) return res.status(404).json({ message: 'Usuario objetivo no encontrado' });

    // Idempotente (si ya sigue, no duplica)
    const already = !!target.followers?.some((f) => String(f) === String(meId));
    if (!already) {
      await Promise.all([
        User.updateOne({ _id: oid(meId) }, { $addToSet: { following: oid(targetId) }, $inc: { followingCount: 1 } }),
        User.updateOne({ _id: oid(targetId) }, { $addToSet: { followers: oid(meId) }, $inc: { followersCount: 1 } }),
      ]);
    }

    const t2 = await User.findById(targetId).select('_id followersCount followingCount followers');
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
    if (!targetId || !isValidId(targetId)) return res.status(400).json({ message: 'targetId inválido' });
    if (String(meId) === String(targetId)) return res.status(400).json({ message: 'No puedes dejar de seguirte' });

    await Promise.all([
      User.updateOne({ _id: oid(meId) }, { $pull: { following: oid(targetId) }, $inc: { followingCount: -1 } }),
      User.updateOne({ _id: oid(targetId) }, { $pull: { followers: oid(meId) }, $inc: { followersCount: -1 } }),
    ]);

    const t2 = await User.findById(targetId).select('_id followersCount followingCount followers');
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
