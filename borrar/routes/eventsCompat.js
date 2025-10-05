// routes/eventsCompat.js
const express = require('express');
const router = express.Router();

// Ajusta la ruta si tu archivo se llama distinto
const events = require('../controllers/eventController');

// Helper: elige la primera función existente entre varios nombres.
// Si no existe ninguna, devuelve un handler 501 (para no romper Express).
const pick = (...names) => {
  for (const n of names) {
    if (typeof events[n] === 'function') return events[n];
  }
  return (req, res) =>
    res.status(501).json({ error: `No handler found for: ${names.join(' | ')}` });
};

// Intenta casar nombres típicos de cada acción
const list   = pick('listEvents', 'getAllEvents', 'getEvents', 'index', 'list', 'getAll');
const getOne = pick('getEvent', 'getById', 'findOne', 'show', 'detail');
const create = pick('createEvent', 'create', 'store', 'add');
const update = pick('updateEvent', 'update', 'updateById', 'edit', 'patch');
const remove = pick('deleteEvent', 'remove', 'destroy', 'del', 'delete');
const image  = pick('uploadImage', 'uploadEventImage', 'imageUpload', 'addImage');

// ---- REST "estándar"
router.get('/events', list);
router.get('/events/:id', getOne);

router.post('/events', create);
router.delete('/events/:id', remove);

// Acepta PUT/PATCH/POST para actualizar (según backend)
router.put('/events/:id', update);
router.patch('/events/:id', update);
router.post('/events/:id', update);

// ---- Aliases comunes (singular)
router.get('/event/:id', getOne);
router.post('/event', create);
router.put('/event/:id', update);
router.patch('/event/:id', update);
router.post('/event/:id', update);

// ---- Variantes “edit/update” que usan algunos backends
router.post('/events/update/:id', update);
router.post('/events/edit/:id', update);
router.put('/events/edit/:id', update);
router.put('/events/:id/update', update);
router.patch('/events/:id/update', update);

// ---- Imagen (si existe handler)
router.post('/events/:id/image', image);
router.post('/event/:id/image', image);

module.exports = router;
