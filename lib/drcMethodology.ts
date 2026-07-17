// ── Metodología de enseñanza de inglés general ────────────────────────────────
// FUENTE ÚNICA de la metodología (avatares + proceso Programa→Bloque→Clase) que
// se inyecta en los prompts de la IA. Traduce el documento de metodología y el
// banco de avatares a texto consultable por el modelo.
//
// Alcance: EXCLUSIVAMENTE inglés general (no preparación de exámenes formales).
//
// Matices que NO deben perderse al editar:
//   · Objetivos ACUMULATIVOS vs por sesión: "descubrimiento inductivo" y
//     "pensamiento en inglés" se logran a lo largo de muchas clases; una clase
//     suelta NO tiene que cumplirlos por completo.
//   · Reglas DURAS vs herramientas: los estándares de formato y los 6 errores son
//     no-negociables; otras cosas (ejercicios tradicionales en fase de input,
//     preferir conversación guiada) son OPCIONES a criterio del profesor.

import type { AvatarDomain, ClassType, CEFRLevel } from '@/lib/aiTypes';

// Normaliza "B1", "b1 exámenes", "Nivel A2", etc. → nivel CEFR. Default B1.
export function normalizeLevel(raw?: string | null): CEFRLevel {
  const m = (raw ?? '').toUpperCase().match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  if (!m) return 'B1';
  return m[1] === 'C2' ? 'C1' : (m[1] as CEFRLevel);   // C2 se trata como C1 (tope del banco)
}

// Tipos de clase viables por nivel. A1/A2 solo metodología aplicada; B1+ ambos.
// Educacional (menores) SIEMPRE metodología aplicada, sin excepción.
export function viableClassTypes(level: CEFRLevel, domain: AvatarDomain): ClassType[] {
  if (domain === 'educacional') return ['metodologia_aplicada'];
  return level === 'A1' || level === 'A2'
    ? ['metodologia_aplicada']
    : ['metodologia_aplicada', 'conversacion_guiada'];
}

// Balance de secuencia (input → práctica guiada → producción) por nivel, y foco
// priorizado. Redactado como guía para el modelo, fiel al banco de avatares.
const SEQUENCE_BALANCE: Record<CEFRLevel, string> = {
  A1: 'Único tipo viable: metodología aplicada. Foco: competencias comunicativas básicas organizadas por FUNCIÓN (saludar, describir personas, expresar estados de ánimo, responder cómo está). La gramática está siempre presente como base, pero acotada a lo que cada función puntual requiere. Secuencia: input, práctica y producción se EXTIENDEN todas en tiempo, sin que ninguna se acentúe sobre otra.',
  A2: 'Único tipo viable: metodología aplicada. Foco: automatización (producir oraciones simples sin trabarse) y pensamiento en inglés a complejidad básica (tópicos simples, poca variación de formalidad, tiempos elementales). Secuencia: MÁS tiempo de input/exposición antes de pasar a producción, respecto a niveles superiores.',
  B1: 'Viable metodología aplicada y también conversación guiada. Foco: pensamiento en inglés y comunicación integrados, con más complejidad que A2 (más variedad de tópicos, más matices de formalidad, mayor rango de tiempos verbales, más trabajo con frases idiomáticas frente a la traducción directa del español). Secuencia (metodología aplicada): se ESTIRA la práctica guiada (reflexión/transformación) en proporción al input, a diferencia de A2.',
  B2: 'Viable metodología aplicada y también conversación guiada. Foco: aprendizaje significativo y pensamiento en inglés con más matices, ambos con peso equivalente. Secuencia (metodología aplicada): input BAJO (el mínimo necesario); práctica guiada y producción libre con peso equivalente entre sí, pero la práctica sigue siendo prioritaria sobre el input.',
  C1: 'Viable metodología aplicada y también conversación guiada. Foco: vocabulario avanzado con expresiones formales y sociales + pensamiento en inglés (mismo foco que B2, con mayor sofisticación). Secuencia (metodología aplicada): igual que B2 — input bajo, práctica guiada y producción libre equivalentes, con la práctica como prioritaria.',
};

// Filosofía y objetivos de fondo, comunes a todo avatar.
export const METHODOLOGY_CORE = `METODOLOGÍA (inglés general):
- Centrado en el alumno: el material se ancla en su contexto real (trabajo, intereses, objetivos).
- De input a producción: primero comprensión en contexto, luego speaking/writing.
- Descubrimiento inductivo: se muestran ejemplos en contexto y el alumno descubre el patrón.

OBJETIVOS ACUMULATIVOS (no por sesión): "descubrimiento inductivo" y "pensamiento en inglés" son metas que se construyen A LO LARGO DE MUCHAS CLASES. Una clase suelta NO tiene que lograrlos por completo: aporta su parte según el nivel y el momento del programa. No fuerces inductivo puro ni conversación total en una clase donde no corresponde.

REGLAS DURAS vs HERRAMIENTAS:
- Duras (siempre): los estándares de formato y los 6 errores frecuentes de más abajo.
- Herramientas (a criterio, no obligatorias): los ejercicios tradicionales son válidos cuando se necesita una progresión más escalada, especialmente en la fase de input; la conversación guiada se prefiere si surge naturalmente pero no se impone.`;

