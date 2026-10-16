// Vista previa del SCORING v2 — SOLO LECTURA: calcula con el motor real
// (lib/teacherScore vía lib/teacherScoreLoad) y lo imprime. No guarda nada.
//
//   node --conditions=react-server --env-file=.env.local --import tsx scripts/score-v2-preview.mts [nombre ...] [--json archivo]
//
// Los nombres que se pasen salen con el detalle completo de cada pilar.

import fs from 'node:fs';
import { calcularScoringV2Ahora } from '@/lib/teacherScoreLoad';
import type { Pilar, ResultadoProfe } from '@/lib/teacherScore';

const args = process.argv.slice(2);
const iJson = args.indexOf('--json');
const jsonPath = iJson >= 0 ? args[iJson + 1] : null;
const destacados = args.filter((a, i) => !a.startsWith('--') && i !== iJson + 1).map(a => a.toLowerCase());

const r = await calcularScoringV2Ahora();
if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(r, null, 1));

const n = (v: number | null) => (v === null ? '  —  ' : v.toFixed(1).padStart(5));
const a = r.academia;
console.log(`\nSCORING v2 · ventana ${a.ventana.desde} → ${a.ventana.hasta}`);
console.log(`Academia: ${a.bajas} bajas en ${a.alumnosMes} alumnos-mes = ${a.tasaBajas === null ? '—' : (a.tasaBajas * 100).toFixed(2)} cada 100 · mediana de habla ${a.medianaHabla ?? '—'}%`);
console.log(`Bajas duplicadas descartadas: ${a.bajasDuplicadasDescartadas}`);
for (const d of a.duplicados) console.log(`   · ${d}`);
for (const av of a.avisos) console.log(`Aviso: ${av}`);

const filas = [...r.profesores].sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
console.log('\nProfe          Total Nivel          Conf.  Reten Cumpl Riesg Calid  Al-mes Bajas Clases');
for (const p of filas) {
  const marca = destacados.some(d => p.teacherName.toLowerCase().startsWith(d)) ? '*' : ' ';
  console.log(
    `${marca}${p.teacherName.padEnd(13).slice(0, 13)} ${n(p.score)} ${p.level.padEnd(14)} ${p.confidence.padEnd(6)}`
    + ` ${n(p.pilares.retencion.score)} ${n(p.pilares.cumplimiento.score)} ${n(p.pilares.riesgo.score)} ${n(p.pilares.calidad.score)}`
    + `  ${String(p.exposicion.alumnosMes).padStart(5)} ${String(p.exposicion.bajas).padStart(5)} ${String(p.exposicion.clases).padStart(6)}`,
  );
}

console.log('\nPilares en null:');
for (const p of filas) {
  const nulos = (Object.entries(p.pilares) as Array<[string, Pilar]>)
    .filter(([k, x]) => k !== 'crecimiento' && x.score === null).map(([k, x]) => `${k} (${x.motivoNull})`);
  if (nulos.length) console.log(`   ${p.teacherName}: ${nulos.join(' · ')}`);
}

function detalle(p: ResultadoProfe): void {
  console.log(`\n══ ${p.teacherName}: ${p.score ?? '—'} → ${p.level} (${p.levelMotivo}) · confianza ${p.confidence}`);
  console.log(`   Pilares ${p.scorePilares ?? '—'}, ajustes ${p.ajustes.total >= 0 ? '+' : ''}${p.ajustes.total}${p.ajustes.eventos.length ? ` (${p.ajustes.eventos.join('; ')})` : ''}`);
  const e = p.experiencia;
  console.log(`   ${e.alumnosActivos} alumnos activos · ${e.horasSemanales} h/semana · ${e.pctCalendarioOcupado ?? '—'}% del calendario · ${e.mesesEnAcademia ?? '—'} meses (desde ${e.primeraClase ?? '—'})`);
  for (const [k, x] of Object.entries(p.pilares) as Array<[string, Pilar]>) {
    if (k === 'crecimiento') continue;
    console.log(`   ${k.padEnd(12)} ${n(x.score)} (peso ${x.pesoEfectivo}%) ${x.motivoNull ?? x.resumen}`);
    for (const [pk, parte] of Object.entries(x.partes ?? {})) {
      console.log(`      ${pk.padEnd(13)} ${n(parte.score)} ${parte.motivoNull ?? parte.resumen}`);
      for (const ev of parte.eventos.slice(0, 4)) console.log(`         - ${ev}`);
    }
    for (const ev of x.eventos.slice(0, 8)) console.log(`      - ${ev}`);
  }
}
for (const p of filas.filter(x => destacados.some(d => x.teacherName.toLowerCase().startsWith(d)))) detalle(p);
