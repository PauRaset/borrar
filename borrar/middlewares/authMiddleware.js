// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');

// Middleware para verificar tu JWT "propio"
const authenticateToken = (req, res, next) => {
  // Puede venir como "Bearer abc..." o directamente el token
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.split(' ')[1] : header;

  if (!token) {
    return res.status(401).json({ message: 'No autorizado' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Normaliza para que SIEMPRE haya req.user.id (string)
    const id = decoded.id || decoded._id || decoded.userId || decoded.sub;
    req.user = { ...decoded, id: id ? String(id) : undefined };

    if (!req.user.id) {
      // El token fue válido criptográficamente, pero no trae un id usable
      return res.status(403).json({ message: 'Token no válido' });
    }

    return next();
  } catch (error) {
    console.error('[authMiddleware] Token no válido:', error?.message || error);
    return res.status(403).json({ message: 'Token no válido' });
  }
};

module.exports = authenticateToken;