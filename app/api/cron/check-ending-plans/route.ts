// Cron diario: aviso INTERNO al equipo de ventas de los alumnos a los que se les
// termina el plan dentro de 7 días.
//
// Qué alumnos: los que tienen `students.manual_active_until` dentro de la
// ventana. Es el único fin de plan real que existe hoy — WooCommerce no devuelve
// fechas de fin y los intensivos las llevan cargadas a mano. El porqué está en
// lib/endingPlans, que es quien decide QUIÉN entra; acá solo se lee, se manda el
// email y se marca. Si mañana cambia el criterio, cambia allí y este archivo no
// se toca.
//
// ANTI-DUPLICADO. Un aviso por alumno y por CICLO de plan:
//   · se envía solo si `noticeSentForCycle` es false;
//   · al enviar se marcan ending_notice_sent_at = now() y
//     ending_notice_for_date = la fecha de fin de ese ciclo.
// Cuando el alumno renueva y el admin alarga la activación manual, la fecha deja
// de coincidir y vuelve a poder avisarse. Ver supabase-ending-plans.sql.
//
// ORDEN: primero el email, después la marca. Al revés, un fallo de Resend
// dejaría al alumno marcado como avisado sin que nadie hubiera recibido nada, y
// no habría segunda oportunidad: es justo el caso que no se puede recuperar.
// Marcando después, un fallo hace que se reintente mañana.

import { supabase } from '@/lib/supabase';
import {
  buildEndingPlans, plansNeedingNotice, ENDING_NOTICE_DAYS,
  type EndingPlan, type EndingStudentRow, type EndingProfileRow,
} from '@/lib/endingPlans';
import { madridToday } from '@/lib/subscriptionAccess';
import { sendEndingPlansDigest } from '@/lib/emailNotifications';
import {
  sendEndingPlansToZapier, buildEndingPlanPayload, samplePlan,
} from '@/lib/endingPlansWebhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface StudentDbRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  product_type: string | null;
  product_name: string | null;
  plan: string | null;
  manual_active_until: string | null;
  ending_notice_sent_at: string | null;
  ending_notice_for_date: string | null;
}

// `phone` va para el webhook a Zapier → Slack: ventas necesita el número a mano
// para escribirle al alumno sin ir a buscarlo a la ficha.
const STUDENT_COLS =
  'id, name, email, phone, product_type, product_name, plan, manual_active_until, ending_notice_sent_at, ending_notice_for_date';
// Sin las columnas del aviso: si supabase-ending-plans.sql todavía no se corrió,
// pedirlas hace fallar la consulta ENTERA (42703) y el cron no avisaría de nadie.
const STUDENT_COLS_BASE =
  'id, name, email, phone, product_type, product_name, plan, manual_active_until';

