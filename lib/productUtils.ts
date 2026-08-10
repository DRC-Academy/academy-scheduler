// Detección de horas semanales a partir de la información del producto de
// WooCommerce (variaciones, meta_data, nombre) + tabla de mapeo fijo.

import { supabase } from '@/lib/supabase';

// ── Clasificación de plan (ÚNICA fuente de verdad) ────────────────────────────
export interface PlanClassification {
  type: 'examenes' | 'intensivo' | 'general';
  financeType: 'examenes' | 'general';
  badge: string;
  displayName: string;
}

/**
 * Quita tildes y pasa a minúsculas. IMPRESCINDIBLE antes de comparar: "Exámenes"
 * NO contiene la subcadena "examen" (la á es otro carácter), así que sin esto los
 * planes escritos con tilde — la mayoría — se clasificaban como generales y el
 * profesor cobraba la tarifa baja.
 */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// Palabras que identifican un plan de examen. Van con \b a ambos lados porque los
// códigos cortos aparecían DENTRO de palabras corrientes del texto libre de
// disponibilidad — "repetir", "competencia" — y clasificaban como examen (tarifa
// alta) a alumnos de inglés general.
const EXAM_RE = new RegExp(
  '\\b(' + [
    'examen(?:es)?', 'preparacion(?:es)?', 'certificad[oa]s?',
    'fce', 'ielts', 'aptis', 'cambridge',
    'first\\s+certificate', 'preliminary', 'advanced', 'proficiency',
  ].join('|') + ')\\b',
);

// "cae" y "pet" son a la vez códigos de examen de Cambridge y palabras españolas
// corrientes ("Cae bien el horario", "el alumno pet-ició"). Se exigen en
// MAYÚSCULAS sobre el texto SIN normalizar, que es como se escriben los exámenes.
const EXAM_CODE_RE = /\b(CAE|PET)\b/;

const INTENSIVO_RE = /\bintensivos?\b/;

export function classifyPlan(fields: {
  assignmentPlan?: string | null;
  assignmentObjetivo?: string | null;
  studentPlan?: string | null;
  productName?: string | null;
}): PlanClassification {
  const rawText = Object.values(fields).filter(Boolean).join(' ');
  const allText = normalizeText(rawText);

  const isExamen = EXAM_RE.test(allText) || EXAM_CODE_RE.test(rawText);
  const isIntensivo = INTENSIVO_RE.test(allText);

  if (isExamen)                return { type: 'examenes',  financeType: 'examenes', badge: '📝 Exámenes',       displayName: 'Exámenes' };
  if (isIntensivo && !isExamen) return { type: 'intensivo', financeType: 'general',  badge: '⚡ Intensivo',      displayName: 'Intensivo' };
  return                              { type: 'general',    financeType: 'general',  badge: '💬 Inglés general', displayName: 'Inglés general' };
}

// ── Campos de clasificación (USAR SIEMPRE ESTO) ───────────────────────────────
//
// classifyPlan es una sola función, pero antes cada pantalla le pasaba un
// SUBCONJUNTO distinto de campos: finanzas cobraba con los 4, la columna "Plan"
// de esa misma tabla clasificaba con 2, y 41 de 183 assignments daban categorías
// diferentes. El admin veía "Inglés general" en una celda y tarifa de exámenes en
// la de al lado. Estos helpers arman el objeto completo una sola vez.
//
// NO llamar a classifyPlan con campos sueltos: usar classifyFor / planFieldsOf.

export interface PlanAssignmentLike { plan?: string | null; objetivo?: string | null }
export interface PlanStudentLike { plan?: string | null; productName?: string | null }

/** Los 4 campos que alimentan la clasificación, a partir de assignment + alumno. */
export function planFieldsOf(
  assignment?: PlanAssignmentLike | null,
  student?: PlanStudentLike | null,
) {
  return {
    assignmentPlan:     assignment?.plan ?? null,
    assignmentObjetivo: assignment?.objetivo ?? null,
    studentPlan:        student?.plan ?? null,
    productName:        student?.productName ?? null,
  };
}

