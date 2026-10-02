// Vuelve a dar de alta a un alumno eliminado a partir de su backup
// (deleted_students_backup) y lo asigna a un profesor, con los mismos pasos que
// un alta desde el panel: ficha en students (con su id original), asignación,
// casillas del calendario, campanita + email al profesor y bienvenida al alumno.
//
//   node --env-file=.env.local --import tsx scripts/restaurar-alumno.mts --backup delbak_... --profesor t28 --inicio 2026-10-05
//       ← ENSAYO: muestra lo que haría. No escribe nada.
//   ... --apply      ← lo hace de verdad
//
// Los horarios son los del backup. Si alguna casilla ya no está libre, no se
// escribe nada. Los emails pegan contra la app de producción (PUBLIC_APP_URL),
// que es lo que haría el navegador.

import { supabase } from '@/lib/supabase';
import { dbAddAssignment, dbApplyGridChanges, dbReadTeacherGrid } from '@/lib/db';
import { PUBLIC_APP_URL } from '@/lib/appUrl';
import type { Assignment, AssignedSlot } from '@/types';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? '' : ''; };
const BACKUP = flag('--backup');
const PROFESOR = flag('--profesor');
const INICIO = flag('--inicio');
const APPLY = args.includes('--apply');

if (!BACKUP || !PROFESOR || !/^\d{4}-\d{2}-\d{2}$/.test(INICIO)) {
  console.error('Uso: --backup <id> --profesor <teacher_id> --inicio AAAA-MM-DD [--apply]');
  process.exit(1);
}

const { data: bak, error: bakErr } = await supabase.from('deleted_students_backup').select('*').eq('id', BACKUP).maybeSingle();
if (bakErr || !bak) { console.error('No encuentro el backup:', bakErr?.message ?? BACKUP); process.exit(1); }
if (bak.restored) { console.error('Ese backup ya figura como restaurado.'); process.exit(1); }

const sd = bak.student_data as Record<string, unknown>;
const studentId = String(sd.id);
const oldAsg = (bak.assignments_data as Array<Record<string, unknown>>)?.[0] ?? {};
const slots = (oldAsg.slots as AssignedSlot[]) ?? [];

const { data: teacher } = await supabase.from('teachers').select('id, name, email').eq('id', PROFESOR).maybeSingle();
if (!teacher) { console.error('No existe el profesor', PROFESOR); process.exit(1); }

const { data: vivo } = await supabase.from('students').select('id, name').or(`id.eq.${studentId},email.ilike.${String(sd.email)}`);
if (vivo?.length) { console.error('Ya hay un alumno vivo con ese id o email:', vivo); process.exit(1); }

const grid = await dbReadTeacherGrid(teacher.id);
const changes: Record<string, { expected: unknown; next: unknown }> = {};
for (const s of slots) {
  const key = `${s.day}_${s.hour}`;
  const cell = grid[key];
  if (!cell || cell.state !== 'libre') { console.error(`La casilla ${key} de ${teacher.name} no está libre:`, cell); process.exit(1); }
  changes[key] = { expected: cell, next: { state: 'ocupado', student: String(sd.name) } };
}

const asg: Assignment = {
  id: String(oldAsg.id ?? `a_${studentId.replace(/^s_/, '')}`),
  teacherId: teacher.id, teacherName: teacher.name, teacherEmail: teacher.email,
  studentId, studentName: String(sd.name), studentEmail: String(sd.email), studentLevel: String(sd.level ?? 'B1'),
  slots, objetivo: String(oldAsg.objetivo ?? ''), plan: String(sd.plan ?? ''),
  weeklyHours: Number(oldAsg.weekly_hours ?? slots.length), availability: '', notes: String(oldAsg.notes ?? ''),
  startDate: INICIO, teacherSince: INICIO, manualClassAdjustment: 0,
} as Assignment;

console.log(`Alumno:     ${sd.name} <${sd.email}> (${studentId}), ${sd.level}, ${sd.plan}`);
console.log(`Profesor:   ${teacher.name} (${teacher.id})`);
console.log(`Horario:    ${slots.map(s => `${s.day} ${s.hour}`).join(', ')}, desde ${INICIO}`);
console.log(`Asignación: ${asg.id}`);
console.log(`Emails vía: ${PUBLIC_APP_URL}`);
if (!APPLY) { console.log('\nENSAYO: no se escribió nada. Repetí con --apply.'); process.exit(0); }

// 1) Ficha del alumno, con su id original (la cadena de backups/bajas lo referencia).
const student = { ...sd };
for (const k of ['ending_notice_sent_at', 'ending_notice_for_date', 'sales_contacted_at', 'sales_contacted_by', 'sales_contact_result', 'sales_contact_for_date']) student[k] = null;
student.churned_with_open_alert = false;
const { error: stuErr } = await supabase.from('students').insert(student);
if (stuErr) { console.error('No se pudo crear la ficha:', stuErr.message); process.exit(1); }
console.log('✓ Ficha creada');

// 2) Asignación.
await dbAddAssignment(asg);
console.log('✓ Asignación creada');

// 3) Calendario.
const res = await dbApplyGridChanges(teacher.id, changes as never, { role: 'admin', name: 'admin', origin: 'restauracion' });
console.log(`✓ Calendario: ${res.applied.join(', ') || '—'}${res.conflicts.length ? ` · CONFLICTOS: ${res.conflicts.join(', ')}` : ''}`);

// 4) Backup marcado como restaurado.
await supabase.from('deleted_students_backup').update({ restored: true, restored_at: new Date().toISOString() }).eq('id', BACKUP);
console.log('✓ Backup marcado como restaurado');

// 5) Campanita + email al profesor (lo mismo que dbNotifyNewAssignment).
await supabase.from('notifications').insert({
  id: `notif_newasgn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  target_user: teacher.id, target_role: null, title: '📚 Nuevo alumno asignado',
  body: `Se te asignó ${asg.studentName}. Recordá presentarte por correo electrónico (${asg.studentEmail}) antes de la primera clase.`,
  type: 'new_assignment', read_by: [], created_at: new Date().toISOString(), created_by: 'sistema',
});
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${PUBLIC_APP_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
console.log('Email al profesor:', await post('/api/emails', {
  type: 'new_student', teacherId: teacher.id, studentName: asg.studentName, studentEmail: asg.studentEmail,
  plan: asg.plan, level: asg.studentLevel, slots, startDate: INICIO,
}));

// 6) Bienvenida al alumno.
console.log('Bienvenida:', await post(`/api/assignments/${encodeURIComponent(asg.id)}/welcome-email`, { reason: 'alta' }));
