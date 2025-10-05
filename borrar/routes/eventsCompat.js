const express = require('express');
const router = express.Router();

// Ajusta si tu controller tiene otro nombre/ruta:
const events = require('../controllers/eventController');

/**
 * Devuelve la 1ª función existente entre varios nombres candidatos.
 * Si no hay ninguna, devuelve un handler 501 que además avisa por consola.
 */
const pick = (...names) => {
  for (const n of names) {
    if (typeof events[n] === 'function') return events[n];
  }
  return (req, res) => {
    console.warn('[eventsCompat] No handler for any of:', names);
    res.status(501).json({ error: `No handler found for: ${names.join(' | ')}` });
  };
};

/**
 * Alias MUY amplios (EN + ES + variantes comunes).
 * Añade aquí los nombres reales si los conoces.
 */
const list = pick(
  // EN habituales
  'listEvents','getAllEvents','getEvents','index','list','getAll','findAll',
  // ES habituales
  'listarEventos','obtenerEventos','getEventos','listar','obtenerTodos'
);

const getOne = pick(
  // EN
  'getEvent','getById','findOne','show','detail','get',
  // ES
  'obtenerEvento','getEvento','buscarPorId','detalle','mostrar'
);

const create = pick(
  // EN
  'createEvent','create','store','add',
  // ES
  'crearEvento','crear','guardar','nuevo','alta'
);

const update = pick(
  // EN
  'updateEvent','update','updateById','edit','patch','modify','modifyById',
  // ES
  'actualizarEvento','actualizar','editar','modificar','modificarEvento','patchEvento'
);

const remove = pick(
  // EN
  'deleteEvent','remove','destroy','del','delete',
  // ES
  'eliminarEvento','eliminar','borrar','baja'
);

const image = pick(
  // EN
  'uploadImage','uploadEventImage','imageUpload','addImage',
  // ES
  'subirImagenEvento','subirImagen','cargarImagen'
);

// ---- REST estándar
router.get('/events', list);
router.get('/events/:id', getOne);

router.post('/events', create);
router.delete('/events/:id', remove);

// Actualización: acepta PUT / PATCH / POST
router.put('/events/:id', update);
router.patch('/events/:id', update);
router.post('/events/:id', update);

// Aliases (singular)
router.get('/event/:id', getOne);
router.post('/event', create);
router.put('/event/:id', update);
router.patch('/event/:id', update);
router.post('/event/:id', update);

// Variantes tipo edit/update
router.post('/events/update/:id', update);
router.post('/events/edit/:id', update);
router.put('/events/edit/:id', update);
router.put('/events/:id/update', update);
router.patch('/events/:id/update', update);

// Imagen (si existe handler)
router.post('/events/:id/image', image);
router.post('/event/:id/image', image);

module.exports = router;
