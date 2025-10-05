// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');

/**
 * Intenta extraer el JWT del request:
 * - Authorization: "Bearer <token>"  ✅
 * - Authorization: "<token>"         ✅
 * - cookies: token / jwt / access_token ✅
 * - query: ?token=... (solo si llega así) ✅
 */
function extractJwtFromRequest(req) {
  const h =
    req.headers?.authorization ||
    req.headers?.Authorization ||
    '';

  if (typeof h === 'string' && h.length) {
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    if (!h.includes(' ')) return h.trim();
  }

  const c = req.cookies || {};
  if (c.token) return c.token;
  if (c.jwt) return c.jwt;
  if (c.access_token) return c.access_token;

  if (req.query?.token) return String(req.query.token);

  return null;
}

// Middleware para verificar tu JWT "propio"
const authenticateToken = (req, res, next) => {
  const token = extractJwtFromRequest(req);

  if (!token) {
    return res.status(401).json({ message: 'No autorizado' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Normaliza para que SIEMPRE haya req.user.id (string)
    const id =
      decoded.id ??
      decoded._id ??
      decoded.userId ??
      decoded.sub ??
      decoded.uid;

    const userId = id ? String(id) : undefined;
    if (!userId) {
      return res.status(403).json({ message: 'Token no válido' });
    }

    req.user = { ...decoded, id: userId };
    return next();
  } catch (error) {
    console.error('[authMiddleware] Token no válido:', error?.message || error);
    return res.status(403).json({ message: 'Token no válido' });
  }
};

module.exports = authenticateToken;
