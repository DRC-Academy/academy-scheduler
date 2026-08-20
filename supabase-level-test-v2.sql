-- ─────────────────────────────────────────────────────────────────────────────
-- Test de Nivel v2 — dos cambios:
--
--   A. Intentos de ESCRITURA no válidos ("a a a a"). Desde que la escritura se
--      ancló a escala MCER absoluta, la basura ya no saca 0: saca un A1 legítimo.
--      Ahora se detecta (filtro determinista + la propia IA) y el resultado sale
--      marcado como PROVISIONAL, calculado solo con lectura.
--
--   B. No emitir nivel desde un test INCOMPLETO. El submit exigirá las 17
--      respuestas (GRAND_TOTAL en lib/levelTest/constants.ts: 6+5+5 de lectura
--      + 1 de escritura). Se guarda `answered_count` para verlo en el admin y se
--      añade el estado 'abandoned' para los enlaces que caducan a medias.
--
-- Además, una columna que NO es de estos dos cambios pero se aprovecha el viaje:
-- `target_difficulty` (ver bloque 1), necesaria para anclar la lectura a MCER más
-- adelante sin tener que correr otro script a mano contra producción.
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase, DESPUÉS de
-- supabase-level-test.sql. Es idempotente: se puede correr dos veces sin daño.
-- Como el resto del sistema, RLS queda deshabilitado.
--
-- ⚠️ ORDEN: correr ESTO antes de desplegar el código de la rama test-nivel-v2.
--    El código tolera que no se haya corrido (las columnas nuevas se piden en el
--    grupo con reintento), pero hasta que corra no se verá el aviso de nivel
--    provisional en la ficha.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. level_test_answers ────────────────────────────────────────────────────
-- `difficulty` (la dificultad REAL del ítem servido) ya existe y está poblada
-- desde el primer día — no se toca.
--
-- `target_difficulty` es la que el adaptativo PIDIÓ. No son lo mismo:
-- selectNextQuestion (lib/levelTest/adaptive.ts) sirve la más cercana disponible
-- cuando el nivel exacto está agotado, y hoy eso no deja rastro. Con
-- reading_passage y reading_email a 2 ítems por nivel, el desvío es frecuente.
-- Sin este campo no se puede distinguir "respondió un ítem B1" de "le tocaba B2,
-- el banco estaba vacío y recibió B1". Queda null en las respuestas históricas.
alter table level_test_answers add column if not exists target_difficulty int;

-- Por qué se descartó el intento de escritura. Valores que escribe el código
-- (lib/levelTest/attemptValidity.ts + app/api/level-test/[token]/answer):
--   low_diversity   → palabras distintas / totales < 0,3
--   few_distinct    → menos de 15 palabras distintas
--   no_sentence_end → ni un solo . ! ? …
--   word_dominance  → una sola palabra supone más del 40% del texto
--   ai_invalid      → pasó el filtro, pero la IA lo marcó is_valid_attempt=false
--   ai_unavailable  → la IA no respondió (caída/sin clave). NO es culpa del
--                     alumno: el texto puede ser perfectamente válido.
alter table level_test_answers add column if not exists invalid_reason text;

comment on column level_test_answers.difficulty        is 'Dificultad REAL del ítem servido (1-6).';
comment on column level_test_answers.target_difficulty is 'Dificultad que pidió el adaptativo. Distinta de difficulty cuando el banco del nivel estaba agotado.';
comment on column level_test_answers.invalid_reason    is 'Motivo por el que no se puntuó la escritura. null = se puntuó con normalidad.';

-- ── 2. level_test_sessions ───────────────────────────────────────────────────
-- writing_valid: true  → escritura evaluada y válida
--                false → intento no válido (filtro determinista o la IA)
--                null  → todavía no hay escritura, O la IA no respondió. En los
--                        dos casos "no lo sabemos", que no es lo mismo que "no
--                        es válida": por eso null y no false.
alter table level_test_sessions add column if not exists writing_valid          boolean;
alter table level_test_sessions add column if not exists writing_invalid_reason text;

-- Respuestas DISTINTAS registradas. Es un dato derivado, para el listado del
-- admin: la compuerta del submit NO confía en él, cuenta contra
-- level_test_answers (si una respuesta se duplicara, este contador mentiría).
alter table level_test_sessions add column if not exists answered_count int default 0;

comment on column level_test_sessions.writing_valid  is 'true=válida, false=intento no válido, null=sin escritura todavía o IA no disponible.';
comment on column level_test_sessions.answered_count is 'Derivado, solo para mostrar. La validación de completitud cuenta contra level_test_answers.';

-- ── 3. Estado 'abandoned' ────────────────────────────────────────────────────
-- El CHECK original (supabase-level-test.sql:64) solo admite cuatro valores, así
-- que hay que rehacerlo. 'abandoned' = el enlace caducó con el test a medias:
-- sin nivel, y ya no se puede retomar.
--
-- NO se añade un estado 'partial'. Un test a medias sigue siendo 'in_progress',
-- que es justo lo que hace que el alumno pueda retomarlo; "parcial" se deduce de
-- answered_count < 17. Un quinto estado obligaría a tocar los seis sitios que
-- comparan status y es el camino corto a romper la reconexión.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'level_test_sessions'::regclass
      and conname  = 'level_test_sessions_status_check'
  ) then
    alter table level_test_sessions drop constraint level_test_sessions_status_check;
  end if;

  alter table level_test_sessions
    add constraint level_test_sessions_status_check
    check (status in ('pending', 'in_progress', 'completed', 'expired', 'abandoned'));
end $$;

-- ── 4. student_profiles (la FICHA del profesor) ──────────────────────────────
-- Ojo: la ficha del alumno NO lee level_test_sessions, lee student_profiles
-- (app/mis-alumnos/[studentId]/page.tsx). Por eso la marca de provisional tiene
-- que existir también acá, no solo en la sesión.
alter table student_profiles add column if not exists level_test_provisional        boolean default false;
alter table student_profiles add column if not exists level_test_provisional_reason text;

comment on column student_profiles.level_test_provisional        is 'true = el nivel salió solo de la lectura porque la escritura no se pudo puntuar.';
comment on column student_profiles.level_test_provisional_reason is 'Motivo real, para el profesor. Al alumno se le muestra siempre el mismo texto neutro.';

-- ── 5. Backfill de answered_count ────────────────────────────────────────────
-- Cuenta DISTINCT question_id: si alguna respuesta se hubiera duplicado (no hay
-- unique en (session_id, question_id)), contar filas inflaría el número.
update level_test_sessions s
set answered_count = coalesce((
  select count(distinct a.question_id)
  from level_test_answers a
  where a.session_id = s.id
), 0)
where s.answered_count is null or s.answered_count = 0;

-- ── 6. Comprobación ──────────────────────────────────────────────────────────
-- Debería devolver 7 filas (las 7 columnas nuevas). Si devuelve menos, alguna
-- parte del script no se aplicó.
select table_name, column_name
from information_schema.columns
where (table_name = 'level_test_answers'  and column_name in ('target_difficulty', 'invalid_reason'))
   or (table_name = 'level_test_sessions' and column_name in ('writing_valid', 'writing_invalid_reason', 'answered_count'))
   or (table_name = 'student_profiles'    and column_name in ('level_test_provisional', 'level_test_provisional_reason'))
order by table_name, column_name;
