-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-aprobar las transcripciones impecables que quedaron atascadas en la cola
--
-- Hasta ahora CUALQUIER señal mandaba la clase a revisión aunque el texto sacara
-- 100/100. En la práctica la cola se llenaba de transcripciones perfectas
-- retenidas por "sin acceso registrado", que no dice nada del texto: dice que el
-- profesor entró por el enlace directo de Meet en vez de pulsar "Ingresar a
-- clase", o que la clase se movió más de un día.
--
-- La regla nueva (lib/transcriptVerdict → decideTranscript) aprueba sola una
-- clase con score >= 80 y NINGUNA señal sobre el contenido. Pero eso solo aplica
-- a lo que se guarde de ahora en adelante: este script aplica el mismo criterio,
-- una vez, a lo que ya está en la cola.
--
-- QUÉ SE APRUEBA — las tres condiciones a la vez:
--   1. Está esperando decisión ('review').
--   2. Score >= 80 (el mismo umbral de auto-aprobación del código).
--   3. Sus señales son SOLO de registro o informativas. `<@` es "contenido en":
--      basta con una señal fuera de esa lista (lenguaje_de_resumen,
--      demasiado_corto, duracion_insuficiente, ia_no_autentico…) para que la
--      clase se quede donde está.
--
-- QUÉ NO se toca: nada que ya esté aprobado o rechazado, y ninguna clase con una
-- señal sobre el contenido. Quedan para que las mires a mano.
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) MIRÁ PRIMERO qué se va a aprobar (no cambia nada).
select
  student_name,
  class_date,
  transcript_validation_score as score,
  transcript_validation_flags as senales
from class_analyses
where validation_status = 'review'
  and transcript_validation_score >= 80
  and coalesce(transcript_validation_flags, '{}') <@ array[
        'sin_acceso_registrado', 'registro_tardio', 'alta_similitud'
      ]::text[]
order by class_date desc;

-- 2) Si el listado de arriba te cuadra, corré esto.
update class_analyses
set validation_status      = 'auto_approved',
    validation_reviewed_by = 'sistema (regla de auto-aprobación)',
    validation_reviewed_at = now()
where validation_status = 'review'
  and transcript_validation_score >= 80
  and coalesce(transcript_validation_flags, '{}') <@ array[
        'sin_acceso_registrado', 'registro_tardio', 'alta_similitud'
      ]::text[];

-- 3) Comprobación: cuántas quedan en la cola y por qué.
select
  transcript_validation_flags as senales,
  count(*)                    as clases,
  min(transcript_validation_score) as score_min,
  max(transcript_validation_score) as score_max
from class_analyses
where validation_status = 'review'
group by transcript_validation_flags
order by clases desc;
