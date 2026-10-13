// FICHA del alumno para el profesor que lo recibe en un CAMBIO DE PROFESOR.
//
// Va en el correo "Nuevo alumno asignado" (sendNewStudentEmail) y en su aviso de
// la campanita, tanto si el cambio lo pide el alumno desde el LMS como si lo
// hace el admin desde el panel: las dos vías pasan por el núcleo de
// transferencia (lib/transferencia/core.ts), que la carga con su cliente.
//
// Reglas:
//   · Tono neutro: "Se incorpora a tus clases…". Nunca se dice que el alumno
//     dejó a otro profesor, y no aparece el nombre del profesor anterior (una
//     clase cuyo tema lo menciona se omite).
//   · Nivel con la regla única de lib/effectiveLevel.ts.
//   · Si falta un dato, su línea NO aparece (nada de "N/A" ni guiones).
//
// La carga (cargarFichaAlumnoWith) NUNCA lanza: lo que no se puede leer se
// omite. El resto es puro.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignedSlot } from '@/types';
import { effectiveLevelOf, LEVEL_ORIGIN_LABEL } from '@/lib/effectiveLevel';
import { sesionesDeSlots } from '@/lib/cambioHorario/sesiones';
import { hourNum, hourText } from '@/lib/sessions';
import { PUBLIC_APP_URL } from '@/lib/appUrl';

type Db = SupabaseClient;

export interface PerfilFicha {
  ocupacion: string | null;
  objetivoPersonal: string | null;
  puntosFuertes: string | null;
  puntosDebiles: string | null;
  estiloAprendizaje: string | null;
  focoRecomendado: string | null;
}

export interface FichaAlumnoNuevo {
  studentId: string | null;
  nombre: string;
  email: string | null;
  /** "B1 (de la prueba de nivel)". Null si ninguna fuente trae un CEFR. */
  nivel: string | null;
  objetivo: string | null;
  plan: string | null;
  horasSemanales: number | null;
  /** Sus horarios nuevos, una entrada por sesión ("Lunes 10:00 - 12:00"). */
  horarios: string[];
  perfil: PerfilFicha;
  /** Sus últimas clases analizadas (como mucho 3), de la más reciente a la más antigua. */
  ultimasClases: Array<{ fecha: string; tema: string }>;
  /** Ficha del alumno en Gestión. */
  enlace: string;
}

export const MAX_CLASES_FICHA = 3;
const MAX_TEMA = 140;

const limpio = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s || null;
};

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** ¿El texto nombra a esa persona (nombre completo o nombre de pila de 3+ letras, como palabra)? */
export function mencionaA(texto: string, persona: string | null | undefined): boolean {
  const t = sinTildes(texto);
  const p = sinTildes((persona ?? '').trim());
  if (!p) return false;
  const pila = p.split(/\s+/)[0];
  const palabras = [p, ...(pila.length >= 3 ? [pila] : [])];
  return palabras.some(w => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(t));
}

/** "Lunes 10:00 - 12:00" por sesión (horas seguidas del mismo día). */
export function horariosDeSlots(slots: AssignedSlot[]): string[] {
  return sesionesDeSlots(slots).map(s => `${s.dia} ${s.hora} - ${hourText(hourNum(s.hora) + s.duracion)}`);
}

/** Fecha legible en España: "12 de octubre de 2026". Vacío si no se entiende. */
export function fechaLarga(isoOFecha: string | null | undefined): string {
  if (!isoOFecha) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(isoOFecha) ? `${isoOFecha}T12:00:00Z` : isoOFecha);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
}

const recorta = (s: string): string => {
  if (s.length <= MAX_TEMA) return s;
  const corte = s.slice(0, MAX_TEMA);
  return `${corte.slice(0, Math.max(corte.lastIndexOf(' '), MAX_TEMA - 20)).replace(/[\s,;.:]+$/, '')}…`;
};

// ── Construcción (pura) ───────────────────────────────────────────────────────

export interface FilaPerfil {
  teacher_confirmed_level?: string | null;
  current_level?: string | null;
  level_test_cefr?: string | null;
  occupation?: string | null;
  personal_objective?: string | null;
  strong_points?: string | null;
  weak_points?: string | null;
  learning_style?: string | null;
  recommended_focus?: string | null;
}

export interface FilaAnalisis {
  class_date?: string | null;
  analyzed_at?: string | null;
  class_title?: string | null;
  topics_covered?: string | null;
  analysis_status?: string | null;
}

