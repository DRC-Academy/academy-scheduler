// Envía el aviso de cancelación a uno o varios profesores. Se usa desde la
// eliminación manual de un alumno (app/students/page.tsx), ya que Resend solo
// puede llamarse server-side (RESEND_API_KEY no está disponible en el browser).

import { sendCancellationEmail } from '@/lib/notifications-email';

export const runtime = 'nodejs';

interface Recipient { email: string; name: string }

export async function POST(req: Request): Promise<Response> {
  let body: { studentName?: string; recipients?: Recipient[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const studentName = String(body?.studentName ?? '').trim();
  const recipients  = Array.isArray(body?.recipients) ? body!.recipients! : [];

  if (!studentName || recipients.length === 0) {
    return Response.json({ sent: 0 });
  }

  let sent = 0;
  for (const r of recipients) {
    const to = String(r?.email ?? '').trim();
    if (!to) continue;
    const ok = await sendCancellationEmail(to, String(r?.name ?? '').trim(), studentName);
    if (ok) sent++;
  }

  return Response.json({ sent });
}
