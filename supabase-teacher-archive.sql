-- ── Archivar profesores en vez de borrarlos ──────────────────────────────────
--
-- POR QUÉ NO SE BORRA. Ocho tablas referencian `teachers(id)` con clave foránea
-- y SIN `on delete cascade`:
--
--   assignments · class_records · class_join_logs · finance_payments
--   class_analyses · class_review_requests · form_tokens · level_test_sessions
--
-- Postgres exige que la fila padre exista mientras alguna de ellas apunte al
-- profesor, así que un profesor que dio aunque sea UNA clase no se puede borrar
-- sin destruir antes esa clase. Y esas filas son la base contable de meses ya
-- cerrados: borrarlas cambia el gasto de un mes liquidado.
--
-- Es decir: "borrar el profesor" y "conservar su historial" son incompatibles a
-- nivel de esquema. El código ya decía que quería lo segundo (ver el comentario
-- de dbArchiveTeacher en lib/db.ts), pero intentaba lo primero — y fallaba con
-- un 23503 que la UI mostraba como "Inténtalo de nuevo".
--
-- LA SOLUCIÓN: una fecha. `archived_at` no nulo = el profesor ya no está con la
-- academia. Desaparece de la app y de los avisos, conserva todo su historial, y
-- se deshace poniendo la columna a NULL.
--
-- OJO CON EL LOGIN: archivar BORRA la fila de `app_users` del profesor (revocar
-- el acceso es justamente el punto). Desarchivar devuelve al profesor a las
-- listas pero NO le devuelve el usuario: hay que volver a crearlo.

alter table teachers add column if not exists archived_at timestamptz;

-- Índice parcial: las consultas siempre preguntan por los NO archivados, que son
-- la inmensa mayoría. Indexar solo las filas archivadas sería inútil; este índice
-- sirve al `archived_at is null` que filtra la plantilla.
create index if not exists idx_teachers_archived_at on teachers(archived_at);

comment on column teachers.archived_at is
  'Fecha en que el profesor dejó la academia. NULL = en plantilla. '
  'No se borran profesores: las FK de class_records/finance_payments/etc. lo impiden '
  'y su historial contable debe sobrevivir. Ver lib/db.ts:dbArchiveTeacher.';