export interface DatosFicha {
  studentId: string | null;
  nombre: string;
  email?: string | null;
  /** assignments.student_level */
  nivelAlta?: string | null;
  /** assignments.objetivo */
  objetivo?: string | null;
  plan?: string | null;
  /** Horarios con el profesor nuevo. */
  slots: AssignedSlot[];
  perfil?: FilaPerfil | null;
  analisis?: FilaAnalisis[];
  /** Para que su nombre no aparezca en la ficha. */
  profesorAnterior?: string | null;
  /** Base de los enlaces (por defecto PUBLIC_APP_URL). */
  base?: string;
}

export function construirFicha(d: DatosFicha): FichaAlumnoNuevo {
  const eff = effectiveLevelOf(d.perfil ?? null, d.nivelAlta ?? null);
  const nivel = eff.level && eff.origin ? `${eff.level} (${LEVEL_ORIGIN_LABEL[eff.origin]})` : null;
  const pf = d.perfil ?? {};

  const ultimasClases = (d.analisis ?? [])
    // Solo análisis terminados ('ready'; null = filas anteriores a la columna).
    .filter(a => a.analysis_status == null || a.analysis_status === 'ready')
    .map(a => ({ cuando: limpio(a.class_date) ?? limpio(a.analyzed_at), tema: limpio(a.class_title) ?? limpio(a.topics_covered) }))
    .filter((a): a is { cuando: string; tema: string } => !!a.cuando && !!a.tema && !mencionaA(a.tema, d.profesorAnterior))
    .sort((a, b) => b.cuando.localeCompare(a.cuando))
    .slice(0, MAX_CLASES_FICHA)
    .map(a => ({ fecha: fechaLarga(a.cuando), tema: recorta(a.tema) }))
    .filter(a => a.fecha);

  const base = (d.base ?? PUBLIC_APP_URL).replace(/\/+$/, '');
  return {
    studentId: d.studentId,
    nombre: d.nombre,
    email: limpio(d.email),
    nivel,
    objetivo: limpio(d.objetivo),
    plan: limpio(d.plan),
    horasSemanales: d.slots.length || null,
    horarios: horariosDeSlots(d.slots),
    perfil: {
      ocupacion: limpio(pf.occupation),
      objetivoPersonal: limpio(pf.personal_objective),
      puntosFuertes: limpio(pf.strong_points),
      puntosDebiles: limpio(pf.weak_points),
      estiloAprendizaje: limpio(pf.learning_style),
      focoRecomendado: limpio(pf.recommended_focus),
    },
    ultimasClases,
    enlace: d.studentId ? `${base}/mis-alumnos/${encodeURIComponent(d.studentId)}` : `${base}/mis-alumnos`,
  };
}

/** Las líneas que se muestran, SIN las vacías. La usan el correo y la campanita. */
export function lineasFicha(f: FichaAlumnoNuevo): {
  datos: Array<[string, string]>;
  perfil: Array<[string, string]>;
  clases: string[];
} {
  const solo = (xs: Array<[string, string | null]>) => xs.filter((x): x is [string, string] => !!x[1]);
  return {
    datos: solo([
      ['Alumno', f.nombre],
      ['Nivel', f.nivel],
      ['Objetivo', f.objetivo],
      ['Plan', f.plan],
      ['Horas semanales', f.horasSemanales ? `${f.horasSemanales} h` : null],
      ['Horarios', f.horarios.length ? f.horarios.join(' · ') : null],
      ['Email de contacto', f.email],
    ]),
    perfil: solo([
      ['Ocupación', f.perfil.ocupacion],
      ['Objetivo personal', f.perfil.objetivoPersonal],
      ['Puntos fuertes', f.perfil.puntosFuertes],
      ['Puntos débiles', f.perfil.puntosDebiles],
      ['Estilo de aprendizaje', f.perfil.estiloAprendizaje],
      ['Foco recomendado', f.perfil.focoRecomendado],
    ]),
    clases: f.ultimasClases.map(c => `${c.fecha}: ${c.tema}`),
  };
}

/** Texto del aviso de la campanita. Empieza por el nombre para que el panel lo enlace con su asignación. */
export function textoCampanita(f: FichaAlumnoNuevo): string {
  const resumen = [
    f.nivel ? `nivel ${f.nivel}` : null,
    f.horasSemanales ? `${f.horasSemanales} h por semana` : null,
    f.horarios.length ? f.horarios.join(', ') : null,
  ].filter(Boolean).join(' · ');
  return [
    `Se incorpora a tus clases ${f.nombre}${resumen ? ` (${resumen})` : ''}.`,
    f.objetivo ? `Objetivo: ${f.objetivo}.` : null,
    'Tienes su ficha en tu correo y en Alumnos.',
    `Recuerda presentarte por correo electrónico${f.email ? ` (${f.email})` : ''} antes de la primera clase.`,
  ].filter(Boolean).join(' ').replace(/\.\./g, '.');
}

