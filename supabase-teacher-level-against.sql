-- Contra qué nivel comparó el profesor cuando confirmó.
--
-- POR QUÉ. `student_profiles` guarda el nivel del profesor y el de la prueba,
-- pero no cuál era el de la prueba EN EL MOMENTO de confirmar. Si un alumno
-- repite la prueba y da otro nivel, un acuerdo de ayer pasa a leerse como
-- desacuerdo hoy, y al revés. El set de calibración —la pareja (prueba /
-- profesor)— se corrompe solo con el paso del tiempo.
--
-- Con esta columna, "confirmado" y "corregido" quedan congelados en el momento
-- en que el profesor se pronunció, que es cuando la comparación significa algo.
--
-- La aplicación funciona sin esto: `teacherReviewOf` (lib/effectiveLevel) cae al
-- nivel de la prueba actual si la columna no existe, y la API detecta el 42703 y
-- guarda igual el resto. Correrla solo mejora la fidelidad hacia atrás.

alter table public.student_profiles
  add column if not exists teacher_confirmed_against text;

comment on column public.student_profiles.teacher_confirmed_against is
  'Nivel CEFR de referencia (normalmente el de la prueba) en el momento en que el profesor confirmó o corrigió. Congelado: no se recalcula si la prueba se repite.';

-- Relleno de lo que ya hay: para las confirmaciones existentes, la mejor
-- referencia disponible es el nivel de la prueba actual. No es exacto —puede
-- haber cambiado— pero es lo único que hay, y deja de perderse a partir de acá.
update public.student_profiles
   set teacher_confirmed_against = level_test_cefr
 where teacher_confirmed_level is not null
   and teacher_confirmed_against is null
   and level_test_cefr is not null;
