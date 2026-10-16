// ── Datos de pago de los profesores: la base (SOLO SERVIDOR) ──────────────────
//
// teacher_payment_details tiene RLS sin políticas (supabase-teacher-payment-
// details.sql): solo la toca la service role. Lo usan /api/payment-details (el
// profesor, sus propios datos) y /api/admin/payment-details (todos).
//
// Nada de esto entra en TeachersContext ni en ninguna carga general: se pide
// solo al abrir Finanzas del profesor o la vista "Datos de pago" del admin.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validatePaymentDetails, type PaymentDetailsErrors } from '@/lib/iban';
import type { PaymentDetails, TeacherPaymentRow } from '@/lib/paymentDetails';

const TABLE = 'teacher_payment_details';

/** La tabla todavía no existe: falta correr el SQL. */
export class MissingPaymentTableError extends Error {}

function isMissingTable(e: { code?: string; message?: string } | null): boolean {
  return !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message ?? ''));
}

function check(e: { code?: string; message?: string } | null): void {
  if (!e) return;
  if (isMissingTable(e)) throw new MissingPaymentTableError(e.message);
  throw new Error(e.message ?? 'Error de base de datos');
}

type Row = { teacher_id: string; iban: string; recipient_name: string; created_at: string; updated_at: string };

function mapRow(r: Row): PaymentDetails {
  return { iban: r.iban, recipientName: r.recipient_name, createdAt: r.created_at, updatedAt: r.updated_at };
}

export async function getPaymentDetails(admin: SupabaseClient, teacherId: string): Promise<PaymentDetails | null> {
  const { data, error } = await admin.from(TABLE).select('*').eq('teacher_id', teacherId).maybeSingle();
  check(error);
  return data ? mapRow(data as Row) : null;
}

/**
 * Todos los profesores NO archivados, con sus datos o `null`. Ordenados: primero
 * los que faltan (es a quien hay que perseguir), después por nombre.
 */
export async function listPaymentDetailsForAdmin(admin: SupabaseClient): Promise<TeacherPaymentRow[]> {
  // archived_at puede no existir si no se corrió supabase-teacher-archive.sql:
  // en ese caso se pide sin la columna (como hace lib/db al cargar profesores).
  let teachersRes = await admin.from('teachers').select('id, name, archived_at');
  if (teachersRes.error && /archived_at/.test(teachersRes.error.message ?? '')) {
    teachersRes = await admin.from('teachers').select('id, name') as typeof teachersRes;
  }
  if (teachersRes.error) throw new Error(teachersRes.error.message);

  const { data, error } = await admin.from(TABLE).select('*');
  check(error);
  const byTeacher = new Map((data as Row[] ?? []).map(r => [r.teacher_id, mapRow(r)]));

  return (teachersRes.data ?? [])
    .filter(t => !(t as { archived_at?: string | null }).archived_at)
    .map(t => ({ teacherId: t.id as string, teacherName: (t.name as string) ?? t.id, details: byTeacher.get(t.id as string) ?? null }))
    .sort((a, b) => Number(!!a.details) - Number(!!b.details) || a.teacherName.localeCompare(b.teacherName, 'es'));
}

export type SaveResult =
  | { ok: true; details: PaymentDetails }
  | { ok: false; status: number; error: string; fieldErrors?: PaymentDetailsErrors };

/**
 * Valida (otra vez: no se fía del navegador), normaliza y guarda. Una fila por
 * profesor: el upsert por teacher_id deja `created_at` como estaba y renueva
 * `updated_at`.
 */
export async function savePaymentDetails(
  admin: SupabaseClient,
  teacherId: string,
  input: { iban: string; recipientName: string },
): Promise<SaveResult> {
  const v = validatePaymentDetails(input);
  if (!v.ok) return { ok: false, status: 400, error: 'Revisa los datos marcados.', fieldErrors: v.errors };

  const { data, error } = await admin.from(TABLE)
    .upsert(
      { teacher_id: teacherId, iban: v.iban, recipient_name: v.recipientName, updated_at: new Date().toISOString() },
      { onConflict: 'teacher_id' },
    )
    .select('*')
    .single();
  if (error?.code === '23503') return { ok: false, status: 404, error: 'Ese profesor no existe.' };
  check(error);
  return { ok: true, details: mapRow(data as Row) };
}

/** Lee el cuerpo de un PUT: `{ teacherId, iban, recipientName }`, todo texto. */
export async function readPaymentBody(request: Request): Promise<{ teacherId: string; iban: string; recipientName: string } | null> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return { teacherId: str(body.teacherId).trim(), iban: str(body.iban), recipientName: str(body.recipientName) };
}
