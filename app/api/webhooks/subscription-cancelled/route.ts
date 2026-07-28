// WooCommerce webhook: "Subscription status changed to Cancelada".
// Verifica la firma HMAC, registra el evento en webhook_logs, y si el alumno
// existe lo remueve del sistema (grid + assignments + students) notificando a
// cada profesor afectado. Siempre responde 200 (salvo firma inválida → 401)
// para que WooCommerce no reintente indefinidamente.

import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { dbDeleteStudent } from '@/lib/db';
import { sendCancellationEmail } from '@/lib/notifications-email';
import { captureChurnSnapshot } from '@/lib/churnSnapshot';
import { flagChurnWithOpenAlert } from '@/lib/interventionStore';

export const runtime = 'nodejs';

// HMAC SHA256 (base64) del body crudo, comparado en tiempo constante.
function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  // 1) Body crudo primero (necesario para validar la firma sobre el texto exacto)
  const rawBody   = await req.text();
  const signature = req.headers.get('x-wc-webhook-signature');
  const secret    = process.env.WOOCOMMERCE_WEBHOOK_SECRET;

  // 2) Firma — único caso que NO responde 200
  if (!secret || !verifySignature(rawBody, signature, secret)) {
    return new Response('Invalid signature', { status: 401 });
  }

  const logId = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    let payload: any = null;
    try { payload = JSON.parse(rawBody); } catch { payload = null; }

    // 3) Registrar el evento crudo cuanto antes
    await supabase.from('webhook_logs').insert({
      id:         logId,
      source:     'woocommerce',
      event_type: 'subscription_cancelled',
      payload:    payload ?? { raw: rawBody },
      processed:  false,
    });

    if (!payload) {
      await supabase.from('webhook_logs').update({ processed: true, error: 'invalid JSON payload' }).eq('id', logId);
      return new Response('ok', { status: 200 });
    }

    // 4) Extraer datos del payload de la suscripción
    const email     = String(payload?.billing?.email ?? '').trim();
    const firstName = String(payload?.billing?.first_name ?? '').trim();
    const lastName  = String(payload?.billing?.last_name ?? '').trim();
    const fullName  = `${firstName} ${lastName}`.trim();

    if (!email) {
      await supabase.from('webhook_logs').update({ processed: true, error: 'no billing email in payload' }).eq('id', logId);
      return new Response('ok', { status: 200 });
    }

    // 5) Buscar el alumno por email (case-insensitive)
    const { data: studentRow } = await supabase
      .from('students')
      .select('*')
      .ilike('email', email)
      .limit(1)
      .maybeSingle();

    if (!studentRow) {
      // No está en el sistema — no es un error.
      await supabase.from('webhook_logs').update({ processed: true }).eq('id', logId);
      return new Response('ok', { status: 200 });
    }

    const studentId   = studentRow.id;
    const studentName = studentRow.name;

    // 5.5) PREDICCIÓN DE BAJAS — capturar la "foto" de churn ANTES de borrar al
    //      alumno (para tener el teacher_id de su asignación). Es el ejemplo REAL
    //      etiquetado 'churned' que alimenta el dataset. Best-effort: nunca debe
    //      romper el flujo de la baja.
    try {
      const byId = await supabase.from('assignments').select('teacher_id, teacher_name').eq('student_id', studentId).limit(1).maybeSingle();
      let teacherId: string | null = byId.data?.teacher_id ?? null;
      let teacherName: string | null = byId.data?.teacher_name ?? null;
      if (!teacherId) {
        const byName = await supabase.from('assignments').select('teacher_id, teacher_name').eq('student_name', studentName).limit(1).maybeSingle();
        teacherId = byName.data?.teacher_id ?? null;
        teacherName = byName.data?.teacher_name ?? null;
      }
      await captureChurnSnapshot({
        studentId, studentName, teacherId,
        trigger: 'cancellation', label: 'churned',
      });
      // ¿Se va con una alerta de riesgo pendiente? Marcador + aviso al admin.
      // Va aquí y no en dbDeleteStudent porque el alumno se borra justo después.
      await flagChurnWithOpenAlert({ studentId, studentName, teacherName });
    } catch (e) {
      console.error('[webhook cancelled] No se pudo capturar la foto de churn:', e);
    }

    // 6) Eliminar al alumno en todos lados (grid + assignments + students) y
    //    notificar a cada profesor afectado (createdBy 'sistema').
    void fullName; // disponible por si se requiere en logs
    const affectedTeachers = await dbDeleteStudent(studentId, studentName, 'sistema');

    // 7) Aviso por email a cada profesor afectado (notificationEmail || email).
    //    El envío NO debe romper el flujo: sendCancellationEmail captura errores.
    let emailSent = false;
    console.log(`[EMAIL] Cancelación de ${studentName}: ${affectedTeachers.length} profesor(es) a avisar.`);
    for (const t of affectedTeachers) {
      const to = t.notificationEmail || t.email;
      const ok = await sendCancellationEmail(to, t.name, studentName);
      if (ok) emailSent = true;
    }

    // `email_sent` no existe como columna en webhook_logs: este update fallaba
    // con 42703 y, como supabase-js devuelve el error en vez de lanzarlo y nadie
    // lo miraba, el fallo pasaba inadvertido. Guardamos sólo lo que existe y
    // dejamos el resultado del envío en los logs.
    const { error: logErr } = await supabase
      .from('webhook_logs').update({ processed: true }).eq('id', logId);
    if (logErr) console.error('[webhook cancelled] No se pudo marcar el log:', logErr);
    console.log(`[EMAIL] Cancelación de ${studentName}: algún email enviado = ${emailSent}`);

    return new Response('ok', { status: 200 });
  } catch (err: any) {
    // Loggear el error pero responder 200 igual (evita reintentos infinitos).
    try {
      await supabase
        .from('webhook_logs')
        .update({ processed: false, error: String(err?.message ?? err) })
        .eq('id', logId);
    } catch { /* swallow */ }
    return new Response('ok', { status: 200 });
  }
}
