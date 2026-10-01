// Testimoniales — análisis de FLUIDEZ del alumno con IA. SOLO SERVIDOR.
// Modelo: claude-haiku-4-5 (barato; ~1 céntimo por transcript).
//
// Va APARTE del análisis pedagógico con Opus (lib/analyzeTranscript), que ya va
// justo contra su timeout de 40 s: no comparten llamada, ni esquema, ni función
// de Vercel. Si esto falla, el informe de riesgo ni se entera.
//
// Solo mide CÓMO HABLA INGLÉS EL ALUMNO en esta clase: con una nota vieja y una
// reciente se buscan alumnos que pasaron de trabarse a hablar con soltura.

import 'server-only';   // llega al SDK de Anthropic vía askClaudeJson

import { askClaudeJson, type AiResult } from '@/lib/anthropic';

export const FLUENCY_MODEL = 'claude-haiku-4-5';

export type HesitationLevel = 'alta' | 'media' | 'baja';
export type SpanishUsage = 'mucho' | 'algo' | 'casi nada';

/** Lo que devuelve la IA, tal cual. `evaluable: false` → la nota se guarda como null. */
export interface FluencyIA {
  evaluable: boolean;
  unscorable_reason: string;
  fluency_score: number;
  student_talk_share: number;
  hesitation_level: HesitationLevel;
  spanish_usage: SpanishUsage;
  fluency_evidence: string;
  best_fluent_excerpt: string;
  best_fluent_at: string;
  worst_struggle_excerpt: string;
  worst_struggle_at: string;
}

// Sin nulls en el esquema: la marca `evaluable` decide y el código pone la nota a
// null. Los rangos van en la description (la API rechaza minimum/maximum).
const FLUENCY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'evaluable', 'unscorable_reason', 'fluency_score', 'student_talk_share',
    'hesitation_level', 'spanish_usage', 'fluency_evidence',
    'best_fluent_excerpt', 'best_fluent_at', 'worst_struggle_excerpt', 'worst_struggle_at',
  ],
  properties: {
    evaluable:          { type: 'boolean', description: 'false si no hay suficiente inglés hablado por el alumno para juzgar su fluidez (clase casi toda en español, el alumno apenas habla, no se distingue quién es el alumno).' },
    unscorable_reason:  { type: 'string',  description: 'Si evaluable es false, por qué, en una frase en español. Vacío si evaluable es true.' },
    fluency_score:      { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], description: 'Fluidez del INGLÉS HABLADO del alumno. 1 = se traba constantemente, frases sueltas o palabras aisladas. 10 = soltura, frases largas y completas sin apenas pausas. Si evaluable es false, pon 1 (se ignora).' },
    student_talk_share: { type: 'integer', description: 'Porcentaje aproximado, de 0 a 100, de lo hablado en la clase que corresponde al alumno (en cualquier idioma).' },
    hesitation_level:   { type: 'string',  enum: ['alta', 'media', 'baja'], description: 'Cuánto duda el alumno al hablar inglés: pausas, "eh", reformulaciones, frases que abandona.' },
    spanish_usage:      { type: 'string',  enum: ['mucho', 'algo', 'casi nada'], description: 'Cuánto se pasa el ALUMNO al español cuando debería hablar inglés.' },
    fluency_evidence:   { type: 'string',  description: 'UNA frase en español que justifique la nota, con algo concreto observado.' },
    best_fluent_excerpt:    { type: 'string', description: 'Cita LITERAL y corta (una o dos frases, copiadas exactamente del transcript) del alumno hablando inglés con más soltura. Vacío si evaluable es false.' },
    best_fluent_at:         { type: 'string', description: 'Minuto de esa cita, copiado del corchete de su turno, p. ej. "12:40". Vacío si no hay cita.' },
    worst_struggle_excerpt: { type: 'string', description: 'Cita LITERAL y corta (copiada exactamente del transcript) del alumno donde más se traba hablando inglés. Vacío si evaluable es false.' },
    worst_struggle_at:      { type: 'string', description: 'Minuto de esa cita, copiado del corchete de su turno, p. ej. "3:15". Vacío si no hay cita.' },
  },
} as const;

