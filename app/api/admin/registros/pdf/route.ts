// GET /api/admin/registros/pdf?desde=&hasta=&alumno=&profe=&estado=
//
// El PDF del "Registro para disputas": exactamente lo filtrado, SIN las filas
// "Sin registro" ni "Posible ausencia del profe (sin confirmar)" (lib/classRegister.pdfRows).
// Generado aquí, en el servidor (lib/classRegisterPdf), sin un solo enlace y con
// tope de 4,5 MB. Nombre: registro-[alumno]-[desde]-[hasta].pdf. SOLO LECTURA.
//
// SEGURIDAD: exige la sesión de admin (lib/adminSession). Sin ella, 401.

import { requireAdminSession } from '@/lib/adminSession';
import { requireAdminClient } from '@/lib/cronAuth';
import { loadRegister, normalizeFilter, RegisterRangeError } from '@/lib/classRegisterStore';
import { pdfRows, pdfFileName } from '@/lib/classRegister';
import { buildRegisterPdf, PdfTooLargeError } from '@/lib/classRegisterPdf';
import { getSpainParts } from '@/lib/spainTime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const session = requireAdminSession(request);
  if (session.error) return session.error;
  const { admin, error } = requireAdminClient('registros/pdf');
  if (error) return error;

  const q = new URL(request.url).searchParams;
  try {
    const filtro = normalizeFilter({
      desde: q.get('desde'), hasta: q.get('hasta'), alumno: q.get('alumno'), profe: q.get('profe'), estado: q.get('estado'),
    }, getSpainParts(new Date()).dateStr);
    const r = await loadRegister(admin, filtro);
    const pdf = await buildRegisterPdf({ rows: pdfRows(r.rows), desde: filtro.desde, hasta: filtro.hasta, alumno: r.alumno });
    const name = pdfFileName(r.alumno?.name ?? filtro.alumno, filtro.desde, filtro.hasta);
    return new Response(new Uint8Array(pdf), {
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.length),
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    });
  } catch (err) {
    if (err instanceof RegisterRangeError) return Response.json({ error: err.message }, { status: 400, headers: NO_STORE });
    if (err instanceof PdfTooLargeError) return Response.json({ error: err.message }, { status: 413, headers: NO_STORE });
    console.error('[admin/registros/pdf]', err);
    return Response.json({ error: 'No se pudo generar el PDF.' }, { status: 500, headers: NO_STORE });
  }
}
