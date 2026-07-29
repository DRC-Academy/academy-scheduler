-- ===========================================================================
-- FIX: pestanas "Validacion" e "IA y Riesgo" vacias (29/07/2026)
--
-- ASCII puro a proposito: la version anterior llevaba tildes, flechas y guiones
-- largos en los comentarios y al pegarla en el editor SQL alguno se rompio,
-- dejando un token suelto que reventaba el ALTER siguiente (42601).
--
-- Junta las dos migraciones que faltaban en produccion:
--   1) supabase-transcript-validation.sql  (validation_status y compania)
--   2) supabase-join-log-link.sql          (join_log_id)
--
-- Es idempotente: se puede correr varias veces sin efecto.
--
-- Sobre las filas existentes: al anadir validation_status con default 'ok',
-- Postgres rellena las 17 filas ya guardadas con 'ok'. Es lo que se busca: son
-- clases que nunca pasaron por la validacion y no deben bloquearse el pago de
-- forma retroactiva. Tampoco apareceran en la pestana, que solo lista
-- review / approved / rejected.
-- ===========================================================================


-- 1) Columnas de validacion de transcripciones.

alter table class_analyses add column if not exists transcript_validation_score int;

alter table class_analyses add column if not exists transcript_validation_flags text[];

alter table class_analyses add column if not exists ai_authenticity_check jsonb;

-- Estados posibles de validation_status:
--   'ok'        validada automaticamente (segundo factor valido)
--   'review'    pendiente de revision del equipo (no cuenta hasta aprobarse)
--   'approved'  aprobada manualmente por el admin (cuenta)
--   'rejected'  rechazada por el admin (no cuenta; se avisa al profesor)
alter table class_analyses add column if not exists validation_status text default 'ok';

alter table class_analyses add column if not exists validation_reviewed_by text;

alter table class_analyses add column if not exists validation_reviewed_at timestamptz;

create index if not exists idx_class_analyses_validation
  on class_analyses (validation_status);


-- 2) Vinculo entre el transcript y el ingreso a la clase.

alter table class_analyses add column if not exists join_log_id text;

create index if not exists idx_class_analyses_join_log
  on class_analyses (join_log_id);

create unique index if not exists uq_class_analyses_join_log
  on class_analyses (join_log_id) where join_log_id is not null;


-- 3) Comprobacion: deben salir las 8 columnas.

select column_name, data_type, column_default
from information_schema.columns
where table_name = 'class_analyses'
  and column_name in (
    'transcript_validation_score',
    'transcript_validation_flags',
    'ai_authenticity_check',
    'validation_status',
    'validation_reviewed_by',
    'validation_reviewed_at',
    'transcript_hash',
    'join_log_id'
  )
order by column_name;