const SYSTEM_PROMPT = `Eres un evaluador de la FLUIDEZ ORAL EN INGLÉS de alumnos adultos hispanohablantes en clases particulares online. Recibes la transcripción automática de una clase (Fathom) y evalúas SOLO cómo habla inglés el ALUMNO en esta clase.

QUIÉN ES QUIÉN:
- Cada turno viene como "[minuto] ROL (nombre): texto". Si el rol está marcado como PROFE o ALUMNO, parte de ahí.
- Fathom A VECES SE EQUIVOCA DE PERSONA: pega al turno de uno frases que dijo el otro. Atribuye por el CONTENIDO. Una frase que corrige ("we say they are afraid"), explica gramática, da instrucciones ("go to page 30") o felicita ("good, perfect") es del profe aunque esté etiquetada como del alumno. No juzgues al alumno por frases que claramente no son suyas.
- Si no hay roles marcados, deduce quién es el profe por el contenido y los nombres que te doy.

QUÉ EVALÚAS:
- Solo el INGLÉS del alumno. Lo que se dice en español no cuenta para la nota; solo sirve para medir spanish_usage (cuánto se pasa el alumno al español cuando debería hablar inglés).
- No evalúas al profe ni la clase. No evalúas gramática fina ni vocabulario salvo en cuanto frenan la soltura: un alumno que habla seguido con algunos errores es más fluido que uno correcto que va palabra a palabra.
- Ten en cuenta que es una transcripción automática: puntuación y cortes no son fiables. Fíjate en la longitud de lo que el alumno dice seguido, las muletillas y dudas ("eh", "um", "I, I, I"), las frases abandonadas y las respuestas de una sola palabra.

ESCALA (fluency_score):
- 1-2: palabras sueltas o frases de dos o tres palabras; se atasca todo el rato; necesita al profe para completar casi cada frase.
- 3-4: frases cortas y simples, pausas y repeticiones frecuentes, se pasa al español a menudo para salir del paso.
- 5-6: se hace entender con frases completas pero cortas; dudas visibles; alguna idea larga que le cuesta terminar.
- 7-8: habla seguido, encadena ideas con frases largas; dudas puntuales que no le frenan.
- 9-10: soltura clara, frases largas y completas, apenas pausas, casi no recurre al español.

CITAS:
- best_fluent_excerpt y worst_struggle_excerpt son citas LITERALES del alumno, copiadas carácter a carácter del transcript (se comprueban automáticamente). Cortas: una o dos frases. Nada de parafrasear, resumir ni corregir.
- El minuto es el del corchete del turno donde está la cita.

SI NO SE PUEDE EVALUAR (evaluable: false): el alumno apenas habla inglés en toda la clase, la clase es casi entera en español, o no se puede saber quién es el alumno. Explícalo en unscorable_reason. No inventes una nota por salir del paso.`;

export interface FluencyInput {
  /** Transcript ya formateado con roles (lib/fluency formatTurnsForAi). */
  turnsText: string;
  studentName: string;
  teacherName?: string | null;
  rolesKnown: boolean;
  /** % de palabras del alumno según las etiquetas de Fathom. */
  labelShare: number | null;
}

export async function analyzeFluency(input: FluencyInput): Promise<AiResult<FluencyIA>> {
  const header = [
    `Alumno/a según la plataforma: ${input.studentName}`,
    input.teacherName ? `Profesor/a según la plataforma: ${input.teacherName}` : '',
    input.rolesKnown
      ? 'Los roles PROFE y ALUMNO se han marcado a partir del email de Fathom (fiable, pero con los errores de atribución de turnos ya dichos).'
      : 'No se pudo marcar quién es el profe: dedúcelo por el contenido.',
    input.labelShare != null
      ? `Según las etiquetas de Fathom, el alumno habla un ${input.labelShare}% de las palabras (corrígelo si ves turnos mal atribuidos).`
      : '',
  ].filter(Boolean).join('\n');

  return askClaudeJson<FluencyIA>({
    label: 'analyze-fluency',
    model: FLUENCY_MODEL,
    system: SYSTEM_PROMPT,
    prompt: `${header}\n\nTRANSCRIPCIÓN:\n${input.turnsText}`,
    schema: FLUENCY_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
    // Peor caso 25 s × 2 intentos = 50 s: cabe en los 60 s de la función que lo
    // lanza (save-transcript), que a esas alturas ya respondió al profe y solo
    // lleva 2-3 s de guardado. Haiku tarda ~5-10 s con un transcript de 1 hora.
    timeoutMs: 25_000,
    maxRetries: 1,
    // Las citas son LITERALES del transcript: la limpieza de guiones las cambiaría
    // y dejarían de encontrarse. Los enums y minutos tampoco se tocan.
    skipCleanKeys: [
      'best_fluent_excerpt', 'worst_struggle_excerpt', 'best_fluent_at', 'worst_struggle_at',
      'hesitation_level', 'spanish_usage',
    ],
  });
}
