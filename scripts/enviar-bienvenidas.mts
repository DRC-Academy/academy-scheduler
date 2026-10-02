// Envío manual de la bienvenida a asignaciones concretas, con la MISMA función
// que la ruta (sendWelcomeForAssignment): interruptor, ventana de 72 h, reclamo
// atómico, comprobación en vista_perfil_alumno y marcha atrás si Resend falla.
//
//   node --env-file=.env.local --import tsx scripts/enviar-bienvenidas.mts a_123 a_456
//       ← ENSAYO: estado de cada una y qué enlace de formulario usaría. No envía.
//   ... --apply      ← envía de verdad
//
// Los enlaces del email salen de PUBLIC_APP_URL (lib/appUrl), igual que en producción.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { PUBLIC_APP_URL } from '@/lib/appUrl';
import { sendWelcomeForAssignment, loadAssignmentForWelcome } from '@/lib/welcomeEmailSend';
import { findLatestFormToken, formTokenState, hasCompletedFormToken } from '@/lib/formTokenServer';
import { isInWelcomeWindow } from '@/lib/welcomeEmail';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ids = args.filter(a => !a.startsWith('--'));
if (ids.length === 0) { console.error('Pasá al menos un id de asignación.'); process.exit(1); }

const admin = getSupabaseAdmin();
if (!admin) { console.error('Falta SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }

const tokenCount = async (studentId: string | null) => {
  if (!studentId) return 0;
  const { count } = await admin.from('form_tokens').select('id', { count: 'exact', head: true })
    .eq('student_id', studentId).is('superseded_at', null);
  return count ?? 0;
};

for (const id of ids) {
  const a = await loadAssignmentForWelcome(admin, id);
  if (!a) { console.log(`✗ ${id}: no existe`); continue; }
  const student = { id: a.student_id, name: a.student_name };
  const [latest, formDone, before] = await Promise.all([
    findLatestFormToken(admin, student), hasCompletedFormToken(admin, student), tokenCount(a.student_id),
  ]);
  const tokenInfo = formDone ? 'formulario ya completado'
    : latest && formTokenState(latest) === 'pending' ? `reutiliza ${latest.token}`
    : 'CREARÍA uno nuevo';
  console.log(`\n${a.student_name} (${id}) · ${a.teacher_name}`);
  console.log(`  ventana 72 h: ${isInWelcomeWindow(a.created_at) ? 'sí' : 'NO'} · enviada: ${a.welcome_email_sent_at ?? 'no'} · enlace: ${tokenInfo}`);
  if (!APPLY) continue;

  const res = await sendWelcomeForAssignment(admin, id, 'alta', PUBLIC_APP_URL);
  const after = await tokenCount(a.student_id);
  if ('sent' in res) console.log(`  ✓ OK · ${res.variant} → ${res.to}${res.cc ? ` (cc ${res.cc})` : ''} · Resend ${res.resendId}`);
  else if ('skipped' in res) console.log(`  – saltada: ${res.skipped}`);
  else console.log(`  ✗ ERROR: ${res.error}`);
  console.log(`  enlaces de formulario vigentes: ${before} → ${after}${after > before ? '  ⚠ SE CREÓ UNO NUEVO' : ''}`);
}
if (!APPLY) console.log('\nENSAYO: no se envió nada. Repetí con --apply.');