// Estándares de formato del MATERIAL DE CLASE (lo que el alumno ve). Reglas duras.
export const FORMAT_STANDARDS = `ESTÁNDARES DE FORMATO DEL MATERIAL (el alumno lo lee durante la clase; copy-paste ready):
- Títulos motivadores, con emojis.
- Instrucciones claras y directas, dirigidas al alumno en SEGUNDA persona ("Vas a...", "Usá..."). Nunca en tercera persona ("El alumno deberá...").
- Vocabulario SIEMPRE en contexto (texto, diálogo, caso real), nunca como lista suelta.
- Gramática presentada a través de ejemplos en contexto para que el alumno descubra el patrón; las reglas básicas necesarias y las excepciones SÍ se explican directamente cuando corresponde (la prohibición es sobre la extensión y el momento, no sobre que exista explicación).
- SIN notas internas ("Nota para el profesor: ..."). SIN answer keys ni respuestas dentro del material.`;

// Los 6 errores frecuentes (incorrecto → correcto). Reglas duras.
export const COMMON_ERRORS = `ERRORES A EVITAR (chequeo rápido antes de entregar):
1. Listas de vocabulario sueltas (ej. "Deadline, Meeting, Report..."). → Presentar el vocabulario dentro de un texto/diálogo/caso y pedir que identifique las palabras de una categoría.
2. Answer keys / respuestas correctas con explicación después de un ejercicio. → Prohibido: es una nota interna dentro de material del alumno.
3. Ejercicios mecánicos excesivos sin contexto (series de "fill in the blank" desconectadas). → Transformar situaciones reales del alumno en la consigna. (Ejercicios tradicionales SÍ se permiten para escalar la progresión, sobre todo en input; eso no es lo mismo que un ejercicio mecánico sin propósito.)
4. Hablar del alumno en tercera persona ("El alumno practicará...", "David debería..."). → Siempre segunda persona directa ("Vas a practicar...", "Usá esto en tu próxima reunión...").
5. Explicaciones metalingüísticas extensas antes de que el alumno use la estructura. → Mostrar ejemplos en contexto y dejar que descubra el patrón; explicar solo lo básico necesario, en el momento justo.
6. Warm-ups genéricos o infantiles ("¿Cuál es tu color favorito?" a un adulto). → Preguntas conversacionales relevantes a la vida real y adulta del alumno.`;

// Cómo funciona la conversación guiada (B1+). Se inyecta solo en ese modo.
export const CONVERSACION_GUIADA_MECANICA = `MODO CONVERSACIÓN GUIADA:
- No hay fases visibles de input/práctica/producción: es un formato conversacional continuo, con corrección y preguntas dirigidas en vez de estructura explícita.
- El profesor entra con un OBJETIVO/HABILIDAD preparado de antemano (tomado de la lista de prioridades del diagnóstico del alumno, de más a menos importante), pero el TÓPICO lo determina el alumno. Si la charla gira a otro tema, la habilidad se mantiene y se readapta en tiempo real al nuevo tópico.
- No hay objetivo fijo predefinido por nivel: se elige de las prioridades del diagnóstico según el contexto de esa clase puntual.
- Se usa sobre todo con alumnos que piden "solo hablar" y no perciben valor en la clase estructurada.`;

// Nivel 2 del proceso: eje del bloque (gramatical temprano → temático en consolidación).
export const PROGRAM_PHASE = `FASE DEL PROGRAMA (eje del bloque):
- Fase temprana: el eje organizador es la ESTRUCTURA GRAMATICAL (ej. "present simple y continuous"). Se define primero por la gramática, y de ahí se deriva el vocabulario y las habilidades que esa gramática habilita.
- Fase de consolidación: una vez dominado lo básico, el eje pasa a ser un TÓPICO/tema relevante al alumno (ej. deportes), para poner en uso lo aprendido.
- El cambio de fase combina señal objetiva (dominio de lo básico según las clases previas) y criterio profesional. Es la misma lógica input→producción: a medida que avanza el nivel/fase, el peso se corre de estructura hacia uso libre.`;

export interface ResolvedAvatar {
  domain: AvatarDomain;
  level: CEFRLevel;
  classType: ClassType;
  viableTypes: ClassType[];
  sequenceBalance: string;
}

// Resuelve el avatar efectivo. Si el tipo pedido no es viable para el nivel/
// dominio, cae a metodología aplicada (el único siempre disponible).
export function resolveAvatar(args: {
  level?: string | null;
  domain?: AvatarDomain | null;
  requestedClassType?: ClassType | null;
}): ResolvedAvatar {
  const level = normalizeLevel(args.level);
  const domain = args.domain ?? 'social';
  const viableTypes = viableClassTypes(level, domain);
  const requested = args.requestedClassType ?? 'metodologia_aplicada';
  const classType = viableTypes.includes(requested) ? requested : 'metodologia_aplicada';
  return { domain, level, classType, viableTypes, sequenceBalance: SEQUENCE_BALANCE[level] };
}

const DOMAIN_LABEL: Record<AvatarDomain, string> = {
  social: 'Social', laboral: 'Laboral', educacional: 'Educacional (menores)',
};

// Bloque de texto con la guía del avatar, para inyectar en el prompt de clase.
export function buildAvatarBlock(a: ResolvedAvatar): string {
  const tipo = a.classType === 'conversacion_guiada' ? 'Conversación guiada' : 'Metodología aplicada';
  return `AVATAR DE ESTA CLASE — Dominio: ${DOMAIN_LABEL[a.domain]} · Nivel: ${a.level} · Tipo de clase: ${tipo}.

BALANCE DE SECUENCIA Y FOCO DEL NIVEL ${a.level}:
${a.sequenceBalance}`;
}
