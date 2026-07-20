-- Huella del transcript, para detectar subidas duplicadas.
--
-- Se calcula en el cliente antes de guardar (primeros 200 caracteres, base64
-- saneado, 32 chars) y permite avisar cuando el mismo texto se sube para otro
-- alumno u otra fecha.
--
-- OJO: es una huella DÉBIL. Dos transcripts distintos que empiecen igual
-- ("Hola, ¿cómo estás?...") colisionan. Sirve para avisar, nunca para bloquear
-- automáticamente sin que el profesor pueda confirmar.

alter table class_analyses add column if not exists transcript_hash text;

create index if not exists idx_class_analyses_hash
  on class_analyses (teacher_id, transcript_hash);

-- Índice de apoyo para la verificación por alumno + fecha.
create index if not exists idx_class_analyses_teacher_student_date
  on class_analyses (teacher_id, student_name, class_date);
