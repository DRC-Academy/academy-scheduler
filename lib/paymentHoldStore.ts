// ── Pago pendiente: SERVIDOR (episodios, barrido y avisos) ─────────────────────
//
// Las reglas puras viven en lib/paymentHolds. Esto es lo que toca base, Woo y
// email. Cliente ADMIN obligatorio (service role): `payment_hold_notices` no
// tiene políticas de RLS y nadie más puede escribir los episodios.
//
// UNA SOLA REGLA DE ESTADO. Ni el webhook, ni el barrido, ni la verificación
// deciden por su cuenta si el alumno está en on-hold: todos preguntan a
// /api/check-subscription (en el mismo proceso), que aplica la regla única de
// lib/subscriptionAccess (Oritalk, activación manual, otras suscripciones, la
// Pausa…). El contenido del webhook solo dice A QUIÉN mirar.
//
// QUIÉN LO LLAMA
//   · /api/webhooks/subscription-status  — WooCommerce, en el momento.
//   · /api/check-subscription            — al verificar un alumno (after()).
//   · /api/cron/ausencias                — barrido cada 5 min (pg_cron) y envíos.
//   · /api/cron/check-ending-plans       — respaldo diario (noches y domingos).
//
// SIN DUPLICADOS. Un episodio abierto por alumno (índice único parcial) y un
// aviso por episodio + profesor + tipo (id fijo, ver noticeIdOf). El envío se
// "reclama" con un update condicionado a `attempts`, así que dos procesos a la
// vez (webhook y barrido) no mandan el mismo email dos veces.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  holdFromRow, holdActionFor, holdIdOf, isInitialHold, holdStartFromWoo, suspendedNoticeDue,
  noticeIdOf, bellIdOf, shouldNotifyTeacher, suspendedCopy, reactivatedCopy,
  NOTICE_MAX_ATTEMPTS, REACTIVATION_LOOKBACK_DAYS,
  type PaymentHold, type NoticeKind, type WooNote, type WooRelatedOrder,
} from '@/lib/paymentHolds';
import { isAccessStatus, isPaymentHoldStatus } from '@/lib/subscriptionAccess';
import { sendPaymentHoldEmail, sendPaymentResumedEmail, destinationFor } from '@/lib/emailNotifications';

type Db = SupabaseClient;
type Row = Record<string, unknown>;

/** Desde dónde se abrió o cerró un episodio (columna start_source / end_source). */
export type HoldSource = 'webhook' | 'barrido' | 'verificacion';

const nk = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const HOLD_COLS = 'id, student_id, student_email, student_name, started_at, ended_at, is_initial, end_status';

// ── Lectura ───────────────────────────────────────────────────────────────────

/**
 * Todos los episodios (tabla pequeña). Ante un error, vacío: sin episodios todo
 * funciona como antes de que existieran (nada se bloquea por un fallo de base).
 */
export async function readPaymentHolds(db: Db): Promise<PaymentHold[]> {
  const { data, error } = await db.from('student_payment_holds').select(HOLD_COLS)
    .order('started_at', { ascending: false }).limit(2000);
  if (error) {
    console.error('[pago pendiente] No se pudieron leer los episodios:', error.message);
    return [];
  }
  return (data ?? []).map(r => holdFromRow(r as Row));
}

async function openHoldOf(db: Db, studentId: string): Promise<PaymentHold | null> {
  const { data, error } = await db.from('student_payment_holds').select(HOLD_COLS)
    .eq('student_id', studentId).is('ended_at', null).limit(1).maybeSingle();
  if (error) throw new Error(`No se pudo leer el episodio abierto: ${error.message}`);
  return data ? holdFromRow(data as Row) : null;
}

/** ¿La tabla está vacía? Es el primer arranque: lo que se encuentre ya estaba de antes. */
async function isFirstRun(db: Db): Promise<boolean> {
  const { count, error } = await db.from('student_payment_holds').select('id', { count: 'exact', head: true });
  return !error && (count ?? 0) === 0;
}

interface StudentLite { id: string; name: string; email: string; isTest: boolean }

async function studentByEmail(db: Db, email: string): Promise<StudentLite | null> {
  const { data } = await db.from('students').select('id, name, email, is_test').ilike('email', email).limit(1).maybeSingle();
  if (!data) return null;
  const r = data as Row;
  return { id: String(r.id), name: String(r.name ?? ''), email: String(r.email ?? email), isTest: r.is_test === true };
}

// ── Estado resuelto (la regla única) ──────────────────────────────────────────