/** Clasificación de un alumno con TODOS los campos disponibles. */
export function classifyFor(
  assignment?: PlanAssignmentLike | null,
  student?: PlanStudentLike | null,
): PlanClassification {
  return classifyPlan(planFieldsOf(assignment, student));
}

// ── Detección de nivel (A1–C2) ────────────────────────────────────────────────
// Deriva el nivel del alumno desde el nombre/variación del producto WooCommerce
// y, con prioridad, desde el meta_data de la orden. Devuelve null si no se detecta
// (el setter lo completa manualmente).
//
// Orden IMPORTANTE: los niveles más altos/específicos van primero para que
// "upper-intermediate" caiga en B2 (por "upper") antes que en B1 ("intermediate").
const LEVEL_PATTERNS: Array<{ level: string; keywords: string[] }> = [
  { level: 'C2', keywords: ['c2', 'cpe', 'proficiency'] },
  { level: 'C1', keywords: ['c1', 'cae', 'advanced', 'avanzado'] },
  { level: 'B2', keywords: ['b2', 'fce', 'first', 'upper-intermediate', 'upper'] },
  { level: 'B1', keywords: ['b1', 'pet', 'preliminary', 'intermediate', 'intermedio'] },
  { level: 'A2', keywords: ['a2', 'elementary', 'basico', 'básico'] },
  { level: 'A1', keywords: ['a1', 'beginner', 'principiante'] },
];

// Match tolerante: los códigos de nivel (a1, b2…) exigen límites de palabra para
// no matchear dentro de otra palabra; el resto usa "contiene".
function hasLevelToken(text: string, kw: string): boolean {
  if (/^[abc][12]$/.test(kw)) return new RegExp(`\\b${kw}\\b`, 'i').test(text);
  return text.includes(kw);
}

function matchLevel(text?: string | null): string | null {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return null;
  for (const { level, keywords } of LEVEL_PATTERNS) {
    if (keywords.some(kw => hasLevelToken(t, kw))) return level;
  }
  return null;
}

export function detectLevel(productFullName?: string | null, metaData?: any[] | null): string | null {
  // PRIORIDAD 1 — meta_data de WooCommerce (campo nivel/level/pa_nivel).
  if (Array.isArray(metaData)) {
    for (const m of metaData) {
      const key = String(m?.key ?? m?.display_key ?? '').toLowerCase();
      if (key.includes('nivel') || key.includes('level')) {
        const fromMeta = matchLevel(String(m?.display_value ?? m?.value ?? ''));
        if (fromMeta) return fromMeta;
      }
    }
  }
  // PRIORIDAD 2 — nombre del producto + variación (regex).
  return matchLevel(productFullName);
}

// ── Planes de EMPRESA (pago único con duración en meses) ─────────────────────
//
// Los productos "Empresas *" son de PAGO ÚNICO y su variación lleva la duración
// contratada ("B1 · 1h semanal · 6 Meses"). WooCommerce no gestiona vencimiento
// para un pago único: el alumno compra y listo. Hasta ahora el admin los activaba
// a mano con `manual_active_until`, con el resultado previsible de que alguno se
// quedaba sin activar (María José Cabrera: 6 meses comprados, 0 días de acceso).
//
// Estas funciones son PURAS y se usan desde tres sitios que no pueden discrepar:
// /api/check-subscription (al leer el pedido), /api/admin/sync-company-plans
// (regularización masiva) y, el día que exista, el webhook de compra nueva.

/**
 * DOBLE FILTRO, primera mitad: ¿es un producto de empresa?
 *
 * Se evalúa SOLO contra el nombre del producto (`line_items[0].name`), NUNCA
 * contra el nombre completo con variación. La variación incluye respuestas de
 * texto libre del cliente ("Todos los dias", "20h", "-"), así que alguien que
 * escribiera "en la empresa" en su horario preferido activaría el cálculo de
 * meses sobre un producto que no es de empresa.
 *
 * OJO con `students.product_name`: según qué endpoint lo escribió, guarda el
 * nombre a secas o el nombre CON la variación pegada (check-subscription escribe
 * `rich.fullName`, sync-student-plans escribe `prod.productName`). Por eso quien
 * lea de la base tiene que quedarse con lo anterior al guion largo — para eso
 * está `baseProductName`.
 */
