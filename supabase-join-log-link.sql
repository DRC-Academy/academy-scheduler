-- Vínculo explícito entre el transcript y el INGRESO a la clase.
--
-- Por qué: hasta ahora finanzas emparejaba el ingreso (class_join_logs) con el
-- transcript (class_analyses) adivinando por cercanía de fechas (±1 día). Eso
-- falla en dos casos reales:
--   · transcript subido 2+ días tarde → se contaban como DOS clases distintas
--   · alumno con clases en días seguidos → los datos se pisaban entre sí
--
-- Con esta columna el transcript sabe a qué ingreso pertenece y no hay que
-- adivinar. El emparejamiento por fecha se conserva SOLO como respaldo para las
-- clases añadidas a mano (las que nunca pasaron por el botón "Ingresar a clase").

alter table class_analyses add column if not exists join_log_id text;

create index if not exists idx_class_analyses_join_log
  on class_analyses (join_log_id);

-- Un ingreso no puede tener dos transcripts: evita duplicar la clase en el
-- cálculo. Parcial, porque join_log_id es null en todo lo añadido a mano.
create unique index if not exists uq_class_analyses_join_log
  on class_analyses (join_log_id) where join_log_id is not null;
