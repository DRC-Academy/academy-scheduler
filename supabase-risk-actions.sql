-- ─────────────────────────────────────────────────────────────────────────────
-- Del diagnóstico a la ACCIÓN. Idempotente.
--
-- Dos columnas sobre class_analyses. Todo lo demás (el contexto de la clase
-- anterior, la causa vigente y el motivo por el que una alerta sigue abierta)
-- viaja dentro de student_profiles.active_intervention, que ya es jsonb: no
-- hace falta migrar nada para eso.
--
--   detections  → de 1 a 3 parejas {finding, action}: qué se detectó y qué hacer
--                 al respecto. Se rellena en TODAS las clases, también en las que
--                 salen en verde, porque "recurre al español" o "ritmo lento" son
--                 hallazgos pedagógicos y no señales de baja. El diagnóstico sin
--                 su acción emparejada era justamente el problema.
--
--   risk_cause  → 'externa_temporal' | 'desmotivacion' | 'dificultad_academica'
--                 | 'sin_determinar' | 'no_aplica'. El color dice cuánto
--                 preocupa; la causa dice qué hacer. Un amarillo por vacaciones
--                 y uno por desmotivación piden intervenciones opuestas, y antes
--                 los dos llegaban al profesor como "amarillo" a secas.
--                 'sin_determinar' es una respuesta válida y se muestra tal cual:
--                 es mejor que el profesor sepa que no se sabe a que actúe sobre
--                 una causa inventada.
--
-- Sin correr esto la aplicación NO se rompe: las escrituras de class_analyses
-- descartan la columna que la base diga que no existe y siguen (ver
-- writeWithFallback en lib/transcriptStore.ts). Lo único que pasa es que las
-- detecciones y la causa no se guardan, y queda el aviso en el log del servidor.
-- ─────────────────────────────────────────────────────────────────────────────

alter table class_analyses add column if not exists detections jsonb;
alter table class_analyses add column if not exists risk_cause  text;

-- El panel de riesgo filtra por causa al revisar la cola.
create index if not exists idx_class_analyses_risk_cause
  on class_analyses (risk_cause) where risk_cause is not null;
