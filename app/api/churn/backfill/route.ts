// Recupera las bajas ANTIGUAS que quedaron sin foto de señales.
//
// Hasta ahora la única vía que capturaba el ejemplo etiquetado era el webhook de
// WooCommerce, que en DRC no se usa: las bajas se hacen a mano. Resultado: las
// bajas ya registradas en `student_dropouts` no tienen su fila en
// `churn_snapshots` y el dataset de predicción está vacío.
//
// Esto se puede reconstruir porque al borrar un alumno NO se borra su historial:
// class_records, class_join_logs y class_analyses se conservan (son la base
// contable). Las señales deterministas se recalculan con ese historial.
//
// Se usa `dropped_at` como fecha de referencia: si midiéramos "días desde la
// última clase" contra hoy, cada baja recuperada saldría con el riesgo inflado.
//
//   · GET  → qué bajas están sin foto, sin tocar nada.
//   · POST → captura las que falten (idempotente: salta las que ya tienen foto).

import { supabase } from '@/lib/supabase';
import { captureChurnSnapshot } from '@/lib/churnSnapshot';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface DropoutRow {
  student_id: string | null;
  student_name: string;
  teacher_id: string | null;
  dropped_at: string | null;
}

/** Bajas sin foto. Una por ALUMNO: `student_dropouts` guarda una fila por
 *  profesor afectado, así que un alumno con varios profes aparece repetido. */
async function pendingDropouts(): Promise<{ pending: DropoutRow[]; totalRows: number; error?: string }> {
  const { data: drops, error } = await supabase
    .from('student_dropouts')
    .select('student_id, student_name, teacher_id, dropped_at')
    .order('dropped_at', { ascending: false });
  if (error) {
    console.error('[churn/backfill] Error al leer student_dropouts:', error);
    return { pending: [], totalRows: 0, error: error.message };
  }

  const { data: snaps, error: snapErr } = await supabase
    .from('churn_snapshots')
    .select('student_name')
    .eq('label', 'churned');
  if (snapErr && snapErr.code === 'PGRST205') {
    return { pending: [], totalRows: 0, error: 'Falta correr supabase-churn.sql: no existe la tabla churn_snapshots.' };
  }

  const yaTienen = new Set((snaps ?? []).map(s => (s.student_name ?? '').trim().toLowerCase()));

  const vistos = new Set<string>();
  const pending: DropoutRow[] = [];
  for (const d of (drops ?? []) as DropoutRow[]) {
    const key = (d.student_name ?? '').trim().toLowerCase();
    if (!key || vistos.has(key) || yaTienen.has(key)) continue;
    vistos.add(key);
    pending.push(d);
  }
  return { pending, totalRows: (drops ?? []).length };
}

export async function GET(): Promise<Response> {
  const { pending, totalRows, error } = await pendingDropouts();
  if (error) return Response.json({ error }, { status: 500 });
  return Response.json({
    dropoutRows: totalRows,
    pendingStudents: pending.length,
    students: pending.map(p => ({ name: p.student_name, droppedAt: p.dropped_at })),
  });
}

export async function POST(): Promise<Response> {
  const { pending, error } = await pendingDropouts();
  if (error) return Response.json({ error }, { status: 500 });

  let captured = 0, failed = 0;
  const results: Array<{ student: string; risk: number | null; classes: number | null }> = [];

  for (const d of pending) {
    try {
      const snap = await captureChurnSnapshot({
        studentId:   d.student_id,
        studentName: d.student_name,
        teacherId:   d.teacher_id,
        trigger:     'manual_dropout',
        label:       'churned',
        asOfIso:     d.dropped_at ?? undefined,
      });
      if (snap) {
        captured++;
        results.push({ student: snap.studentName, risk: snap.combinedRisk, classes: snap.signals.classesAnalyzed });
      } else {
        failed++;
        results.push({ student: d.student_name, risk: null, classes: null });
      }
    } catch (e) {
      failed++;
      console.error(`[churn/backfill] Falló la captura de ${d.student_name}:`, e);
      results.push({ student: d.student_name, risk: null, classes: null });
    }
  }

  console.log(`[churn/backfill] ${captured} bajas recuperadas, ${failed} fallidas.`);
  return Response.json({ ok: true, captured, failed, results });
}
