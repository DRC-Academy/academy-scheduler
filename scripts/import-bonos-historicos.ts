// Importa a `teacher_bonuses` los bonos que ya se pagaron POR FUERA (por email a
// pagos@) antes de que existiera la pestaña Bonos, como 'pagado_externo': así
// (a) el profesor no puede volver a reclamarlos y (b) quedan en el historial.
// NUNCA suman a finanzas (ver lib/bonuses.bonusCountsForFinance).
//
//   node --env-file=.env.local --import tsx scripts/import-bonos-historicos.ts
//       ← DRY-RUN (por defecto): resuelve profesores y alumnos, lista candidatos
//         para las filas "SIN NOMBRE" y muestra la tabla de lo que insertaría.
//   node --env-file=.env.local --import tsx scripts/import-bonos-historicos.ts --apply
//       ← inserta de verdad, una fila por vez; si el índice único rechaza una
//         (mismo alumno y profesor ya cargado) la salta y lo avisa.
//
// Fuente: docs/bonos_pagados_2026.csv (paid_month, profesor, bonus_type, euros,
// student_name, dato_inicio, observacion). Las filas "SIN NOMBRE — …" se cargan
// tal cual: Facundo las corrige después desde la pestaña Bonos (el nombre es
// editable y al corregirlo se intenta enlazar la assignment).
//
// Reglas de resolución:
//   · Profesor: nombre normalizado (sin tildes, minúsculas) contra `teachers`,
//     INCLUIDOS los archivados (cobraron ellos). "Daiana" y "Daiana.M", "Sol" y
//     "Sol.G" son personas distintas: la comparación es exacta. Alias conocidos
//     abajo (ALIAS_PROFESOR).
//   · Alumno: la assignment del profesor del CSV con el mismo nombre normalizado
//     (el mismo criterio que lib/retention.normName). Si hoy está con OTRO
//     profesor, se carga igual con el del CSV y se avisa. Si no hay assignment
//     (baja), se carga sin assignment_id y se avisa.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dbGetTeachers, dbGetAssignments, dbGetTeacherBonuses, dbMarkBonusesPaidExternal } from '@/lib/db';
import { EVENT_EUROS } from '@/lib/scoringConstants';
import { normName, retentionStartIso, isActiveAssignmentLike, retentionBonusFor, addDaysIso } from '@/lib/retention';
import { buildBonusRows } from '@/lib/bonuses';
import type { Assignment, BonusType, Teacher, TeacherBonus } from '@/types';

const CSV_PATH = resolve(process.cwd(), 'docs/bonos_pagados_2026.csv');
const APPLY = process.argv.includes('--apply') && !process.argv.includes('--dry-run');

/** Nombres del CSV que no coinciden letra por letra con `teachers.name`. */
const ALIAS_PROFESOR: Record<string, string> = {
  daniela: 'danielan',   // "Daniela" del CSV es DanielaN (confirmado por Facundo)
};

// ─── CSV ──────────────────────────────────────────────────────────────────────

interface FilaCsv {
  linea: number;
  paid_month: string;
  profesor: string;
  bonus_type: BonusType;
  euros: number;
  student_name: string;
  dato_inicio: string;
  observacion: string;
}

