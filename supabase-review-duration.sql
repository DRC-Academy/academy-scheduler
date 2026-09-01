-- ── Horas de una clase declarada por solicitud de revisión ───────────────────
--
-- EL PROBLEMA. Una clase que entra por /revisiones se paga con las horas que
-- diga `sessionSpanFor` (lib/finance.ts), y esa función lee el CALENDARIO DE HOY
-- (`teacher_calendars`, una sola fila por profesor, sin historia). Cuando el
-- horario del alumno cambia entre la clase y su aprobación, el calendario ya no
-- describe aquel día: una sesión de 2 h aprobada en septiembre se pagaba como 1 h
-- porque el grid de septiembre ya solo tiene una celda.
--
-- `class_review_requests.duration_hours` sí lo sabe — es una foto AUTOMÁTICA del
-- calendario tomada al declararse la clase (lib/attendance.ts: run.length) — pero
-- ese número no llegaba a finanzas: se mostraba al admin y ahí moría.
--
-- LA SOLUCIÓN. El ingreso (`class_join_logs`) es lo que CREA la clase para el
-- pago, así que es donde tiene que viajar el dato. Al aprobar una solicitud, sus
-- horas se copian al ingreso y finanzas las prefiere al calendario.
--
-- NULL NO ES CERO, y acá tampoco es 1: NULL significa "no hay declaración,
-- preguntá al calendario". Por eso las columnas son nullable y sin default — los
-- ingresos por clic y todo lo anterior a esta migración quedan en NULL y se
-- siguen comportando exactamente igual que antes.

-- ── 1) En la SOLICITUD: quién puso el número ────────────────────────────────
--
-- El admin puede corregir las horas al validar (ve el transcript y el comentario
-- del profesor, que es más de lo que sabe el calendario). Cuando lo hace, el
-- valor automático NO se pierde: se guarda aparte para poder auditar la
-- diferencia sin una tabla de historial.

alter table class_review_requests
  add column if not exists duration_hours_auto int,
  add column if not exists duration_source     text default 'calendario';

comment on column class_review_requests.duration_hours_auto is
  'Horas que calculó el calendario al enviarse la solicitud (lib/attendance.ts, run.length). '
  'Se conserva aunque el admin corrija duration_hours, para poder auditar la diferencia. '
  'NULL en las solicitudes anteriores a esta migración.';

comment on column class_review_requests.duration_source is
  'Quién fijó duration_hours: calendario (automático al enviar) | admin (corregido al validar).';

-- ── 2) En el INGRESO: de dónde salen las horas que se cobran ────────────────
--
-- OJO: este `duration_source` NO usa el mismo vocabulario que el de arriba, y es
-- deliberado. Allí la pregunta es "¿quién escribió este número?"; acá es "¿de
-- dónde salen las horas que finanzas está cobrando?", y ahí 'calendario' sería
-- ambiguo: significaría el calendario del día de la clase, que es justo lo
-- contrario del NULL, que significa el calendario de HOY.

alter table class_join_logs
  add column if not exists duration_hours  int,
  add column if not exists duration_source text;

comment on column class_join_logs.duration_hours is
  'Horas declaradas en la solicitud de revisión que creó este ingreso. '
  'NULL = no hay declaración: la duración la decide el calendario de hoy '
  '(lib/finance.sessionSpanFor). Los ingresos por clic la dejan siempre en NULL.';

comment on column class_join_logs.duration_source is
  'De dónde salen esas horas: solicitud (foto automática del calendario del día de la clase) '
  '| admin (corregidas por el equipo al validar). NULL = ninguna declaración, manda el '
  'calendario de hoy.';
