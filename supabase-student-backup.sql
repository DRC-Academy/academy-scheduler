-- ─────────────────────────────────────────────────────────────────────────────
-- Backup de alumnos eliminados por el ADMIN
--
-- Los dos borrados NO son lo mismo y esta tabla solo interviene en el segundo:
--
--   · PROFESOR (desde su calendario) → DESVINCULACIÓN. Vacía las celdas y el
--     alumno se queda sin horario, pero SIGUE siendo suyo: aparece en "Mis
--     alumnos" como «Actualmente sin tomar clases» y puede volver a asignarlo.
--     No borra nada, así que no genera backup. Ver lib/db.ts →
--     reconcileAssignmentStatus / getStudentsForTeacher.
--
--   · ADMIN (sección Alumnos) → ELIMINACIÓN TOTAL. El alumno desaparece de la
--     plataforma. ANTES de borrar nada se guarda acá su ficha completa, por si
--     vuelve. Ver lib/db.ts → dbBackupStudentBeforeDelete + dbDeleteStudent.
--
-- IMPORTANTE — qué NO se borra en la eliminación total (y por qué):
--   class_analyses se CONSERVA (solo se le pone student_id = null para liberar
--   la FK). Es el segundo factor de verificación del pago al profesor en
--   lib/finance.ts (`status = (join && isTranscript) ? 'pagable' : 'a_revisar'`),
--   así que borrarlo descuadraría la nómina del mes en curso y la de meses ya
--   auditados. Finanzas nunca cruza por student_id: filtra por teacher_id y
--   empareja por student_name, de modo que nulificar el id no le afecta.
--   Una copia entera de esos análisis queda igualmente en class_analyses_data.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deleted_students_backup (
  id text primary key default gen_random_uuid()::text,
  original_student_id text,
  student_name text,
  student_email text,
  plan text,
  level text,
  student_data jsonb,        -- registro completo de students
  profile_data jsonb,        -- registro completo de student_profiles (ficha IA)
  class_analyses_data jsonb, -- array con el historial de class_analyses
  assignments_data jsonb,    -- assignments que tenía (profesor, horarios)
  deleted_by text,
  deleted_at timestamptz default now(),
  restored boolean default false,
  restored_at timestamptz
);

ALTER TABLE deleted_students_backup DISABLE ROW LEVEL SECURITY;

-- Búsquedas típicas del panel: "¿tengo backup de este alumno?" y el listado por
-- fecha de baja (lo consumirá la futura sección "Alumnos eliminados").
CREATE INDEX IF NOT EXISTS idx_deleted_backup_original ON deleted_students_backup (original_student_id);
CREATE INDEX IF NOT EXISTS idx_deleted_backup_email    ON deleted_students_backup (student_email);
CREATE INDEX IF NOT EXISTS idx_deleted_backup_deleted  ON deleted_students_backup (deleted_at desc);