/** Parser mínimo: comillas dobles, "" escapado, comas dentro de comillas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

function leerCsv(): FilaCsv[] {
  const rows = parseCsv(readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, ''));
  const [head, ...body] = rows;
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`El CSV no tiene la columna "${name}"`);
    return i;
  };
  const ix = {
    paid_month: col('paid_month'), profesor: col('profesor'), bonus_type: col('bonus_type'),
    euros: col('euros'), student_name: col('student_name'), dato_inicio: col('dato_inicio'), observacion: col('observacion'),
  };
  return body.map((r, i) => ({
    linea: i + 2,
    paid_month: r[ix.paid_month].trim(),
    profesor: r[ix.profesor].trim(),
    bonus_type: r[ix.bonus_type].trim() as BonusType,
    euros: Number(r[ix.euros]),
    student_name: r[ix.student_name].trim(),
    dato_inicio: (r[ix.dato_inicio] ?? '').trim(),
    observacion: (r[ix.observacion] ?? '').trim(),
  }));
}

// ─── Resolución ──────────────────────────────────────────────────────────────

interface FilaResuelta extends FilaCsv {
  teacher: Teacher | null;
  assignment: Assignment | null;
  /** true si `assignment` salió del match aproximado (nombre parecido, no igual). */
  aproximado: boolean;
  /** Assignment del mismo alumno con OTRO profesor (hoy). */
  conOtroProfe: Assignment | null;
  sinNombre: boolean;
  avisos: string[];
}

/** Distancia de edición clásica, para tolerar una letra de más o de menos. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[m][n];
}

/**
 * Match APROXIMADO: nombres a ≤2 letras de distancia ("Helga"/"Elga", "Gonzále"/
 * "González") o que comparten al menos dos palabras de 3+ letras. Nunca decide
 * solo: la fila se marca y se lista aparte para que Facundo la confirme.
 */
function pareceElMismo(csvName: string, dbName: string): boolean {
  const a = normName(csvName), b = normName(dbName);
  if (levenshtein(a, b) <= 2) return true;
  // Palabras DISTINTAS compartidas: "Mónica Martínez Nadal Martínez" no debe
  // parecerse a "Adrián Martínez Padilla" por repetir un apellido.
  const ta = new Set(a.split(' ').filter(t => t.length >= 3)), tb = new Set(b.split(' ').filter(t => t.length >= 3));
  return [...tb].filter(t => ta.has(t)).length >= 2;
}

function resolverProfesor(nombre: string, teachers: Teacher[]): Teacher | null {
  const n = normName(nombre);
  const objetivo = ALIAS_PROFESOR[n] ?? n;
  return teachers.find(t => normName(t.name) === objetivo) ?? null;
}

function resolver(filas: FilaCsv[], teachers: Teacher[], assignments: Assignment[]): FilaResuelta[] {
  return filas.map(f => {
    const avisos: string[] = [];
    const teacher = resolverProfesor(f.profesor, teachers);
    if (!teacher) avisos.push(`profesor "${f.profesor}" no existe en teachers`);
    else if (teacher.archivedAt) avisos.push(`profesor ${teacher.name} está archivado (${teacher.archivedAt.slice(0, 10)}): se carga igual`);
    if (f.bonus_type !== 'retencion_6m' && f.bonus_type !== 'upsell') avisos.push(`bonus_type raro: "${f.bonus_type}"`);
    const esperado = f.bonus_type === 'upsell' ? EVENT_EUROS.upsell : EVENT_EUROS.bonus_retencion;
    if (f.euros !== esperado) avisos.push(`euros ${f.euros} ≠ ${esperado} de EVENT_EUROS (se respeta el CSV)`);

    const sinNombre = /^sin nombre/i.test(f.student_name);
    let assignment: Assignment | null = null;
    let aproximado = false;
    let conOtroProfe: Assignment | null = null;
    if (!sinNombre && teacher) {
      const target = normName(f.student_name);
      const delProfe = assignments.filter(a => a.teacherId === teacher.id && normName(a.studentName) === target);
      // Activa primero; si solo hay inactivas, la más reciente.
      assignment = delProfe.find(isActiveAssignmentLike) ?? delProfe[0] ?? null;
      if (!assignment) {
        // Segundo intento: nombre PARECIDO con el mismo profesor (una letra de
        // diferencia deja el par sin bloquear y el profesor podría reclamarlo).
        const parecidas = assignments.filter(a => a.teacherId === teacher.id && pareceElMismo(f.student_name, a.studentName));
        const parecida = parecidas.find(isActiveAssignmentLike) ?? parecidas[0] ?? null;
        if (parecida) {
          assignment = parecida; aproximado = true;
          avisos.push(`≈ MATCH APROXIMADO con "${parecida.studentName}" (${teacher.name}${isActiveAssignmentLike(parecida) ? '' : ', inactiva'}): se enlaza y se guarda el nombre de la base`);
        }
      }
      if (!assignment) {
        const otras = assignments.filter(a => normName(a.studentName) === target || pareceElMismo(f.student_name, a.studentName));
        conOtroProfe = otras.find(isActiveAssignmentLike) ?? otras[0] ?? null;
        if (conOtroProfe) avisos.push(`hoy está con OTRO profesor (${conOtroProfe.teacherName}, como "${conOtroProfe.studentName}"${isActiveAssignmentLike(conOtroProfe) ? '' : ', inactiva'}): se carga con ${teacher.name}, sin assignment_id`);
        else avisos.push('sin assignment (alumno de baja): se carga sin assignment_id');
      } else if (!isActiveAssignmentLike(assignment)) {
        avisos.push(`la assignment con ${teacher.name} está inactiva: se enlaza igual`);
      }
    }
    return { ...f, teacher, assignment, aproximado, conOtroProfe, sinNombre, avisos };
  });
}

