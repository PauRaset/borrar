// controllers/socialController.js
const User = require('../models/User');

exports.toggleFollow = async (req, res) => {
  try {
    const meId = req.userId;            // <-- asegúrate que tu auth middleware setea esto
    const targetId = req.body.targetId;

    if (!targetId) return res.status(400).json({ message: 'targetId requerido' });
    const me = await User.findById(meId);
    if (!me) return res.status(401).json({ message: 'No autorizado' });

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
    if (err?.message === 'NO_SELF_FOLLOW' || err?.message === 'NO_SELF_UNFOLLOW') {
      return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });
    }
    if (err?.message === 'TARGET_NOT_FOUND') {
      return res.status(404).json({ message: 'Usuario objetivo no encontrado' });
    }
    console.error('[toggleFollow] error', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.followUser = async (req, res) => {
  try {
    const meId = req.userId;
    const targetId = req.params.id;
    const me = await User.findById(meId);
    if (!me) return res.status(401).json({ message: 'No autorizado' });

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
    if (err?.message === 'NO_SELF_FOLLOW') {
      return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });
    }
    if (err?.message === 'TARGET_NOT_FOUND') {
      return res.status(404).json({ message: 'Usuario objetivo no encontrado' });
    }
    console.error('[followUser] error', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.unfollowUser = async (req, res) => {
  try {
    const meId = req.userId;
    const targetId = req.params.id;
    const me = await User.findById(meId);
    if (!me) return res.status(401).json({ message: 'No autorizado' });

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
    if (err?.message === 'NO_SELF_UNFOLLOW') {
      return res.status(400).json({ message: 'No puedes dejar de seguirte' });
    }
    if (err?.message === 'TARGET_NOT_FOUND') {
      return res.status(404).json({ message: 'Usuario objetivo no encontrado' });
    }
    console.error('[unfollowUser] error', err);
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
    const u = await User.findById(req.params.id).select('followersCount followingCount followers following');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({
      followers: u.followersCount ?? u.followers?.length ?? 0,
      following: u.followingCount ?? u.following?.length ?? 0,
      // attending lo calculáis por otro lado; aquí devolvemos 0 y que el front lo compute si hace falta
      attending: 0,
      isFollowing: !!(req.userId && u.followers?.some(f => f.equals?.(req.userId))),
    });
  } catch (err) {
    console.error('[getUserStats] error', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};