/**
 * La ficha tal como llega a /api/emails desde el navegador (modal del panel):
 * solo los campos esperados y con su tipo, o null si no es una ficha. El enlace
 * NO se acepta de fuera: se rehace con el studentId.
 */
export function fichaRecibida(v: unknown): FichaAlumnoNuevo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const nombre = limpio(o.nombre);
  if (!nombre) return null;
  const perfil = (o.perfil && typeof o.perfil === 'object' ? o.perfil : {}) as Record<string, unknown>;
  const textos = (x: unknown) => (Array.isArray(x) ? x.map(limpio).filter((s): s is string => !!s) : []);
  const studentId = limpio(o.studentId);
  return {
    studentId,
    nombre,
    email: limpio(o.email),
    nivel: limpio(o.nivel),
    objetivo: limpio(o.objetivo),
    plan: limpio(o.plan),
    horasSemanales: typeof o.horasSemanales === 'number' && o.horasSemanales > 0 ? o.horasSemanales : null,
    horarios: textos(o.horarios),
    perfil: {
      ocupacion: limpio(perfil.ocupacion),
      objetivoPersonal: limpio(perfil.objetivoPersonal),
      puntosFuertes: limpio(perfil.puntosFuertes),
      puntosDebiles: limpio(perfil.puntosDebiles),
      estiloAprendizaje: limpio(perfil.estiloAprendizaje),
      focoRecomendado: limpio(perfil.focoRecomendado),
    },
    ultimasClases: (Array.isArray(o.ultimasClases) ? o.ultimasClases : [])
      .map(c => (c && typeof c === 'object' ? { fecha: limpio((c as Record<string, unknown>).fecha), tema: limpio((c as Record<string, unknown>).tema) } : null))
      .filter((c): c is { fecha: string; tema: string } => !!c?.fecha && !!c.tema)
      .slice(0, MAX_CLASES_FICHA),
    enlace: studentId ? `${PUBLIC_APP_URL}/mis-alumnos/${encodeURIComponent(studentId)}` : `${PUBLIC_APP_URL}/mis-alumnos`,
  };
}

// ── Carga (cliente inyectado; nunca lanza) ────────────────────────────────────

const COLS_PERFIL = 'occupation, personal_objective, strong_points, weak_points, learning_style, recommended_focus, current_level, level_test_cefr';

async function leerPerfil(db: Db, studentId: string | null, nombre: string): Promise<FilaPerfil | null> {
  const leer = async (cols: string) => {
    const q = db.from('student_profiles').select(cols);
    const filtrada = studentId ? q.eq('student_id', studentId) : q.ilike('student_name', nombre.trim());
    return filtrada.order('updated_at', { ascending: false }).limit(1).maybeSingle();
  };
  try {
    // teacher_confirmed_level llega con supabase-teacher-level.sql: sin ella, se reintenta sin la columna.
    let r = await leer(`${COLS_PERFIL}, teacher_confirmed_level`);
    if (r.error) r = await leer(COLS_PERFIL);
    if (r.error) { console.warn('[fichaAlumnoNuevo] sin perfil:', r.error.message); return null; }
    return (r.data as FilaPerfil | null) ?? null;
  } catch (err) {
    console.warn('[fichaAlumnoNuevo] sin perfil:', err);
    return null;
  }
}

async function leerAnalisis(db: Db, studentId: string | null): Promise<FilaAnalisis[]> {
  if (!studentId) return [];
  try {
    const { data, error } = await db.from('class_analyses')
      .select('class_date, analyzed_at, class_title, topics_covered, analysis_status')
      .eq('student_id', studentId).order('analyzed_at', { ascending: false }).limit(20);
    if (error) { console.warn('[fichaAlumnoNuevo] sin clases analizadas:', error.message); return []; }
    return (data ?? []) as FilaAnalisis[];
  } catch (err) {
    console.warn('[fichaAlumnoNuevo] sin clases analizadas:', err);
    return [];
  }
}

/** Lee el perfil y las últimas clases analizadas y construye la ficha. */
export async function cargarFichaAlumnoWith(db: Db, d: Omit<DatosFicha, 'perfil' | 'analisis'>): Promise<FichaAlumnoNuevo> {
  const [perfil, analisis] = await Promise.all([leerPerfil(db, d.studentId, d.nombre), leerAnalisis(db, d.studentId)]);
  return construirFicha({ ...d, perfil, analisis });
}
