// Simulación SIN GASTAR: cuántos testimonios saldrían con cada regla del DESPUÉS.
//   node --env-file=.env.local --conditions=react-server --import tsx scripts/_simular-despues.mts <lecturas.json> <salida.json>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { cleanOpciones, simularPlanEscucha } from '@/lib/testimonialAnalysis';
import { cleanFilters } from '@/lib/testimonialPairPlan';
import { loadConfig } from '@/lib/testimonialConfigStore';
import { readingInputs, type Lectura } from '@/lib/testimonialReading';

const [lectPath, outPath] = process.argv.slice(2);
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const lect = new Map<string, Lectura>(existsSync(lectPath) ? Object.entries(JSON.parse(readFileSync(lectPath, 'utf8'))) as Array<[string, Lectura]> : []);
const { config } = await loadConfig(admin);
const VARIANTES = [
  { nombre: '110 ppm / 1,0 s (actual)', despues_ppm_min: 110, despues_pausa_max_s: 1.0 },
  { nombre: '100 ppm / 1,5 s', despues_ppm_min: 100, despues_pausa_max_s: 1.5 },
  { nombre: '90 ppm / 1,5 s', despues_ppm_min: 90, despues_pausa_max_s: 1.5 },
  { nombre: 'sin mínimo (solo ×1,4 su ANTES) / 1,5 s', despues_ppm_min: 0, despues_pausa_max_s: 1.5 },
];
const o = cleanOpciones({ cantidad: null, fuente: 'escucha', soloNuevas: process.env.SOLO_NUEVAS !== '0' }, cleanFilters({}));
const segIds = new Set<string>();
const res = [];
for (const v of VARIANTES) {
  const c = { ...config, despues_ppm_min: v.despues_ppm_min, despues_pausa_max_s: v.despues_pausa_max_s };
  const p = await simularPlanEscucha(admin, c, o, lect);
  for (const it of p.items) { segIds.add(it.a); segIds.add(it.b); }
  res.push({ ...v, items: p.items, alumnos: p.alumnos });
}
const { data: segs } = await (async () => {
  const ids = [...segIds]; const out: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from('testimonial_listen_segments').select('id, analysis_id, turn_index, student_group, class_day, teacher_id, medidas, texto, habla_start_s, habla_end_s').in('id', ids.slice(i, i + 200));
    if (error) throw error; out.push(...data);
  }
  return { data: out };
})();
const byId = new Map(segs.map(s => [s.id, s]));
const sinClasificar = [...new Set(res.flatMap(r => r.items.map((i: any) => i.b)))].filter(id => !lect.has(id));
const inputs = await readingInputs(admin, sinClasificar.map(id => ({ id, analysisId: byId.get(id).analysis_id, turnIndex: Number(byId.get(id).turn_index), texto: String(byId.get(id).texto ?? '') })));
const { data: st } = await admin.from('students').select('id, name').in('id', [...new Set(segs.map(s => s.student_group))]);
const nombre = new Map((st ?? []).map(s => [String(s.id), String(s.name)]));
writeFileSync(outPath, JSON.stringify({
  sinClasificar: inputs,
  variantes: res.map(r => ({
    nombre: r.nombre, testimonios: r.items.length, alumnos: r.alumnos,
    pares: r.items.map((i: any) => {
      const a = byId.get(i.a), b = byId.get(i.b);
      return { g: i.g, alumno: nombre.get(i.g) ?? i.g, a: i.a, b: i.b, ppmA: a.medidas.ppm, ppmB: b.medidas.ppm, pausaMaxB: b.medidas.pausa_max_s,
        habA: a.medidas.habla_s, habB: b.medidas.habla_s, diaA: a.class_day, diaB: b.class_day, textoB: String(b.texto ?? '').slice(0, 220) };
    }),
  })),
}, null, 1));
console.log(res.map(r => `${r.nombre}: ${r.items.length} testimonios posibles, ${r.alumnos} alumnos`).join('\n'), `\nDESPUÉS sin clasificar: ${inputs.length}`);
