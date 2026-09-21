// SCRIPT DE UN SOLO USO (18/09/2026). No lo referencia nada: ni la app ni los
// crons. Se corre a mano y se puede borrar cuando ya haya cumplido.
//
// Recordatorio a los profesores que no subieron la grabación de la clase 15 de
// un alumno. UN email por alumno, al profesor que lo tiene (si un profesor tiene
// tres alumnos en la lista, recibe tres emails). Sale por Resend desde
// notificaciones@drcacademy.com, con el mismo cliente que usa la app (lib/resend).
//
//   node --env-file=.env.local --import tsx scripts/recordatorio-grabacion-clase-15.mts
//       ← ENSAYO: resuelve los emails y muestra la tabla de los envíos. No manda nada.
//   node --env-file=.env.local --import tsx scripts/recordatorio-grabacion-clase-15.mts --enviar
//       ← manda de verdad, con una pausa entre envíos, y resume OK / fallos.
//   ... --seguimiento [--enviar]
//       ← SEGUNDO aviso (21/09/2026): mismo listado, texto de seguimiento. El
//         primero salió el viernes 18/09 y al lunes 21 ninguno de los 17 había
//         subido el enlace a la planilla.
//
// El email de cada profesor sale de la tabla `teachers`, cruzando por el nombre
// tal como aparece en `assignments.teacher_name` ("Daiana" y "Daiana.M" son dos
// profesoras distintas). Si el nombre no resuelve a UN solo profesor o el
// profesor no tiene email, la fila se marca y NO se manda: nunca se inventa una
// dirección. Se prefiere `notification_email` y, si no hay, `email`, igual que
// los avisos de cancelación.
//
// Para enviar hace falta RESEND_API_KEY en .env.local (en Vercel está; en local
// no suele estar): sin ella el ensayo funciona y el envío se corta antes de
// empezar.

import { setTimeout as sleep } from 'node:timers/promises';
import { supabase } from '@/lib/supabase';
import { resend, hasResendKey } from '@/lib/resend';

const ENVIAR = process.argv.includes('--enviar');
const SEGUIMIENTO = process.argv.includes('--seguimiento');
const PAUSA_MS = 700;   // Resend admite 2 req/s; con 0,7 s entre envíos sobra margen.

const FROM = 'DRC Academy <notificaciones@drcacademy.com>';
const PLANILLA = 'https://docs.google.com/spreadsheets/d/1xmG0lKM9ebAnUoHuFKR0pNBP1XtpaG0jZR9-DfbRlYk/edit?gid=0#gid=0';

// ── La lista (profesor tal como está en assignments.teacher_name → alumno) ──
const LISTA: Array<[profesor: string, alumno: string]> = [
  ['Wanda',     'Miguel Ángel Mora Reina'],
  ['Wanda',     'Laia Pi'],
  ['Wanda',     'Izaro Gaztañaga Uzkudun'],
  ['Wanda',     'Joaquin Becerra Espinosa'],
  ['Silvia',    'Cristina Montoro Heras'],
  ['Silvia',    'Ana Andres Redon'],
  ['Silvia',    'Saray Garcia'],
  ['Vanesa',    'Maria Saria Irvene Castillo Peinado'],
  ['Vanesa',    'Yancy Alejandra Villarreal Aguirre'],
  ['Vanesa',    'Carles Aliaga'],
  ['Daiana',    'Ingrid Lopez'],
  ['Daiana',    'Lucia Granado'],
  ['Daiana.M',  'Inmaculada Torres'],
  ['Daiana.M',  'Isabel Vallina Garcia'],
  ['Luciana',   'Estela Gonzalez Libramento'],
  ['Jimena',    'Álvaro Jabón Gomez'],
  ['Florencia', 'Samantha Reyes'],
];

// ── Textos (español de España, tal cual los pasó Facundo) ───────────────────
const asunto = (alumno: string) => `Recordatorio: grabación de la clase 15 de ${alumno}`;

