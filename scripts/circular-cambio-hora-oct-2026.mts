// Circular del cambio de hora de España (domingo 25/10/2026) a todos los profesores.
//
//   npx tsx scripts/circular-cambio-hora-oct-2026.mts            → simulación, no envía
//   npx tsx scripts/circular-cambio-hora-oct-2026.mts --enviar   → envía de verdad
//
// Hace lo mismo que /admin → Notificaciones → "Todos los profesores" (aviso in-app
// con target_role 'teacher' y después el email en un batch de Resend), con dos
// diferencias pedidas para este envío: el saludo es "¡Hola {nombre}!" en vez de
// "Hola {nombre}," y el nombre va limpio (algunos se guardan con sufijos para
// distinguirlos en el admin, como "Daiana.M" o "Sol.G").
//
// Si ya existe una circular con este título, no hace nada: así una segunda
// ejecución no duplica el aviso ni el correo.

import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const { supabase } = await import('@/lib/supabase');
const { resend, hasResendKey } = await import('@/lib/resend');
const { baseEmailTemplate, esc, destinationFor } = await import('@/lib/emailNotifications');

const ENVIAR = process.argv.includes('--enviar');

const TITLE = 'Cambio de hora en España este domingo 25/10';
const BODY = `Este domingo 25 de octubre España atrasa el reloj una hora (pasa al horario de invierno). Argentina no cambia de hora.

Qué significa para ti:
• Tus clases siguen a la misma hora de España. Tus alumnos no notan nada y en tu calendario vas a ver exactamente los mismos horarios.
• Lo que cambia es la hora en Argentina: desde el lunes 26 de octubre, cada una de tus clases empieza 1 hora más tarde que hasta ahora.
• La diferencia pasa de 5 a 4 horas: tu hora en Argentina = hora de España menos 4.

Ejemplos:
• Clase de las 09:00 en España: antes la dabas a las 04:00, ahora a las 05:00
• Clase de las 18:00 en España: antes la dabas a las 13:00, ahora a las 14:00
• Clase de las 22:00 en España: antes la dabas a las 17:00, ahora a las 18:00

Te recomendamos revisar tu agenda de la próxima semana y mover una hora las alarmas o recordatorios que tengas en hora argentina. Tu puntualidad y tus ausencias se siguen midiendo con la hora de España.

Gracias.`;

// Nombre de pila para el saludo, por id (los guardados llevan sufijos del admin).
const NOMBRE_SALUDO: Record<string, string> = {
  t1: 'Sebastian',   // "Sebastian (test)"
  t7: 'Daiana',      // "Daiana.M"
  t10: 'Sol',        // "Sol.G"
  t15: 'Daniela',    // "DanielaN"
  t12: 'Florencia',  // "MFlorencia"
};
const saludoDe = (t: { id: string; name: string }) => NOMBRE_SALUDO[t.id] ?? t.name.trim();

const { data: teachers, error } = await supabase.from('teachers').select('*');
if (error || !teachers) throw new Error(`No se pudieron leer los profesores: ${error?.message}`);
const activos = teachers.filter(t => !t.archived_at);

const destinatarios = activos.map(t => ({
  id: t.id as string,
  saludo: saludoDe(t),
  to: destinationFor({ name: t.name, email: t.email, notificationEmail: t.notification_email }),
}));

console.log(`${destinatarios.length} profesores activos:`);
for (const d of destinatarios) console.log(`  ${d.id.padEnd(16)} ¡Hola ${d.saludo}!  →  ${d.to || '(SIN EMAIL)'}`);

const { data: previas } = await supabase.from('notifications').select('id, created_at').eq('title', TITLE);
if (previas && previas.length > 0) {
  console.log(`\nYa existe una circular con este título (${previas[0].id}, ${previas[0].created_at}). No se envía nada.`);
  process.exitCode = 0;
} else if (!ENVIAR) {
  console.log('\nSimulación: no se envió nada. Volver a correr con --enviar.');
} else {
  if (!hasResendKey()) throw new Error('Falta RESEND_API_KEY en .env.local.');

  // 1) Aviso in-app (igual que dbSendNotification desde el panel).
  const id = `notif_${Date.now()}`;
  const { error: insErr } = await supabase.from('notifications').insert({
    id, target_user: null, target_role: 'teacher',
    title: TITLE, body: BODY, type: 'circular',
    read_by: [], created_at: new Date().toISOString(), created_by: 'Admin',
  });
  if (insErr) throw new Error(`No se guardó el aviso in-app: ${insErr.message}`);
  console.log(`\nAviso in-app guardado: ${id}`);

  // 2) Email, solo si el aviso se guardó.
  const conEmail = destinatarios.filter(d => d.to);
  const html = (saludo: string) => baseEmailTemplate(
    `<p style="margin:0 0 16px;">¡Hola ${esc(saludo)}!</p>` +
    `<p style="margin:0 0 16px;">${esc(BODY).replace(/\n/g, '<br />')}</p>` +
    `<p style="margin:0 0 16px;">Este mensaje ha sido enviado por el equipo de DRC Academy.</p>`,
    TITLE,
  );
  const { data, error: mailErr } = await resend.batch.send(
    conEmail.map(d => ({ from: 'DRC Academy <notificaciones@drcacademy.com>', to: d.to, subject: TITLE, html: html(d.saludo) })),
  );
  if (mailErr) throw new Error(`Resend rechazó el batch: ${mailErr.name}: ${mailErr.message}`);
  console.log(`Emails aceptados por Resend: ${data?.data?.length ?? conEmail.length} de ${conEmail.length}.`);
}
