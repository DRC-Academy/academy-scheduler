// Avisos de la campanita (tabla notifications) con el cliente INYECTADO.
// Sin lib/supabase.ts: lo usan tanto el navegador (lib/db.ts) como el servidor.

import type { SupabaseClient } from '@supabase/supabase-js';

type Db = SupabaseClient;

const randomSuffix = (): string => Math.random().toString(36).slice(2, 6);

/** Inserta un aviso. LANZA si el insert falla (quien llama decide si es best-effort). */
async function insertNotification(db: Db, row: {
  id: string; target_user: string | null; target_role: string | null;
  title: string; body: string; type: string;
}): Promise<void> {
  const { error } = await db.from('notifications').insert({
    ...row,
    read_by:    [],
    created_at: new Date().toISOString(),
    created_by: 'sistema',
  });
  if (error) throw new Error(`No se pudo guardar el aviso "${row.type}": ${error.message}`);
}

/** Aviso al profesor de que tiene un alumno nuevo (alta o cambio de profesor). */
export function notifyNewAssignmentWith(db: Db, teacherId: string, studentName: string, studentEmail: string): Promise<void> {
  return insertNotification(db, {
    id:          `notif_newasgn_${Date.now()}_${randomSuffix()}`,
    target_user: teacherId,
    target_role: null,
    title:       '📚 Nuevo alumno asignado',
    body:        `Se te asignó ${studentName}. Recordá presentarte por correo electrónico (${studentEmail || 'sin email'}) antes de la primera clase.`,
    type:        'new_assignment',
  });
}

/** Aviso al profesor ANTERIOR de que su alumno pasó a otro profesor. */
export function notifyStudentTransferredWith(db: Db, teacherId: string, studentName: string): Promise<void> {
  return insertNotification(db, {
    id:          `notif_transfer_${Date.now()}_${randomSuffix()}`,
    target_user: teacherId,
    target_role: null,
    title:       'ℹ️ Alumno transferido',
    body:        `${studentName} fue transferido a otro profesor.`,
    type:        'student_transferred',
  });
}

/** Aviso para los admins (campanita, target_role='admin'). */
export function notifyAdminWith(db: Db, n: { title: string; body: string; type: string; id?: string }): Promise<void> {
  return insertNotification(db, {
    id:          n.id ?? `notif_${n.type}_${Date.now()}_${randomSuffix()}`,
    target_user: null,
    target_role: 'admin',
    title:       n.title,
    body:        n.body,
    type:        n.type,
  });
}