export interface ResolvedStatus { active: boolean | null; status: string }

/**
 * El estado del alumno según /api/check-subscription, en el mismo proceso y sin
 * su caché de 5 minutos (`fresh=1`). `sync=0` evita que la ruta, a su vez,
 * vuelva a llamar a la sincronización.
 */
export async function resolveStudentStatus(email: string): Promise<ResolvedStatus> {
  try {
    const { GET } = await import('@/app/api/check-subscription/route');
    const res = await GET(new Request(`http://gestion.local/api/check-subscription?email=${encodeURIComponent(email)}&fresh=1&sync=0`));
    const j = (await res.json()) as Row;
    return {
      active: typeof j.active === 'boolean' ? j.active : null,
      status: typeof j.status === 'string' ? j.status : 'error',
    };
  } catch (err) {
    console.error('[pago pendiente] No se pudo verificar la suscripción:', err);
    return { active: null, status: 'error' };
  }
}

// ── WooCommerce: inicio real del episodio y lista de on-hold ─────────────────

function wcCreds(): { base: string; ck: string; cs: string } | null {
  const base = process.env.WOOCOMMERCE_URL;
  const ck = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return null;
  return { base: base.replace(/\/$/, ''), ck, cs };
}

/** GET a la API de Woo. Devuelve el JSON, o null ante cualquier fallo (best-effort). */
async function wooGet(path: string): Promise<{ data: unknown; totalPages: number } | null> {
  const c = wcCreds();
  if (!c) return null;
  const sep = path.includes('?') ? '&' : '?';
  const url = `${c.base}/wp-json/wc/v3/${path}${sep}consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) return null;
    return { data: await res.json(), totalPages: Number(res.headers.get('x-wp-totalpages') ?? '1') || 1 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inicio real del episodio según WooCommerce: la nota del cambio de estado a
 * "En espera" o, si no, el pedido de renovación fallido más reciente. null si
 * Woo no lo dice (o no contesta): entonces vale el momento en que lo vimos.
 */
async function wooHoldStart(email: string, nowMs: number): Promise<{ ms: number; source: 'nota' | 'pedido'; subscriptionId: number | null } | null> {
  const subs = await wooGet(`subscriptions?search=${encodeURIComponent(email)}&status=on-hold&per_page=10&_fields=id,status`);
  const list = Array.isArray(subs?.data) ? subs!.data as Row[] : [];
  const sub = list.find(s => s.status === 'on-hold');
  const id = sub ? Number(sub.id) : NaN;
  if (!Number.isFinite(id)) return null;
  const [notes, orders] = await Promise.all([
    wooGet(`subscriptions/${id}/notes?per_page=100`),
    wooGet(`subscriptions/${id}/orders?per_page=20&_fields=id,status,date_created,date_created_gmt`),
  ]);
  const start = holdStartFromWoo({
    notes: Array.isArray(notes?.data) ? notes!.data as WooNote[] : [],
    orders: Array.isArray(orders?.data) ? orders!.data as WooRelatedOrder[] : [],
    nowMs,
  });
  return start ? { ...start, subscriptionId: id } : { ms: NaN, source: 'nota', subscriptionId: id };
}

/** Emails de las suscripciones en on-hold según Woo (una pasada paginada, solo id/estado/email). */
async function wooOnHoldEmails(): Promise<{ emails: string[]; ok: boolean }> {
  if (!wcCreds()) return { emails: [], ok: false };
  const out = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const r = await wooGet(`subscriptions?status=on-hold&per_page=100&page=${page}&orderby=id&order=asc&_fields=${encodeURIComponent('id,status,billing.email')}`);
    if (!r) return { emails: [...out], ok: false };
    const rows = Array.isArray(r.data) ? r.data as Row[] : [];
    for (const s of rows) {
      const e = nk((s.billing as Row | undefined)?.email);
      if (e && s.status === 'on-hold') out.add(e);
    }
    if (page >= r.totalPages || rows.length < 100) break;
  }
  return { emails: [...out], ok: true };
}

// ── Sincronizar un alumno ─────────────────────────────────────────────────────

export interface SyncResult {
  email: string;
  accion: 'abierto' | 'cerrado' | 'nada' | 'sin_alumno' | 'error';
  status?: string;
  holdId?: string;
  studentId?: string;
  detalle?: string;
}

/**
 * Pone el episodio del alumno al día con su estado RESUELTO: abre uno si está en
 * on-hold y no lo tenía, lo cierra si salió. `resolved` evita volver a preguntar
 * cuando quien llama ya lo sabe (la propia ruta de verificación).
 */
export async function syncStudentHold(db: Db, email: string, source: HoldSource, opts: {
  nowMs?: number; resolved?: ResolvedStatus; firstRun?: boolean;
} = {}): Promise<SyncResult> {
  const e = nk(email);
  if (!e) return { email: e, accion: 'sin_alumno' };
  const nowMs = opts.nowMs ?? Date.now();
  try {
    const st = await studentByEmail(db, e);
    if (!st) return { email: e, accion: 'sin_alumno' };
    const resolved = opts.resolved ?? await resolveStudentStatus(e);
    const open = await openHoldOf(db, st.id);
    const action = holdActionFor({ status: resolved.status, active: resolved.active, hasOpenHold: !!open });

    if (action === 'abrir') {
      const woo = await wooHoldStart(e, nowMs);
      const known = woo && Number.isFinite(woo.ms);
      const startMs = known ? woo!.ms : nowMs;
      const firstRun = opts.firstRun ?? await isFirstRun(db);
      const initial = firstRun || isInitialHold(startMs);
      const startSource = initial
        ? (known ? (woo!.source === 'nota' ? 'inicial_nota' : 'inicial_pedido') : 'inicial_hoy')
        : source;
      const id = holdIdOf(st.id, startMs);
      const { error } = await db.from('student_payment_holds').insert({
        id, student_id: st.id, student_email: st.email.trim().toLowerCase(), student_name: st.name,
        started_at: new Date(startMs).toISOString(), start_source: startSource,
        woo_subscription_id: woo?.subscriptionId ?? null, is_initial: initial,
      });
      // 23505: otro proceso lo abrió a la vez (índice único de abiertos). No es un error.
      if (error && error.code !== '23505') throw new Error(`No se pudo abrir el episodio: ${error.message}`);
      return { email: e, accion: error ? 'nada' : 'abierto', status: resolved.status, holdId: id, studentId: st.id };
    }

    if (action === 'cerrar' && open) {
      const { error } = await db.from('student_payment_holds')
        .update({ ended_at: new Date(nowMs).toISOString(), end_source: source, end_status: resolved.status })
        .eq('id', open.id).is('ended_at', null);
      if (error) throw new Error(`No se pudo cerrar el episodio: ${error.message}`);
      return { email: e, accion: 'cerrado', status: resolved.status, holdId: open.id, studentId: st.id };
    }

    return { email: e, accion: 'nada', status: resolved.status, holdId: open?.id, studentId: st.id };
  } catch (err) {
    console.error(`[pago pendiente] Sincronización de ${e} fallida:`, err);
    return { email: e, accion: 'error', detalle: err instanceof Error ? err.message : String(err) };
  }
}

// ── Corrección sobre la marcha desde /api/check-subscription ─────────────────

/**
 * Emails con episodio abierto, cacheados 60 s por instancia. Así la verificación
 * de 200 alumnos del panel no hace 200 consultas: solo se sincroniza cuando el
 * estado y la tabla no cuadran.
 */
let openEmailsCache: { at: number; emails: Set<string> } | null = null;
const OPEN_CACHE_MS = 60_000;

async function openHoldEmails(db: Db): Promise<Set<string>> {
  if (openEmailsCache && Date.now() - openEmailsCache.at < OPEN_CACHE_MS) return openEmailsCache.emails;
  const { data, error } = await db.from('student_payment_holds').select('student_email').is('ended_at', null).limit(1000);
  if (error) throw new Error(error.message);
  const emails = new Set((data ?? []).map(r => nk((r as Row).student_email)));
  openEmailsCache = { at: Date.now(), emails };
  return emails;
}

/** Tras verificar a un alumno: si el estado y la tabla no cuadran, se sincroniza. */
export async function reconcileFromCheck(db: Db, email: string, resolved: ResolvedStatus): Promise<void> {
  const e = nk(email);
  if (!e || resolved.active === null || resolved.status === 'error') return;
  try {
    const abiertos = await openHoldEmails(db);
    const onHold = isPaymentHoldStatus(resolved.status);
    if (onHold === abiertos.has(e)) return;
    const r = await syncStudentHold(db, e, 'verificacion', { resolved });
    if (r.accion === 'abierto' || r.accion === 'cerrado') {
      openEmailsCache = null;
      // La reactivación sale en el acto; el "suspendido" espera a su barrido.
      if (r.accion === 'cerrado' && r.studentId) await processHoldNotices(db, Date.now(), { studentId: r.studentId });
    }
  } catch (err) {
    console.error('[pago pendiente] Corrección desde la verificación fallida:', err);
  }
}

// ── Avisos (email + campanita) ────────────────────────────────────────────────

interface TeacherLite { id: string; name: string; email: string; notificationEmail: string; isTest: boolean }
interface AssignmentLite { id: string; teacherId: string; studentId: string; studentName: string; studentEmail: string }

async function activeAssignments(db: Db): Promise<AssignmentLite[]> {
  const { data, error } = await db.from('assignments')
    .select('id, teacher_id, student_id, student_name, student_email').eq('status', 'active').limit(5000);
  if (error) throw new Error(`No se pudieron leer las asignaciones: ${error.message}`);
  return (data ?? []).map(r => {
    const x = r as Row;
    return { id: String(x.id), teacherId: String(x.teacher_id ?? ''), studentId: String(x.student_id ?? ''), studentName: String(x.student_name ?? ''), studentEmail: String(x.student_email ?? '') };
  });
}

async function teachersById(db: Db): Promise<Map<string, TeacherLite & { archived: boolean }>> {
  const { data, error } = await db.from('teachers').select('*').limit(1000);
  if (error) throw new Error(`No se pudieron leer los profesores: ${error.message}`);
  return new Map((data ?? []).map(r => {
    const x = r as Row;
    return [String(x.id), {
      id: String(x.id), name: String(x.name ?? '').trim(), email: String(x.email ?? ''),
      notificationEmail: String(x.notification_email ?? ''), isTest: x.is_test === true, archived: !!x.archived_at,
    }];
  }));
}

/** Profesores con asignación ACTIVA de ese alumno (por id, email o nombre), sin repetir. */
function teachersOfHold(h: PaymentHold, asgs: AssignmentLite[]): Array<{ teacherId: string; assignmentId: string }> {
  const seen = new Map<string, string>();
  for (const a of asgs) {
    const match = (h.studentId && a.studentId === h.studentId)
      || (nk(h.studentEmail) && nk(a.studentEmail) === nk(h.studentEmail))
      || (nk(h.studentName) && nk(a.studentName) === nk(h.studentName));
    if (match && a.teacherId && !seen.has(a.teacherId)) seen.set(a.teacherId, a.id);
  }
  return [...seen.entries()].map(([teacherId, assignmentId]) => ({ teacherId, assignmentId }));
}

export interface NoticeReport { enviados: number; fallidos: number; omitidos: number; detalle: string[] }

/**
 * Envía UN aviso (campanita + email). Idempotente: la fila se crea una vez con
 * su id fijo y el envío se reclama con un update condicionado, así que ni un
 * webhook repetido ni dos procesos a la vez lo duplican.
 */
async function deliver(db: Db, h: PaymentHold, t: TeacherLite, assignmentId: string, kind: NoticeKind, notify: boolean, rep: NoticeReport): Promise<void> {
  const id = noticeIdOf(h.id, t.id, kind);
  const base = {
    id, hold_id: h.id, student_id: h.studentId, student_name: h.studentName,
    teacher_id: t.id, teacher_name: t.name, assignment_id: assignmentId, kind,
  };

  if (!notify) {
    const { error } = await db.from('payment_hold_notices').insert({ ...base, email_status: 'omitido', email_error: 'cuenta de prueba' });
    if (!error) { rep.omitidos++; rep.detalle.push(`${kind} ${h.studentName} → ${t.name}: omitido (cuenta de prueba)`); }
    return;
  }

  // 1) La fila (si ya existe, se mira en qué quedó).
  const ins = await db.from('payment_hold_notices').insert({ ...base, email_status: 'pendiente', attempts: 0 });
  if (ins.error && ins.error.code !== '23505') throw new Error(`No se pudo guardar el aviso: ${ins.error.message}`);
  const { data: cur } = await db.from('payment_hold_notices').select('email_status, attempts').eq('id', id).maybeSingle();
  const status = String((cur as Row | null)?.email_status ?? '');
  const attempts = Number((cur as Row | null)?.attempts ?? 0);
  if (status === 'enviado' || status === 'omitido' || attempts >= NOTICE_MAX_ATTEMPTS) return;

  // 2) Reclamar el envío: solo uno gana el update condicionado.
  const claim = await db.from('payment_hold_notices').update({ attempts: attempts + 1 })
    .eq('id', id).eq('attempts', attempts).in('email_status', ['pendiente', 'fallido']).select('id');
  if (claim.error || !claim.data?.length) return;

  // 3) Campanita (id fijo: un reintento no la repite).
  const copy = kind === 'suspendido' ? suspendedCopy(h.studentName) : reactivatedCopy(h.studentName);
  const bellId = bellIdOf(h.id, t.id, kind);
  const bell = await db.from('notifications').upsert({
    id: bellId, target_user: t.id, target_role: null, title: copy.title, body: copy.body,
    type: kind === 'suspendido' ? 'payment_hold' : 'payment_resumed',
    read_by: [], created_at: new Date().toISOString(), created_by: 'sistema',
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (bell.error) console.error('[pago pendiente] No se pudo crear la campanita:', bell.error.message);

  // 4) Email.
  const teacher = { name: t.name, email: t.email, notificationEmail: t.notificationEmail };
  const ok = kind === 'suspendido'
    ? await sendPaymentHoldEmail(teacher, h.studentName)
    : await sendPaymentResumedEmail(teacher, h.studentName);
  await db.from('payment_hold_notices').update({
    email_status: ok ? 'enviado' : 'fallido',
    email_error: ok ? null : 'Resend no aceptó el envío (ver logs de Vercel)',
    sent_to: destinationFor(teacher) || null,
    sent_at: new Date().toISOString(),
    bell_id: bell.error ? null : bellId,
  }).eq('id', id);
  if (ok) rep.enviados++; else rep.fallidos++;
  rep.detalle.push(`${kind} ${h.studentName} → ${t.name}: ${ok ? 'enviado' : 'fallido'}`);
}

/**
 * Envía los avisos que tocan:
 *   · "suspendido": episodios abiertos, no iniciales, con la espera cumplida;
 *     a cada profesor con asignación activa del alumno.
 *   · "reactivado": episodios cerrados hace poco con un estado que da acceso,
 *     SOLO a los profesores a los que se les avisó del "suspendido".
 * `studentId` limita la pasada a un alumno (webhook / verificación).
 */
export async function processHoldNotices(db: Db, nowMs: number, filter: { studentId?: string } = {}): Promise<NoticeReport> {
  const rep: NoticeReport = { enviados: 0, fallidos: 0, omitidos: 0, detalle: [] };
  const desde = new Date(nowMs - REACTIVATION_LOOKBACK_DAYS * 86_400_000).toISOString();
  let q = db.from('student_payment_holds').select(HOLD_COLS).eq('is_initial', false)
    .or(`ended_at.is.null,ended_at.gte.${desde}`).limit(500);
  if (filter.studentId) q = q.eq('student_id', filter.studentId);
  const { data, error } = await q;
  if (error) throw new Error(`No se pudieron leer los episodios: ${error.message}`);
  const holds = (data ?? []).map(r => holdFromRow(r as Row));
  if (!holds.length) return rep;

  const dueSuspended = holds.filter(h => suspendedNoticeDue(h, nowMs));
  const closed = holds.filter(h => h.endedAt && isAccessStatus(h.endStatus));
  if (!dueSuspended.length && !closed.length) return rep;

  const [asgs, teachers] = await Promise.all([activeAssignments(db), teachersById(db)]);
  const studentIds = [...new Set(holds.map(h => h.studentId))];
  const { data: studs } = await db.from('students').select('id, is_test').in('id', studentIds);
  const studentTest = new Map((studs ?? []).map(r => [String((r as Row).id), (r as Row).is_test === true]));

  for (const h of dueSuspended) {
    for (const { teacherId, assignmentId } of teachersOfHold(h, asgs)) {
      const t = teachers.get(teacherId);
      if (!t || t.archived) continue;
      const notify = shouldNotifyTeacher({ teacherId, teacherIsTest: t.isTest, studentIsTest: studentTest.get(h.studentId) });
      try { await deliver(db, h, t, assignmentId, 'suspendido', notify, rep); }
      catch (err) { rep.detalle.push(`suspendido ${h.studentName} → ${t.name}: ERROR ${err instanceof Error ? err.message : err}`); }
    }
  }

  if (closed.length) {
    const { data: prev } = await db.from('payment_hold_notices').select('hold_id, teacher_id, assignment_id, email_status')
      .in('hold_id', closed.map(h => h.id)).eq('kind', 'suspendido').neq('email_status', 'omitido');
    for (const h of closed) {
      for (const n of (prev ?? []).filter(r => (r as Row).hold_id === h.id) as Row[]) {
        const t = teachers.get(String(n.teacher_id));
        if (!t) continue;
        try { await deliver(db, h, t, String(n.assignment_id ?? ''), 'reactivado', true, rep); }
        catch (err) { rep.detalle.push(`reactivado ${h.studentName} → ${t.name}: ERROR ${err instanceof Error ? err.message : err}`); }
      }
    }
  }
  return rep;
}

// ── Barrido ───────────────────────────────────────────────────────────────────

export interface SweepReport {
  wooConsultado: boolean;
  enEsperaEnWoo: number;
  revisados: number;
  abiertos: string[];
  cerrados: string[];
  errores: string[];
  avisos: NoticeReport;
}

/**
 * Pone al día TODOS los episodios: los alumnos que Woo da en on-hold y los que
 * tienen un episodio abierto (por si salieron sin que llegara el webhook).
 * Después, los avisos. Nunca lanza: devuelve el informe con los errores.
 */
export async function sweepPaymentHolds(db: Db, nowMs = Date.now(), opts: {
  /** Tiempo máximo: el reloj de ausencias corre detrás y tiene su propio límite. */
  budgetMs?: number;
} = {}): Promise<SweepReport> {
  const limite = Date.now() + (opts.budgetMs ?? 45_000);
  const rep: SweepReport = { wooConsultado: false, enEsperaEnWoo: 0, revisados: 0, abiertos: [], cerrados: [], errores: [], avisos: { enviados: 0, fallidos: 0, omitidos: 0, detalle: [] } };
  try {
    const holds = await readPaymentHolds(db);
    const firstRun = holds.length === 0;
    const woo = await wooOnHoldEmails();
    rep.wooConsultado = woo.ok;
    rep.enEsperaEnWoo = woo.emails.length;
    if (!woo.ok) rep.errores.push('WooCommerce no respondió (o no está configurado): solo se revisan los episodios abiertos.');

    const emails = new Set<string>(woo.emails);
    for (const h of holds) if (!h.endedAt) emails.add(nk(h.studentEmail));

    // De a 3: la API de Woo de esta instalación no es rápida.
    const list = [...emails].filter(Boolean);
    for (let i = 0; i < list.length; i += 3) {
      if (Date.now() > limite) { rep.errores.push(`Tiempo agotado: quedaron ${list.length - i} alumno(s) para la vuelta siguiente.`); break; }
      const res = await Promise.all(list.slice(i, i + 3).map(e => syncStudentHold(db, e, 'barrido', { nowMs, firstRun })));
      for (const r of res) {
        if (r.accion === 'sin_alumno') continue;
        rep.revisados++;
        if (r.accion === 'abierto') rep.abiertos.push(r.email);
        if (r.accion === 'cerrado') rep.cerrados.push(r.email);
        if (r.accion === 'error') rep.errores.push(`${r.email}: ${r.detalle}`);
      }
    }
    openEmailsCache = null;
    rep.avisos = await processHoldNotices(db, nowMs);
  } catch (err) {
    rep.errores.push(err instanceof Error ? err.message : String(err));
  }
  return rep;
}

// ── Ingreso a clase ───────────────────────────────────────────────────────────

/**
 * ¿La clase que se quiere registrar cae dentro de un episodio de pago pendiente?
 * Se identifica al alumno por la asignación de ESE profesor (id y email) y por el
 * nombre. Ante un fallo de lectura, false: el ingreso decide el pago y no se
 * rechaza por una avería nuestra.
 */
export async function classJoinBlockedByHold(db: Db, input: { teacherId: string; studentName: string; scheduledDate: string; scheduledTime: string }): Promise<boolean> {
  try {
    const { isClassOnHold, holdSpansFor } = await import('@/lib/paymentHolds');
    const holds = await readPaymentHolds(db);
    if (!holds.length) return false;
    const { data } = await db.from('assignments').select('student_id, student_email, student_name')
      .eq('teacher_id', input.teacherId).ilike('student_name', input.studentName.trim()).limit(5);
    const refs = [{ studentName: input.studentName }, ...((data ?? []) as Row[]).map(a => ({
      studentId: String(a.student_id ?? ''), studentEmail: String(a.student_email ?? ''), studentName: String(a.student_name ?? ''),
    }))];
    return refs.some(ref => isClassOnHold(holdSpansFor(holds, ref), input.scheduledDate, input.scheduledTime));
  } catch (err) {
    console.error('[pago pendiente] No se pudo comprobar el ingreso:', err);
    return false;
  }
}