const cuerpoTexto = (profesor: string, alumno: string) => `¡Hola, ${profesor}!

Te escribimos con un pequeño recordatorio: ${alumno} ya ha llegado a la clase número 15 y todavía no tenemos la grabación de esa clase en la planilla.

Como sabes, en la clase 15 grabamos al alumno para que pueda comparar su progreso con la clase 1, así que es un momento muy especial para él o ella. Si aún no la has grabado, no pasa nada: hazlo en la próxima clase con la presentación de la clase 15 y sube el enlace a la planilla de grabaciones, en la columna "Grabación clase #15":
${PLANILLA}

Si ya la has subido en otro sitio o has tenido algún problema con la grabación, responde a este correo y lo solucionamos juntos.

¡Muchas gracias por tu trabajo!
Equipo DRC Academy`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const cuerpoHtml = (profesor: string, alumno: string) => `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#191A17;">
  <h2 style="margin:0 0 16px;font-size:20px;color:#1E9E3A;">Recordatorio: grabación de la clase 15 de ${esc(alumno)}</h2>
  <p>¡Hola, ${esc(profesor)}!</p>
  <p>Te escribimos con un pequeño recordatorio: ${esc(alumno)} ya ha llegado a la clase número 15 y todavía no tenemos la grabación de esa clase en la planilla.</p>
  <p>Como sabes, en la clase 15 grabamos al alumno para que pueda comparar su progreso con la clase 1, así que es un momento muy especial para él o ella. Si aún no la has grabado, no pasa nada: hazlo en la próxima clase con la presentación de la clase 15 y sube el enlace a la planilla de grabaciones, en la columna "Grabación clase #15":<br>
  <a href="${PLANILLA}" style="color:#1E9E3A;">${PLANILLA}</a></p>
  <p>Si ya la has subido en otro sitio o has tenido algún problema con la grabación, responde a este correo y lo solucionamos juntos.</p>
  <p>¡Muchas gracias por tu trabajo!<br>Equipo DRC Academy</p>
</body></html>`;

// ── Textos del SEGUNDO aviso (--seguimiento) ────────────────────────────────
const asuntoSeg = (alumno: string) => `Seguimiento: grabación de la clase 15 de ${alumno}`;

const cuerpoTextoSeg = (profesor: string, alumno: string) => `¡Hola, ${profesor}!

Te escribimos de nuevo por la grabación de la clase 15 de ${alumno}: el viernes te mandamos un recordatorio y en la planilla todavía no aparece el enlace.

Si ya la has grabado, solo falta subir el enlace a la planilla de grabaciones, en la columna "Grabación clase #15":
${PLANILLA}

Si aún no la has grabado, hazlo en la próxima clase con la presentación de la clase 15 (en la diapositiva "This is where you began" se reproduce el vídeo de la clase 1, que está en esa misma planilla) y sube el enlace en cuanto lo tengas.

¿Has tenido algún problema con la grabación o con la planilla? Responde a este correo y lo solucionamos juntos.

¡Muchas gracias!
Equipo DRC Academy`;

const cuerpoHtmlSeg = (profesor: string, alumno: string) => `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#191A17;">
  <h2 style="margin:0 0 16px;font-size:20px;color:#1E9E3A;">Seguimiento: grabación de la clase 15 de ${esc(alumno)}</h2>
  <p>¡Hola, ${esc(profesor)}!</p>
  <p>Te escribimos de nuevo por la grabación de la clase 15 de ${esc(alumno)}: el viernes te mandamos un recordatorio y en la planilla todavía no aparece el enlace.</p>
  <p>Si ya la has grabado, solo falta subir el enlace a la planilla de grabaciones, en la columna "Grabación clase #15":<br>
  <a href="${PLANILLA}" style="color:#1E9E3A;">${PLANILLA}</a></p>
  <p>Si aún no la has grabado, hazlo en la próxima clase con la presentación de la clase 15 (en la diapositiva "This is where you began" se reproduce el vídeo de la clase 1, que está en esa misma planilla) y sube el enlace en cuanto lo tengas.</p>
  <p>¿Has tenido algún problema con la grabación o con la planilla? Responde a este correo y lo solucionamos juntos.</p>
  <p>¡Muchas gracias!<br>Equipo DRC Academy</p>
</body></html>`;

// Qué textos salen según el modo.
const textos = SEGUIMIENTO
  ? { asunto: asuntoSeg, texto: cuerpoTextoSeg, html: cuerpoHtmlSeg }
  : { asunto, texto: cuerpoTexto, html: cuerpoHtml };

// ── Resolver los emails ─────────────────────────────────────────────────────
interface Envio {
  profesor: string; alumno: string; email: string | null; asunto: string;
  /** Por qué NO se manda (vacío si está todo bien). */
  problema: string;
  /** Aviso que no bloquea: el alumno no figura con ese profesor en assignments. */
  aviso?: string;
}

const [{ data: teachers, error: e1 }, { data: asgs, error: e2 }] = await Promise.all([
  supabase.from('teachers').select('id, name, email, notification_email').limit(1000),
  supabase.from('assignments').select('teacher_id, teacher_name, student_name').limit(5000),
]);
if (e1 || e2) throw new Error(`No se pudo leer la base: ${e1?.message ?? e2?.message}`);

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// teacher_name (exacto, como en assignments) → ids de profesor que lo usan.
const idsPorNombre = new Map<string, Set<string>>();
for (const a of asgs ?? []) {
  const k = (a.teacher_name ?? '').trim();
  if (!k) continue;
  if (!idsPorNombre.has(k)) idsPorNombre.set(k, new Set());
  idsPorNombre.get(k)!.add(a.teacher_id);
}
const teacherById = new Map((teachers ?? []).map(t => [t.id, t]));
const teacherByName = new Map((teachers ?? []).map(t => [(t.name ?? '').trim(), t]));