const COMPANY_RE = /\bempresas?\b/;

export function isCompanyProduct(productName?: string | null): boolean {
  return COMPANY_RE.test(normalizeText(productName ?? ''));
}

/** "Empresas Ingles General — B1 · 6 Meses" → "Empresas Ingles General". */
export function baseProductName(fullName?: string | null): string {
  const raw = (fullName ?? '').trim();
  return raw.split('—')[0].trim() || raw;
}

/** Techo de duración aceptada. Fuera de 1–24 se considera un falso positivo. */
const MAX_PLAN_MONTHS = 24;

// El número tiene que ir PEGADO a "mes": es lo único que distingue la duración
// del resto de números de la variación ("2h semanales", "20h", el nivel "B1").
//
// El `\b` final es la pieza que evita el falso positivo real que hay en la base:
// el producto "Plan mensual Niños - 1h semanal" contiene "mens", y sin el límite
// de palabra "1h semanal" de un plan mensual se leería como una duración.
//
// Se usa `\b` y no un lookbehind `(?<!\d)` a propósito: este módulo también corre
// en el navegador del profesor, y el lookbehind no existe en Safari < 16.4.
const MONTHS_RE = /\b(\d{1,2})\s*mes(?:es)?\b/;
// "1 Año" → 12. Sobre texto normalizado: normalizeText descompone la ñ y le quita
// la tilde, así que "Año" llega como "ano".
const YEARS_RE = /\b(\d{1,2})\s*an[o]s?\b/;

/**
 * Duración en meses escrita en un texto (el nombre de la variación).
 *
 * "3 Meses" → 3 · "6 meses" → 6 · "1 mes" → 1 · "12 Meses" → 12 · "1 Año" → 12
 * "mensual" → null · "2h semanales" → null · "B1 · 20h" → null
 *
 * null = no hay duración detectable. NO es un plan con fecha de fin calculable.
 */
export function parseMonthsFromText(text?: string | null): number | null {
  if (!text) return null;
  const t = normalizeText(String(text));

  const m = MONTHS_RE.exec(t);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= MAX_PLAN_MONTHS) return n;
  }
  const y = YEARS_RE.exec(t);
  if (y) {
    const n = parseInt(y[1], 10) * 12;
    if (n >= 1 && n <= MAX_PLAN_MONTHS) return n;
  }
  return null;
}

/**
 * Suma de meses de CALENDARIO sobre una fecha 'YYYY-MM-DD'.
 *
 * "6 meses" cae el mismo día seis meses después, no 180 días después. Cuando el
 * día no existe en el mes destino (31/01 + 1 mes) se recorta al último día del
 * mes, que es el criterio de toda la vida para vencimientos.
 *
 * Aritmética en UTC: son fechas de calendario, no instantes, y hacerla en la zona
 * del servidor haría que un pedido del día 1 saltara al mes anterior.
 */
export function addCalendarMonths(iso: string, months: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? '').slice(0, 10));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  // Día 0 del mes siguiente al destino = último día del mes destino.
  const lastDay = new Date(Date.UTC(y, mo + months + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(y, mo + months, Math.min(d, lastDay)));
  return isNaN(end.getTime()) ? null : end.toISOString().slice(0, 10);
}

export interface CompanyPlan {
  months: number;
  /** 'YYYY-MM-DD' — fecha del pedido de WooCommerce. */
  start: string;
  /** 'YYYY-MM-DD' — start + months, último día de acceso INCLUIDO. */
  until: string;
}