export async function GET(request: Request): Promise<Response> {
  // Mismo guardián que el resto de los crons: sin CRON_SECRET configurado no se
  // ejecuta (mejor no hacer nada que quedar abierto a cualquiera).
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[cron ending-plans] Falta CRON_SECRET en el entorno.');
    return Response.json({ error: 'CRON_SECRET no configurado' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const today = madridToday();
  // MODO PRUEBA (?test=1). Dispara SOLO el webhook a Zapier y devuelve el JSON
  // exacto que se envió, para poder verificarlo en Zapier sin esperar al cron de
  // las 22:00. No manda el email interno y NO marca a nadie como avisado, así
  // que se puede repetir las veces que haga falta sin gastar el aviso real.
  const test = new URL(request.url).searchParams.get('test') === '1';

  // 1) Alumnos con fecha de fin. El filtro grueso lo hace la base (no traer 184
  //    filas para descartar 155); la ventana exacta la decide lib/endingPlans.
  // Las dos consultas piden columnas distintas, así que Supabase les infiere
  // tipos distintos: se normalizan a una sola forma para poder reintentar.
  type Res = { data: unknown; error: { code?: string; message: string } | null };
  const read = (cols: string): Promise<Res> =>
    supabase.from('students').select(cols)
      .not('manual_active_until', 'is', null)
      .gte('manual_active_until', today) as unknown as Promise<Res>;

  let migracionPendiente = false;
  let res = await read(STUDENT_COLS);

  if (res.error && (res.error.code === '42703' || res.error.code === 'PGRST204')) {
    console.warn(
      '[cron ending-plans] Faltan las columnas del aviso: corré supabase-ending-plans.sql. ' +
      'Se calcula la lista igual, pero NO se puede marcar lo enviado ni evitar duplicados, así que no se envía nada.',
    );
    migracionPendiente = true;
    res = await read(STUDENT_COLS_BASE);
  }

  if (res.error) {
    console.error('[cron ending-plans] No se pudieron leer los alumnos:', res.error);
    return Response.json({ error: res.error.message }, { status: 500 });
  }

  // 1-bis) Gestión manual de ventas, en consulta APARTE y best-effort. Suelta a
  //   propósito: pegada a la de arriba, un 42703 por faltar
  //   supabase-sales-contact.sql se confundiría con que falta
  //   supabase-ending-plans.sql y el cron dejaría de avisar de TODOS. Sin estas
  //   columnas el aviso sale igual; lo único que se pierde es que Slack diga que
  //   ventas ya llamó a ese alumno.
  const sales = await readSalesContacts(today);

  const rows = (res.data ?? []) as unknown as StudentDbRow[];
  const students: EndingStudentRow[] = rows.map(r => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    productType: (r.product_type as 'subscription' | 'one_time' | null) ?? null,
    productName: r.product_name,
    plan: r.plan,
    manualActiveUntil: r.manual_active_until,
    endingNoticeSentAt: r.ending_notice_sent_at ?? null,
    endingNoticeForDate: r.ending_notice_for_date ?? null,
    ...(sales.get(r.id) ?? {}),
  }));

  // 2) Fichas, solo para el semáforo del email. Best-effort: sin ficha el aviso
  //    sale igual y dice "sin datos", que es la verdad.
  const profiles = await readProfiles();

  // 3) Quién entra en la ventana de aviso y todavía no fue avisado.
  const plans = buildEndingPlans({ students, profiles, today, windowDays: ENDING_NOTICE_DAYS });
  const pendientes = plansNeedingNotice(plans, ENDING_NOTICE_DAYS);

  // 3-bis) PRUEBA: un solo POST a Zapier y se corta acá. Se usa un alumno real de
  // la ventana si lo hay (para ver datos de verdad en Slack) y, si no hay
  // ninguno, uno de ejemplo marcado como [PRUEBA].
  if (test) {
    const plan = pendientes[0] ?? plans[0] ?? samplePlan();
    const payload = buildEndingPlanPayload(plan);
    const envio = await sendEndingPlansToZapier([plan]);
    console.log(`[cron ending-plans] PRUEBA con "${plan.studentName}": ${JSON.stringify(envio)}`);
    return Response.json({
      ok: envio.failed === 0,
      modo: 'prueba',
      aviso: 'No se envió el email interno ni se marcó a nadie como avisado.',
      webhookConfigurado: !envio.skipped,
      alumnoUsado: plan.studentId === 'test' ? 'ejemplo (no hay nadie en la ventana)' : 'real, de la ventana de aviso',
      payloadEnviado: payload,
      resultado: envio,
    });
  }

  if (migracionPendiente) {
    // Sin las columnas no hay anti-duplicado: enviar significaría repetir el
    // mismo aviso cada día hasta que el plan venza. Se informa y se corta.
    return Response.json({
      ok: false,
      migracionPendiente: true,
      mensaje: 'Corré supabase-ending-plans.sql: sin las columnas del aviso no hay anti-duplicado y no se envía nada.',
      habrianEntrado: pendientes.map(p => ({ alumno: p.studentName, dias: p.daysLeft })),
    });
  }

  if (pendientes.length === 0) {
    console.log(`[cron ending-plans] ${today}: ningún alumno nuevo en la ventana de ${ENDING_NOTICE_DAYS} días.`);
    return Response.json({ ok: true, today, enVentana: plans.length, avisados: 0 });
  }

  // 4) UN email con todos. Solo si Resend lo acepta se marca lo enviado.
  const enviado = await sendEndingPlansDigest(pendientes);
  if (!enviado) {
    console.error('[cron ending-plans] El email no salió; no se marca nada y se reintentará mañana.');
    return Response.json(
      { ok: false, error: 'No se pudo enviar el aviso', pendientes: pendientes.length },
      { status: 502 },
    );
  }

  const marcados = await markNotified(pendientes);

  // 5) Webhook a Zapier → Slack. Va AL FINAL y es aditivo: el email interno ya
  //    salió y el ciclo ya está marcado, así que nada de lo que pase acá puede
  //    afectar al aviso, que es el canal crítico. `sendEndingPlansToZapier` no
  //    lanza nunca; sin la variable de entorno configurada devuelve `skipped`.
  const zapier = await sendEndingPlansToZapier(pendientes);

  console.log(
    `[cron ending-plans] ${today}: avisado de ${pendientes.length} alumno(s) ` +
    `(${pendientes.map(p => `${p.studentName} en ${p.daysLeft}d`).join(', ')}). Marcados: ${marcados}. ` +
    `Zapier: ${zapier.skipped ? 'sin configurar' : `${zapier.sent} enviados, ${zapier.failed} fallidos`}.`,
  );

  return Response.json({
    ok: true,
    today,
    enVentana: plans.length,
    avisados: pendientes.length,
    marcados,
    zapier,
    alumnos: pendientes.map(p => ({ alumno: p.studentName, dias: p.daysLeft, fin: p.endDate })),
  });
}

