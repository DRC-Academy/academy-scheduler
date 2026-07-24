// Escaneo de alumnos ACTIVOS para la predicción temprana de bajas.
// Para cada alumno con asignación captura una "foto" (label 'active') y, si el
// riesgo combinado supera el umbral y no se avisó recientemente, notifica al admin
// y al profesor. Pensado para correr por cron (semanal) y también desde el botón
// "Escanear ahora" del panel.
//
// NOTA: la muestra aún no es estadísticamente válida (hacen falta ~100 bajas). El
// umbral es conservador; el valor real de esta fase es RECOPILAR datos.

import { supabase } from '@/lib/supabase';
import { captureChurnSnapshot, markChurnAlerted } from '@/lib/churnSnapshot';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ALERT_THRESHOLD = 65;        // riesgo combinado a partir del cual se avisa
const REALERT_COOLDOWN_DAYS = 21;  // no repetir aviso del mismo alumno antes de esto
const MAX_STUDENTS = 60;           // tope por corrida (coste/tiempo)

export async function POST(request: Request): Promise<Response> {
  // Umbral configurable por query (?threshold=). Útil para pruebas.
  const url = new URL(request.url);
  const threshold = Number(url.searchParams.get('threshold')) || ALERT_THRESHOLD;

  // Alumnos activos = con asignación. Dedupe por nombre.
  const { data: asgns, error } = await supabase
    .from('assignments')
    .select('student_id, student_name, teacher_id, teacher_name');
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const seen = new Set<string>();
  const students = (asgns ?? []).filter(a => {
    const k = (a.student_name ?? '').trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_STUDENTS);

  // Alertas recientes (para no repetir).
  const sinceIso = new Date(Date.now() - REALERT_COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data: recentAlerts } = await supabase
    .from('churn_snapshots').select('student_name, captured_at')
    .eq('alerted', true).gte('captured_at', sinceIso);
  const alertedRecently = new Set((recentAlerts ?? []).map(r => (r.student_name ?? '').trim().toLowerCase()));

  let scanned = 0, alerts = 0;
  const atRisk: Array<{ student: string; risk: number }> = [];

  for (const a of students) {
    const snap = await captureChurnSnapshot({
      studentId: a.student_id, studentName: a.student_name, teacherId: a.teacher_id,
      trigger: 'active_check', label: 'active', aiMode: 'gated',
    });
    if (!snap) continue;
    scanned++;

    if (snap.combinedRisk >= threshold) {
      atRisk.push({ student: snap.studentName, risk: snap.combinedRisk });
      const key = snap.studentName.trim().toLowerCase();
      if (!alertedRecently.has(key)) {
        await notifyChurnRisk(a.teacher_id, a.teacher_name, snap.studentName, snap.combinedRisk, snap.ai?.reasoning ?? null);
        await markChurnAlerted(snap.id);
        alertedRecently.add(key);
        alerts++;
      }
    }
  }

  return Response.json({ ok: true, scanned, alerts, atRisk });
}

// Permite disparar por GET también (algunos crons usan GET).
export async function GET(request: Request): Promise<Response> {
  return POST(request);
}

async function notifyChurnRisk(
  teacherId: string | null, teacherName: string | null, studentName: string, risk: number, reasoning: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const body = `${studentName} muestra señales de posible baja (riesgo ${risk}/100).` +
    `${reasoning ? `\nMotivo: ${reasoning}` : ''}` +
    `\nRecomendación: contactar al alumno antes de que tome la decisión.`;

  // Aviso al admin.
  await supabase.from('notifications').insert({
    id: `notif_churn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target_user: null, target_role: 'admin',
    title: `📉 Riesgo de baja — ${studentName}`,
    body, type: 'churn_risk', read_by: [], created_at: now, created_by: 'sistema',
  });

  // Aviso al profesor (si se conoce).
  if (teacherId) {
    await supabase.from('notifications').insert({
      id: `notif_churn_t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      target_user: teacherId, target_role: null,
      title: `Atención con ${studentName}`,
      body: `${studentName} muestra señales de desenganche. Un contacto cercano o una clase especialmente motivadora pueden ayudar.` +
        `${reasoning ? `\n\n${reasoning}` : ''}`,
      type: 'churn_risk', read_by: [], created_at: now, created_by: 'sistema',
    });
  }
  void teacherName;
}