/**
 * DOBLE FILTRO completo. Devuelve el plan de empresa con su fecha de fin, o null.
 *
 * null si falla CUALQUIERA de las tres condiciones: que el producto sea de
 * empresa, que la variación diga cuántos meses, y que el pedido tenga fecha. Un
 * producto que no es de empresa no llega nunca al parseo de meses, aunque su
 * nombre los lleve.
 */
export function detectCompanyPlan(args: {
  productName?: string | null;
  productVariation?: string | null;
  orderDate?: string | null;
}): CompanyPlan | null {
  if (!isCompanyProduct(baseProductName(args.productName))) return null;

  const months = parseMonthsFromText(args.productVariation);
  if (months == null) return null;

  const start = (args.orderDate ?? '').slice(0, 10);
  const until = addCalendarMonths(start, months);
  if (!until) return null;

  return { months, start, until };
}

/**
 * Qué hacer con la fecha calculada frente a la que ya tiene el alumno.
 *
 * CRITERIO "NUNCA RECORTA". La automática no puede quitarle acceso a nadie: en
 * los datos reales cuatro alumnos de empresa tenían margen puesto a mano (hasta
 * +14 días sobre la fecha del plan), y pisarlo les habría cortado dos semanas de
 * clases pagadas. Si la calculada es ANTERIOR a una fecha vigente, se respeta la
 * de la persona y solo se registra el plan detectado.
 */
export type CompanyPlanAction = 'set' | 'extend' | 'keep_manual' | 'unchanged';

export interface CompanyPlanDecision {
  action: CompanyPlanAction;
  /** Fecha con la que queda el alumno (escriba o no). */
  until: string;
  /** ¿Hay que escribir `manual_active_until`? */
  writes: boolean;
  reason: string;
}

export function resolveCompanyPlanUpdate(
  computedUntil: string,
  currentUntil: string | null | undefined,
  today: string,
): CompanyPlanDecision {
  const current = (currentUntil ?? '').slice(0, 10).trim();

  if (!current) {
    return { action: 'set', until: computedUntil, writes: true, reason: 'no tenía fecha de acceso' };
  }
  if (current === computedUntil) {
    return { action: 'unchanged', until: current, writes: false, reason: 'ya coincide con el plan' };
  }
  // Vencida: no hay acceso que recortar, la calculada manda (típico de una
  // renovación detectada tarde).
  if (current < today) {
    return { action: 'set', until: computedUntil, writes: true, reason: `la anterior (${current}) ya estaba vencida` };
  }
  if (computedUntil > current) {
    return { action: 'extend', until: computedUntil, writes: true, reason: `renovación: extiende desde ${current}` };
  }
  return { action: 'keep_manual', until: current, writes: false, reason: `margen manual vigente hasta ${current}; el plan terminaba el ${computedUntil}` };
}

// Estilo del badge de categoría según el tipo clasificado.
export function planBadgeStyle(type: PlanClassification['type']): { color: string; bg: string } {
  switch (type) {
    case 'examenes':  return { color: '#2563eb', bg: 'rgba(37,99,235,0.1)' };
    case 'intensivo': return { color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
    default:          return { color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
  }
}

export interface DetectionResult {
  hours: number | null;
  method: 'api' | 'regex_variation' | 'regex_name' | 'mapping' | 'manual';
  confidence: 'high' | 'low';
  source: string;
  message: string;
}

// Extrae un número de horas semanales de un texto libre. Soporta:
// "2 horas", "2h", "2 hs", "2-horas-semanales", "2h/semana", "2h semanales",
// "2 clases". Devuelve null si no encuentra un patrón válido (1–12).
export function parseHoursFromText(text?: string | null): number | null {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const patterns = [
    /(\d+)\s*-?\s*(?:horas?|hs?|hrs?|clases?)\b/,   // "2 horas", "2h", "2-horas", "2 clases"
    /(\d+)\s*-?\s*h\s*\/?\s*seman/,                 // "2h/semana", "2h semana"
    /(\d+)\s*-?\s*horas?\s*-?\s*seman/,             // "2-horas-semanales"
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 12) return n;
    }
  }
  return null;
}

