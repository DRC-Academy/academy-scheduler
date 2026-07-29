// CAPA 3 — Verificación semántica del transcript con IA (Bloque 1). SOLO SERVIDOR.
// Modelo: claude-haiku-4-5-20251001 (barato; decisión del proyecto para verificar).
// Best-effort: si no hay clave o falla, devuelve status !== 'ready' y el flujo sigue.
//
// Se ejecuta SOLO en la zona gris (score de capa 1 entre 35 y 70) o si hay flags
// de la capa 2: si el score es muy alto y no hay flags, no se gasta en IA.

import 'server-only';   // llega al SDK de Anthropic vía askClaudeJson

import { askClaudeJson } from '@/lib/anthropic';

export interface TranscriptAuthenticity {
  authentic: boolean;
  confidence: number;             // 0-100
  reasoning: string;              // español, máx 2 frases
  suspiciousElements: string[];
}

const VERIFY_MODEL = 'claude-haiku-4-5-20251001';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['authentic', 'confidence', 'reasoning', 'suspiciousElements'],
  properties: {
    authentic:          { type: 'boolean' },
    confidence:         { type: 'integer', description: '0-100' },
    reasoning:          { type: 'string', description: 'Explicación breve en español, máximo 2 frases.' },
    suspiciousElements: { type: 'array', items: { type: 'string' } },
  },
} as const;

const SYSTEM = `Eres un verificador de autenticidad de transcripciones de clases de inglés online. Recibes una transcripción y debes determinar si procede de una grabación real de una clase o si fue generada artificialmente por un modelo de lenguaje.

Señales de transcripción REAL:
- Diálogo bidireccional con interrupciones y solapamientos
- Errores gramaticales del alumno sin corregir en el texto
- Silencios, repeticiones, reformulaciones
- Referencias a elementos técnicos ('no te escucho', 'se cortó', 'comparto pantalla', 'se congeló')
- Digresiones fuera del tema de la clase
- Contenido desordenado, no estructurado pedagógicamente
- Intervenciones de longitud muy desigual
- Menciones a elementos externos (el tiempo, ruido, algo que pasó en la semana del alumno)

Señales de transcripción GENERADA:
- Diálogo demasiado equilibrado y ordenado
- El alumno responde siempre con frases completas y gramaticalmente correctas
- Progresión pedagógica perfecta sin desvíos
- Ausencia total de ruido conversacional
- Registro lingüístico idéntico entre profesor y alumno
- Estructura que parece un guion de clase, no una conversación espontánea
- El profesor nunca duda ni improvisa

Responde ÚNICAMENTE con JSON válido que cumpla el esquema.`;

export async function verifyTranscriptAI(args: {
  transcript: string;
  teacherName: string;
  studentName: string;
  level?: string | null;
  durationMinutes?: number;
}): Promise<{ data: TranscriptAuthenticity | null; status: 'ready' | 'skipped' | 'error' }> {
  const duration = args.durationMinutes ?? 60;
  const snippet = args.transcript.length > 6000 ? args.transcript.slice(0, 6000) : args.transcript;

  const prompt = `Analiza esta transcripción de una clase de inglés de ${duration} minutos entre el profesor ${args.teacherName || '(sin nombre)'} y el alumno ${args.studentName || '(sin nombre)'}, nivel ${args.level || '(sin especificar)'}:

${snippet}`;

  const res = await askClaudeJson<TranscriptAuthenticity>({
    model: VERIFY_MODEL,
    system: SYSTEM,
    prompt,
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 700,
    label: 'verify-transcript',
    // Corre DESPUÉS del análisis pedagógico dentro de la misma función serverless
    // (maxDuration 60 s): 15 s de techo para no comerse el presupuesto restante.
    timeoutMs: 15_000,
  });
  return { data: res.data, status: res.status };
}
