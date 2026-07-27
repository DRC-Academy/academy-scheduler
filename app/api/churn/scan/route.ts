// Escaneo de alumnos ACTIVOS para la predicción temprana de bajas.
// Para cada alumno con asignación captura una "foto" (label 'active') y, si el
// riesgo combinado supera el umbral y no se avisó recientemente, notifica al admin
// y al profesor.
//
// POR LOTES CON CURSOR. Antes cortaba en los primeros 60 alumnos sin orden ni
// paginación: con 177 alumnos, escaneaba SIEMPRE a los mismos 60 y los otros 117
// no se miraban nunca, por muchas veces que se pulsara el botón. Ahora:
//   · el orden es estable (por nombre), así el cursor es fiable entre llamadas;
//   · se procesa hasta agotar el presupuesto de tiempo y se devuelve `nextOffset`;
//   · quien llama (el panel o el cron) repite hasta recibir done:true.
//
// NOTA: la muestra aún no es estadísticamente válida (hacen falta ~100 bajas). El
// umbral es conservador; el valor real de esta fase es RECOPILAR datos.

import { supabase } from '@/lib/supabase';
import { captureChurnSnapshot, markChurnAlerted } from '@/lib/churnSnapshot';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ALERT_THRESHOLD = 65;        // riesgo combinado a partir del cual se avisa
const REALERT_COOLDOWN_DAYS = 21;  // no repetir aviso del mismo alumno antes de esto
// Presupuesto por lote. Se corta ANTES del límite de la función para poder
// devolver el cursor en vez de morir a medias (en el plan Hobby el techo son 60 s).
const TIME_BUDGET_MS = 40_000;
const HARD_CAP = 200;              // tope de seguridad por lote

export async function POST(request: Request): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const threshold = Number(url.searchParams.get('threshold')) || ALERT_THRESHOLD;
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  // Alumnos activos = con asignación. Orden ESTABLE por nombre para que el
  // cursor signifique lo mismo en cada llamada.
  const { data: asgns, error } = await supabase
    .from('assignments')
    .select('student_id, student_name, teacher_id, teacher_name, start_date, created_at')
    .order('student_name', { ascending: true });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const seen = new Set<string>();
  const students = (asgns ?? []).filter(a => {
    const k = (a.student_name ?? '').trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const total = students.length;
  const batch = students.slice(offset, offset + HARD_CAP);

  // Alertas recientes (para no repetir).
  const sinceIso = new Date(Date.now() - REALERT_COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data: recentAlerts } = await supabase
    .from('churn_snapshots').select('student_name, captured_at')
    .eq('alerted', true).gte('captured_at', sinceIso);
  const alertedRecently = new Set((recentAlerts ?? []).map(r => (r.student_name ?? '').trim().toLowerCase()));

  let scanned = 0, alerts = 0, index = 0;
  const atRisk: Array<{ student: string; risk: number }> = [];

  for (const a of batch) {
    // Se corta por tiempo, no por número: así el lote se adapta a lo que tarde
    // cada alumno (los que tienen transcripciones pasan por la IA).
    if (index > 0 && Date.now() - started > TIME_BUDGET_MS) break;
    index++;

    const snap = await captureChurnSnapshot({
      studentId: a.student_id, studentName: a.student_name, teacherId: a.teacher_id,
      trigger: 'active_check', label: 'active',
      // Sin filtro: la IA solo cuesta cuando hay transcripciones que leer, y era
      // el filtro (riesgo >= 25) lo que dejaba fuera al alumno puntual que
      // verbaliza en clase que se lo está pensando.
      aiMode: 'always',
      studentSinceIso: a.start_date ?? a.created_at ?? null,
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

  const nextOffset = offset + index;
  const done = nextOffset >= total;
  console.log(`[churn/scan] Lote ${offset}-${nextOffset} de ${total}: ${scanned} fotos, ${alerts} avisos, ${Date.now() - started} ms.`);

  return Response.json({ ok: true, scanned, alerts, atRisk, total, nextOffset, done });
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
    title: `📉 Riesgo de baja · ${studentName}`,
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
