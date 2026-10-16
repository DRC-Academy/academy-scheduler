// ── Datos de pago de los profesores: tipos y llamadas desde el navegador ──────
//
// El navegador NUNCA lee teacher_payment_details con la anon key (la tabla tiene
// RLS sin políticas): todo pasa por las rutas /api, que usan la service role.
// La base vive en lib/paymentDetailsStore.ts; la validación en lib/iban.ts.

import type { PaymentDetailsErrors } from '@/lib/iban';

export interface PaymentDetails {
  iban: string;            // normalizado: sin espacios, mayúsculas
  recipientName: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeacherPaymentRow {
  teacherId: string;
  teacherName: string;
  details: PaymentDetails | null;
}

/** Lo que devuelve una carga: datos, "falta el SQL" o un error para mostrar. */
export type LoadResult<T> =
  | { ok: true; value: T }
  | { ok: false; noConfigurado: true }
  | { ok: false; noConfigurado?: false; error: string };

export type SaveClientResult =
  | { ok: true; details: PaymentDetails }
  | { ok: false; error: string; fieldErrors?: PaymentDetailsErrors };

async function getJson<T>(url: string, pick: (d: Record<string, unknown>) => T, fallback: string): Promise<LoadResult<T>> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (data.noConfigurado) return { ok: false, noConfigurado: true };
    if (!res.ok) return { ok: false, error: data.error ?? fallback };
    return { ok: true, value: pick(data) };
  } catch {
    return { ok: false, error: 'No se pudo conectar con el servidor.' };
  }
}

export function fetchMyPaymentDetails(teacherId: string): Promise<LoadResult<PaymentDetails | null>> {
  return getJson(
    `/api/payment-details?teacherId=${encodeURIComponent(teacherId)}`,
    d => (d.details as PaymentDetails | null) ?? null,
    'No se pudieron cargar tus datos de pago.',
  );
}

export function fetchAllPaymentDetails(): Promise<LoadResult<TeacherPaymentRow[]>> {
  return getJson(
    '/api/admin/payment-details',
    d => (Array.isArray(d.teachers) ? d.teachers as TeacherPaymentRow[] : []),
    'No se pudieron cargar los datos de pago.',
  );
}

/** Guarda los datos de un profesor. `admin` elige la ruta del admin. */
export async function savePaymentDetailsRequest(
  input: { teacherId: string; iban: string; recipientName: string },
  admin = false,
): Promise<SaveClientResult> {
  try {
    const res = await fetch(admin ? '/api/admin/payment-details' : '/api/payment-details', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? 'No se pudieron guardar los datos.', fieldErrors: data.fieldErrors };
    return { ok: true, details: data.details as PaymentDetails };
  } catch {
    return { ok: false, error: 'No se pudo conectar con el servidor.' };
  }
}

/** "16 de octubre de 2026, 14:32", en la hora de quien lo mira. */
export function updatedAtLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