type SalesFields = Pick<EndingStudentRow,
  'salesContactedAt' | 'salesContactResult' | 'salesContactedBy' | 'salesContactForDate'>;

/**
 * Gestión de ventas por alumno, para que el webhook a Slack pueda decir "a éste
 * ya lo llamaron". NUNCA rompe el cron: si las columnas no existen todavía
 * (supabase-sales-contact.sql sin correr) devuelve un mapa vacío y el aviso sale
 * igual. Este dato es una comodidad, el email es lo crítico.
 */
async function readSalesContacts(today: string): Promise<Map<string, SalesFields>> {
  const { data, error } = await supabase
    .from('students')
    .select('id, sales_contacted_at, sales_contact_result, sales_contacted_by, sales_contact_for_date')
    .not('manual_active_until', 'is', null)
    .gte('manual_active_until', today);

  if (error) {
    console.warn(
      '[cron ending-plans] Sin datos de gestión de ventas (¿falta correr supabase-sales-contact.sql?):',
      error.message,
    );
    return new Map();
  }

  const out = new Map<string, SalesFields>();
  for (const r of (data ?? []) as unknown as Array<Record<string, string | null>>) {
    if (!r.id) continue;
    out.set(r.id, {
      salesContactedAt:    r.sales_contacted_at ?? null,
      salesContactResult:  r.sales_contact_result ?? null,
      salesContactedBy:    r.sales_contacted_by ?? null,
      salesContactForDate: r.sales_contact_for_date ?? null,
    });
  }
  return out;
}

/**
 * Fichas para el semáforo (progreso y riesgo). Se traen TODAS y no solo las de
 * los ids en juego: lib/endingPlans empareja por student_id y, como respaldo,
 * por nombre normalizado — filtrar por id perdería justo las fichas que solo
 * casan por nombre, que son las que ese respaldo existe para recuperar. Son 90
 * filas de cuatro columnas. Nunca rompe el cron.
 */
async function readProfiles(): Promise<EndingProfileRow[]> {
  const { data, error } = await supabase
    .from('student_profiles')
    .select('student_id, student_name, progress_score, risk_signal');
  if (error) {
    console.error('[cron ending-plans] No se pudieron leer las fichas (se sigue sin semáforo):', error);
    return [];
  }
  return (data ?? []) as unknown as EndingProfileRow[];
}

/**
 * Marca el aviso como enviado para ESE ciclo. Uno por uno y no en lote porque
 * cada alumno lleva su propia `ending_notice_for_date`, que es la que hace que
 * el aviso se reactive al renovar.
 */
async function markNotified(plans: EndingPlan[]): Promise<number> {
  const now = new Date().toISOString();
  let ok = 0;
  for (const p of plans) {
    const { error } = await supabase.from('students').update({
      ending_notice_sent_at: now,
      ending_notice_for_date: p.endDate,
    }).eq('id', p.studentId);
    if (error) {
      // El email YA salió: no se puede deshacer. Se deja constancia para que, si
      // mañana se repite el aviso de este alumno, se sepa por qué.
      console.error(`[cron ending-plans] Aviso enviado pero NO marcado para ${p.studentName} (${p.studentId}):`, error);
    } else {
      ok++;
    }
  }
  return ok;
}