// Busca horas en el meta_data de un line_item (en keys y en values/display_values).
export function parseHoursFromMeta(metaData?: any[] | null): number | null {
  if (!Array.isArray(metaData)) return null;
  const KEY_HINTS = ['hora', 'horas', 'sessions', 'clases', 'semanal'];
  for (const meta of metaData) {
    const key = String(meta?.key ?? meta?.display_key ?? '').toLowerCase();
    const val = String(meta?.display_value ?? meta?.value ?? '');
    // Si el key sugiere horas, intentamos parsear su valor directamente.
    if (KEY_HINTS.some(h => key.includes(h))) {
      const n = parseHoursFromText(val) ?? (/^\s*\d+\s*$/.test(val) ? parseInt(val, 10) : null);
      if (n && n >= 1 && n <= 12) return n;
    }
    // Si no, buscamos el patrón directamente en el valor.
    const n = parseHoursFromText(val);
    if (n) return n;
  }
  return null;
}

// Cascada de detección (pasos 1–6 del spec).
export async function detectWeeklyHours(
  productName: string,
  productVariation: string | null,
  metaData: any[] | null,
  hoursFromApi: number | null,
): Promise<DetectionResult> {
  const name = productName ?? '';
  const fullName = productVariation ? `${name} — ${productVariation}` : name;

  // PASO 1 — horas ya detectadas por el endpoint (variaciones / meta_data).
  if (hoursFromApi != null) {
    return {
      hours: hoursFromApi, method: 'api', confidence: 'high',
      source: 'Variación del producto en WooCommerce',
      message: '✅ Detectado desde las variaciones del producto',
    };
  }

  // PASO 2 — regex en la variación.
  if (productVariation) {
    const h = parseHoursFromText(productVariation);
    if (h != null) {
      return {
        hours: h, method: 'regex_variation', confidence: 'high',
        source: `Nombre de la variación: ${productVariation}`,
        message: '✅ Detectado desde la variación del producto',
      };
    }
  }

  // PASO 2.5 — meta_data (por si el endpoint no lo extrajo).
  const hMeta = parseHoursFromMeta(metaData);
  if (hMeta != null) {
    return {
      hours: hMeta, method: 'regex_variation', confidence: 'high',
      source: 'Metadatos del producto en WooCommerce',
      message: '✅ Detectado desde los datos del producto',
    };
  }

  // PASO 3 — regex en el nombre del producto.
  const hName = parseHoursFromText(name);
  if (hName != null) {
    return {
      hours: hName, method: 'regex_name', confidence: 'high',
      source: `Nombre del producto: ${name}`,
      message: '✅ Detectado desde el nombre del producto',
    };
  }

  // PASO 4 — tabla de mapeo fijo (product_mappings).
  try {
    const { data } = await supabase.from('product_mappings').select('*');
    const haystack = `${name} ${fullName}`.toLowerCase();
    for (const m of (data ?? []) as any[]) {
      const needle = String(m?.product_name_contains ?? '').trim().toLowerCase();
      const hrs = Number(m?.weekly_hours);
      if (needle && haystack.includes(needle) && hrs >= 1) {
        return {
          hours: hrs, method: 'mapping', confidence: 'high',
          source: `Mapeo interno: ${name}`,
          message: `✅ Detectado por tipo de producto (${m.product_name_contains} ${hrs}h/sem)`,
        };
      }
    }
  } catch { /* sin mapeo → seguimos */ }

  // PASO 5 — producto de empresa (siempre manual).
  if (name.toLowerCase().includes('empresa')) {
    return {
      hours: null, method: 'manual', confidence: 'low',
      source: 'Producto de empresa',
      message: '📋 Producto de empresa — las horas varían según lo acordado. Completá el campo manualmente.',
    };
  }

  // PASO 6 — no detectado.
  return {
    hours: null, method: 'manual', confidence: 'low',
    source: 'No detectado',
    message: '⚠️ No pudimos detectar las horas automáticamente. Completá el campo manualmente.',
  };
}
