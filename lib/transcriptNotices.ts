// Ids de los avisos de campanita del transcript y su RESOLUCIÓN al subirlo.
// SOLO SERVIDOR (recibe el cliente admin).
//
// Archivo aparte y sin dependencias pesadas: lo importan las rutas que guardan
// el transcript (save-transcript, analyze-transcript), que no deben arrastrar
// lib/db. La creación de los avisos vive en lib/transcriptDeadlineNotifications.

import type { SupabaseClient } from '@supabase/supabase-js';

const slug = (s: string) =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Id fijo del aviso de plazo de una clase: idempotente por construcción. */
export function deadlineNoticeId(teacherId: string, date: string, studentName: string, kind: '6h' | 'vencida'): string {
  return `tx_dl_${teacherId}_${date}_${slug(studentName)}_${kind}`;
}

/**
 * Se SUBIÓ el transcript de esta clase: sus avisos dejan de tener sentido.
 *   · Los del profesor (⏳ < 6 h, 🔴 vencido, 📋 sin estado) se marcan como
 *     leídos por él: la campanita deja de contarlos y quedan en el historial.
 *   · El del admin (📋 "clase sin estado (48 h)") se borra: la clase ya tiene
 *     estado y el reloj no lo vuelve a crear.
 * Nunca lanza: un fallo acá no puede tumbar el guardado del transcript.
 */
export async function resolveTranscriptNotices(admin: SupabaseClient, args: {
  teacherId: string | null | undefined; studentName: string; classDate: string | null | undefined;
}): Promise<{ resolved: number; deleted: number }> {
  const { teacherId, studentName, classDate } = args;
  if (!teacherId || !classDate || !studentName.trim()) return { resolved: 0, deleted: 0 };
  try {
    const exactIds = [
      deadlineNoticeId(teacherId, classDate, studentName, '6h'),
      deadlineNoticeId(teacherId, classDate, studentName, 'vencida'),
    ];
    // Los de "sin estado" llevan la hora entre la fecha y el alumno
    // (lib/classStatus.statusIdOf): estado_<profe>_<fecha>_<HH>_<alumno>[_admin].
    // En el filtro `or` de PostgREST el comodín de LIKE se escribe `*`.
    const estado = `estado_${teacherId}_${classDate}_*_${slug(studentName)}`;
    const [byId, byStatus] = await Promise.all([
      admin.from('notifications').select('id, target_user, read_by').in('id', exactIds),
      admin.from('notifications').select('id, target_user, read_by').or(`id.like.${estado},id.like.${estado}_admin`),
    ]);
    if (byId.error || byStatus.error) {
      console.error('[transcript-notices] No se pudieron leer los avisos:', byId.error ?? byStatus.error);
      return { resolved: 0, deleted: 0 };
    }
    const rows = [...(byId.data ?? []), ...(byStatus.data ?? [])] as Array<{ id: string; target_user: string | null; read_by: string[] | null }>;
    let resolved = 0, deleted = 0;
    for (const n of rows) {
      if (n.id.endsWith('_admin')) {
        const { error } = await admin.from('notifications').delete().eq('id', n.id);
        if (!error) deleted++;
        continue;
      }
      const readBy = n.read_by ?? [];
      if (n.target_user !== teacherId || readBy.includes(teacherId)) continue;
      const { error } = await admin.from('notifications').update({ read_by: [...readBy, teacherId] }).eq('id', n.id);
      if (!error) resolved++;
    }
    return { resolved, deleted };
  } catch (err) {
    console.error('[transcript-notices] Error al resolver los avisos:', err);
    return { resolved: 0, deleted: 0 };
  }
}