// ─── Candidatos para "SIN NOMBRE" ────────────────────────────────────────────

/** Último día del mes 'YYYY-MM'. */
function finDeMes(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

function candidatos(
  f: FilaResuelta, assignments: Assignment[], resueltas: FilaResuelta[], bonuses: TeacherBonus[],
): Array<{ a: Assignment; since: string }> {
  if (!f.teacher) return [];
  const corte = addDaysIso(finDeMes(f.paid_month), -180);
  // Alumnos que el MISMO CSV ya nombra para ese profesor no son candidatos.
  const yaNombrados = new Set(resueltas
    .filter(r => r.teacher?.id === f.teacher!.id && !r.sinNombre && r.bonus_type === 'retencion_6m')
    .map(r => normName(r.student_name)));
  return assignments
    .filter(a => a.teacherId === f.teacher!.id && isActiveAssignmentLike(a))
    .map(a => ({ a, since: retentionStartIso(a) }))
    .filter(({ a, since }) => since <= corte && !yaNombrados.has(normName(a.studentName)) && !retentionBonusFor(bonuses, a))
    .sort((x, y) => x.since.localeCompare(y.since));
}

// ─── Salida ──────────────────────────────────────────────────────────────────

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s).padEnd(n);

function nota(f: FilaCsv): string | null {
  const partes: string[] = [];
  if (f.dato_inicio) partes.push(`Inicio: ${f.dato_inicio}`);
  if (f.observacion) partes.push(f.observacion);
  return partes.length ? partes.join(' · ') : null;
}

