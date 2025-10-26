// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const admin = require('./firebaseAdmin');

// Helper: get header value case-insensitively
function getHeader(req, name) {
  if (!req || !req.headers) return undefined;
  const key = Object.keys(req.headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? req.headers[key] : undefined;
}

/**
 * Intenta extraer el JWT del request:
 * - Authorization: "Bearer <token>"  ✅
 * - Authorization: "<token>"         ✅
 * - cookies: token / jwt / access_token ✅
 * - query: ?token=... (solo si llega así) ✅
 */
function extractJwtFromRequest(req) {
  // 0) Explicit legacy headers first
  const xAuth = getHeader(req, 'x-auth-token') || getHeader(req, 'auth-token');
  if (typeof xAuth === 'string' && xAuth.trim().length > 0) {
    return xAuth.trim();
  }

  // 1) Authorization: Bearer <token>  |  Authorization: <token>
  const h =
    getHeader(req, 'authorization') ||
    '';

  if (typeof h === 'string' && h.length) {
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    if (!h.includes(' ')) return h.trim();
  }

  // 2) Cookies
  const c = req.cookies || {};
  if (c.token) return c.token;
  if (c.jwt) return c.jwt;
  if (c.access_token) return c.access_token;

  // 3) Query param
  if (req.query?.token) return String(req.query.token);

  return null;
}

// Extrae un Bearer token del header Authorization (pensado para Firebase ID token)
function extractBearerFromHeader(req) {
  const h = getHeader(req, 'authorization') || '';
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

// Intenta verificar el JWT "propio" (legacy) sin responder aún (para usar dentro de anyAuth)
function tryDecodeLegacyJwt(req) {
  const token = extractJwtFromRequest(req);
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const id = decoded.id ?? decoded._id ?? decoded.userId ?? decoded.sub ?? decoded.uid;
    if (!id) return null;
    return { ...decoded, id: String(id) };
  } catch (_) {
    return null;
  }
}

// Verifica Firebase ID token. Si es válido, deja req.firebaseUser y opcionalmente req.user.id
async function verifyFirebaseIdToken(req, res, next) {
  try {
    const idToken = extractBearerFromHeader(req);
    if (!idToken) return res.status(401).json({ message: 'No autorizado' });

    const decoded = await admin.auth().verifyIdToken(idToken);
    req.firebaseUser = decoded; // uid, phone_number, etc.
    // No pisamos req.user si ya está; si no, mapeamos id para compatibilidad
    if (!req.user) {
      req.user = { id: String(decoded.uid) };
    }
    return next();
  } catch (error) {
    console.error('[authMiddleware] Firebase token inválido:', error?.message || error);
    return res.status(403).json({ message: 'Token no válido' });
  }
}

// Middleware híbrido mejorado: acepta JWT propio o Firebase ID token
async function anyAuth(req, res, next) {
  // 1️⃣ Intenta JWT interno (x-auth-token / auth-token / Authorization sin "Bearer")
  const legacy = tryDecodeLegacyJwt(req);
  if (legacy && legacy.id) {
    req.user = legacy;
    return next();
  }

  // 2️⃣ Si no hay JWT válido, intenta con Firebase (Authorization: Bearer <idToken>)
  const idToken = extractBearerFromHeader(req);
  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.firebaseUser = decoded;
      req.user = req.user || { id: String(decoded.uid) };
      return next();
    } catch (error) {
      console.warn('[authMiddleware:anyAuth] Firebase token inválido:', error?.message || error);
    }
  }

  // 3️⃣ Si llega aquí, no hubo ningún token válido
  console.error('[authMiddleware:anyAuth] No autorizado: sin token válido (ni JWT interno ni Firebase)');
  return res.status(401).json({ message: 'No autorizado' });
}

// Garantiza que exista req.user.id (string). Si no, intenta mapear desde Firebase.
function ensureUserId(req, res, next) {
  const id = req.user?.id || req.user?.userId || req.firebaseUser?.uid;
  if (!id) return res.status(401).json({ message: 'No autorizado' });
  req.user = { ...(req.user || {}), id: String(id) };
  return next();
}

// Middleware para verificar tu JWT "propio"
const authenticateToken = (req, res, next) => {
  const token = extractJwtFromRequest(req);

  if (!token) {
    console.error('[authMiddleware.authenticateToken] Missing token (x-auth-token or Authorization)');
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

// Export por compatibilidad (default = authenticateToken) + nombrados
module.exports = authenticateToken;
module.exports.authenticateToken = authenticateToken;
module.exports.extractJwtFromRequest = extractJwtFromRequest;
module.exports.verifyFirebaseIdToken = verifyFirebaseIdToken;
module.exports.anyAuth = anyAuth;
module.exports.ensureUserId = ensureUserId;

// Convenience: hybrid auth that accepts legacy JWT or Firebase, and ensures req.user.id
module.exports.anyAuthWithId = [anyAuth, ensureUserId];