const envios: Envio[] = LISTA.map(([profesor, alumno]) => {
  const base: Envio = { profesor, alumno, email: null, asunto: textos.asunto(alumno), problema: '' };

  // 1) Por assignments.teacher_name → teacher_id → teachers. 2) Respaldo: teachers.name exacto.
  const ids = [...(idsPorNombre.get(profesor) ?? [])];
  let t = ids.length === 1 ? teacherById.get(ids[0]) : undefined;
  if (ids.length > 1) {
    const candidatos = ids.map(id => teacherById.get(id)).filter(Boolean);
    return { ...base, problema: `"${profesor}" apunta a ${ids.length} profesores distintos en assignments: ${candidatos.map(c => `${c!.name} <${c!.notification_email || c!.email || 'sin email'}>`).join(' / ')}` };
  }
  if (!t) t = teacherByName.get(profesor);
  if (!t) return { ...base, problema: `"${profesor}" no aparece ni en assignments.teacher_name ni en teachers.name` };

  const email = (t.notification_email || t.email || '').trim();
  if (!email) return { ...base, problema: `${t.name} (${t.id}) no tiene email ni notification_email` };

  // Aviso (no bloquea): ¿ese alumno está con ese profesor en assignments?
  const tieneAlumno = (asgs ?? []).some(a => a.teacher_id === t!.id && norm(a.student_name ?? '') === norm(alumno));
  return {
    ...base, email,
    aviso: tieneAlumno ? undefined : `${alumno} no figura en assignments con ${profesor} (se manda igual: la lista es la que manda).`,
  };
});

// ── Tabla ───────────────────────────────────────────────────────────────────
const modo = SEGUIMIENTO ? 'SEGUNDO AVISO (seguimiento)' : 'PRIMER AVISO';
console.log(ENVIAR ? `\n=== ENVIANDO · ${modo} ===` : `\n=== ENSAYO · ${modo} (no se manda nada) ===`);
console.table(envios.map(e => ({
  profesor: e.profesor, email: e.email ?? '—', alumno: e.alumno, asunto: e.asunto,
  estado: e.problema ? `NO SE MANDA: ${e.problema}` : 'listo',
})));

for (const e of envios) if (!e.problema && e.aviso) console.log(`⚠ ${e.aviso}`);

const listos = envios.filter(e => !e.problema);
const bloqueados = envios.filter(e => e.problema);
console.log(`\n${listos.length} listos · ${bloqueados.length} sin resolver · ${envios.length} en total`);

// ── Envío ───────────────────────────────────────────────────────────────────
// Sin process.exit(): con el cliente de Supabase abierto, en Windows salir a la
// fuerza deja una aserción de libuv en la consola. El script termina solo.
if (!ENVIAR) {
  console.log('\nEnsayo terminado. Para mandar de verdad: --enviar\n');
} else if (!hasResendKey()) {
  console.error('\n❌ Falta RESEND_API_KEY en .env.local: no se manda nada. Copiala de Vercel (Settings → Environment Variables) y volvé a correr.\n');
  process.exitCode = 1;
} else {
  await enviar();
}

async function enviar() {
const ok: string[] = [];
const fallos: string[] = [];
for (const e of listos) {
  // El SDK de Resend NO lanza en errores de API: los devuelve en `error`.
  try {
    const { data, error } = await resend.emails.send({
      from: FROM, to: e.email!, subject: e.asunto,
      html: textos.html(e.profesor, e.alumno), text: textos.texto(e.profesor, e.alumno),
    });
    if (error) {
      fallos.push(`${e.profesor} · ${e.alumno} → ${e.email}: ${error.name} ${error.message}`);
      console.log(`  ❌ ${e.profesor} · ${e.alumno}: ${error.message}`);
    } else {
      ok.push(`${e.profesor} · ${e.alumno} → ${e.email} (id ${data?.id})`);
      console.log(`  ✅ ${e.profesor} · ${e.alumno} → ${e.email}`);
    }
  } catch (err) {
    fallos.push(`${e.profesor} · ${e.alumno} → ${e.email}: ${String(err)}`);
    console.log(`  ❌ ${e.profesor} · ${e.alumno}: ${String(err)}`);
  }
  await sleep(PAUSA_MS);
}

console.log(`\n=== RESULTADO: ${ok.length} OK · ${fallos.length} fallidos · ${bloqueados.length} sin mandar por datos ===`);
if (fallos.length) { console.log('\nFallidos:'); for (const f of fallos) console.log(`  · ${f}`); }
if (bloqueados.length) { console.log('\nSin mandar (datos):'); for (const b of bloqueados) console.log(`  · ${b.profesor} · ${b.alumno}: ${b.problema}`); }
}