async function main() {
  const filas = leerCsv();
  const [teachers, assignments, bonuses] = await Promise.all([
    dbGetTeachers({ includeArchived: true }), dbGetAssignments(), dbGetTeacherBonuses(),
  ]);
  const resueltas = resolver(filas, teachers, assignments);

  const total = filas.reduce((s, f) => s + f.euros, 0);
  console.log(`\nCSV: ${filas.length} filas · ${filas.filter(f => f.bonus_type === 'retencion_6m').length} retención + ${filas.filter(f => f.bonus_type === 'upsell').length} upsell · ${total} €`);
  console.log(`Ya hay en teacher_bonuses: ${bonuses.length} fila(s) (${bonuses.filter(b => b.status === 'pagado_externo').length} pagado_externo)`);
  console.log(`Modo: ${APPLY ? '*** APPLY: se insertan las filas ***' : 'DRY-RUN (no se inserta nada)'}\n`);

  // 1) Profesores
  console.log('── 1) Profesores del CSV → teacher_id ──');
  const porProfe = new Map<string, FilaResuelta[]>();
  for (const r of resueltas) porProfe.set(r.profesor, [...(porProfe.get(r.profesor) ?? []), r]);
  for (const [nombre, rs] of [...porProfe.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const t = rs[0].teacher;
    console.log(`  ${pad(nombre, 12)} → ${t ? `${pad(t.id, 16)} ${t.name}${t.archivedAt ? '  [ARCHIVADO]' : ''}` : '❌ NO MATCHEA'}   (${rs.length} fila${rs.length === 1 ? '' : 's'})`);
  }
  const sinProfe = resueltas.filter(r => !r.teacher);
  if (sinProfe.length) console.log(`\n  ⚠ ${sinProfe.length} fila(s) sin profesor: ${[...new Set(sinProfe.map(r => r.profesor))].join(', ')}. Se cargan después a mano.`);

  // 2) Alumnos con nombre
  console.log('\n── 2) Alumnos con nombre → assignment_id ──');
  for (const r of resueltas.filter(x => !x.sinNombre && x.teacher)) {
    const estado = r.assignment
      ? `${r.aproximado ? `≈ "${r.assignment.studentName}" ` : '✓ '}${r.assignment.id}${isActiveAssignmentLike(r.assignment) ? '' : ' (inactiva)'}`
      : r.conOtroProfe ? `⚠ con otro profe: ${r.conOtroProfe.teacherName}` : '⚠ sin assignment';
    console.log(`  L${String(r.linea).padStart(2)} ${pad(r.student_name, 30)} ${pad(r.teacher!.name, 10)} ${pad(r.bonus_type, 12)} ${r.paid_month}  ${estado}`);
  }

  // 3) SIN NOMBRE: candidatos
  const sinNombre = resueltas.filter(r => r.sinNombre);
  console.log(`\n── 3) Filas "SIN NOMBRE" (${sinNombre.length}): candidatos por profesor ──`);
  console.log('   (activos con teacher_since anterior a fin de paid_month − 180 días, sin bono cargado y no nombrados en el CSV)');
  for (const r of sinNombre) {
    const cands = candidatos(r, assignments, resueltas, bonuses);
    console.log(`\n  L${String(r.linea).padStart(2)} ${r.student_name}  (${r.teacher?.name ?? r.profesor}, ${r.paid_month})${r.observacion ? `\n      obs: ${r.observacion}` : ''}`);
    if (!r.teacher) { console.log('      (sin profesor: no se pueden buscar candidatos)'); continue; }
    if (cands.length === 0) console.log('      sin candidatos');
    for (const c of cands) console.log(`      · ${pad(c.a.studentName, 32)} con el profe desde ${c.since}`);
  }

  // 4) Tabla de inserción
  // Nombre que se guarda: el del CSV, salvo en los match aproximados, donde se
  // guarda el de la base (es el que cruza lib/retention por nombre) y el del CSV
  // queda en la nota.
  const nombreFinal = (r: FilaResuelta) => (r.aproximado && r.assignment ? r.assignment.studentName : r.student_name);
  const notaFinal = (r: FilaResuelta) => {
    const base = nota(r);
    if (!r.aproximado) return base;
    const extra = `En el CSV: "${r.student_name}"`;
    return base ? `${base} · ${extra}` : extra;
  };

  const aInsertar = resueltas.filter(r => r.teacher);
  console.log(`\n── 4) Se insertarían ${aInsertar.length} filas (status pagado_externo) ──`);
  console.log(`  ${pad('L', 3)} ${pad('teacher', 16)} ${pad('alumno', 30)} ${pad('tipo', 12)} ${pad('€', 3)} ${pad('mes', 7)} ${pad('assignment_id', 38)} nota`);
  for (const r of aInsertar) {
    console.log(`  ${pad(String(r.linea), 3)} ${pad(r.teacher!.id, 16)} ${pad(nombreFinal(r), 30)} ${pad(r.bonus_type, 12)} ${pad(String(r.euros), 3)} ${pad(r.paid_month, 7)} ${pad(r.assignment?.id ?? '—', 38)} ${notaFinal(r) ?? ''}`);
  }
  const conAvisos = resueltas.filter(r => r.avisos.length);
  if (conAvisos.length) {
    console.log(`\n── Avisos (${conAvisos.length}) ──`);
    for (const r of conAvisos) for (const a of r.avisos) console.log(`  L${String(r.linea).padStart(2)} ${pad(r.student_name, 30)} ${a}`);
  }

  // 6) Qué pasaría con los "disponibles" de la pestaña Bonos: hoy vs. después
  //    de cargar estas filas (simulado en memoria con la misma función de la app).
  const simulados: TeacherBonus[] = aInsertar.map((r, i) => ({
    id: `sim_${i}`, teacherId: r.teacher!.id, assignmentId: r.assignment?.id ?? null, studentName: nombreFinal(r),
    bonusType: r.bonus_type, euros: r.euros, status: 'pagado_externo', paidMonth: r.paid_month, createdAt: new Date().toISOString(),
  }));
  const hoy = buildBonusRows({ assignments, bonuses, teachers }).filter(x => x.estado === 'disponible');
  const luego = buildBonusRows({ assignments, bonuses: [...bonuses, ...simulados], teachers }).filter(x => x.estado === 'disponible');
  console.log(`\n── 6) Disponibles sin reclamar en la pestaña Bonos: hoy ${hoy.length} → después del import ${luego.length} ──`);
  const porProfeLuego = new Map<string, string[]>();
  for (const x of luego) porProfeLuego.set(x.teacherName, [...(porProfeLuego.get(x.teacherName) ?? []), `${x.studentName} (desde ${x.teacherSince})`]);
  for (const [t, xs] of [...porProfeLuego.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${pad(t, 12)} ${xs.length}: ${xs.join(' · ')}`);
  // Los que el CSV dice que cobró OTRO profesor y hoy figuran disponibles para el actual:
  const cobradosPorOtro = resueltas.filter(r => r.conOtroProfe && isActiveAssignmentLike(r.conOtroProfe));
  if (cobradosPorOtro.length) {
    console.log('\n  ⚠ Cobrados por un profesor ANTERIOR y hoy "disponibles" para el actual (teacher_since heredado de start_date; corregir a mano en Bonos):');
    for (const r of cobradosPorOtro) {
      const a = r.conOtroProfe!;
      const fila = luego.find(x => x.assignment?.id === a.id);
      console.log(`    ${pad(a.studentName, 30)} hoy con ${pad(a.teacherName, 10)} teacher_since ${retentionStartIso(a)} · fila creada ${a.createdAt.slice(0, 10)} · ${fila ? 'DISPONIBLE' : 'no disponible'} (cobró ${r.teacher!.name} en ${r.paid_month})`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY-RUN: no se insertó nada. Para insertar: --apply');
    return;
  }

  // 5) Insertar
  console.log('\n── 5) Insertando ──');
  const { inserted, duplicated } = await dbMarkBonusesPaidExternal(aInsertar.map(r => ({
    teacherId:    r.teacher!.id,
    assignmentId: r.assignment?.id ?? null,
    studentName:  nombreFinal(r),
    bonusType:    r.bonus_type,
    euros:        r.euros,
    paidMonth:    r.paid_month,
    note:         notaFinal(r),
  })));
  console.log(`  insertadas: ${inserted.length}`);
  if (duplicated.length) console.log(`  ⚠ saltadas por el índice único (ya había bono de ese alumno con ese profesor): ${duplicated.join(', ')}`);

  const despues = await dbGetTeacherBonuses();
  const ext = despues.filter(b => b.status === 'pagado_externo');
  console.log(`\nVerificación: pagado_externo = ${ext.length} filas · ${ext.reduce((s, b) => s + b.euros, 0)} €`);
}

main().catch(err => { console.error(err); process.exit(1); });
