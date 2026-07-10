// Generación de la "ficha inicial + primera clase" a partir de las respuestas
// del formulario del alumno, usando la API de Claude (Anthropic).
//
// Es BEST-EFFORT: si no hay ANTHROPIC_API_KEY configurada, o la llamada falla,
// devuelve un status distinto de 'ready' y el flujo del formulario sigue
// funcionando igual (las respuestas crudas quedan guardadas de todos modos).

export interface FichaInput {
  studentName: string;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  responsesText: string;   // respuestas ya formateadas (formatResponsesForAI)
}

export type FichaStatus = 'ready' | 'skipped' | 'error';

export interface FichaResult {
  ficha: string | null;
  status: FichaStatus;
}

const MODEL = process.env.ANALYZE_FORM_MODEL || 'claude-opus-4-8';
const API_URL = 'https://api.anthropic.com/v1/messages';

function buildSystemPrompt(): string {
  return [
    'Sos un asistente pedagógico de DRC Academy, una academia de inglés.',
    'A partir del formulario inicial que completó un alumno antes de su primera',
    'clase, tenés que preparar dos cosas para el/la profesor/a, en español rioplatense,',
    'con tono cálido y profesional:',
    '',
    '1) FICHA DEL ALUMNO: un resumen accionable de quién es, su objetivo real y su',
    '   motivación, su historia con el inglés, su nivel auto-percibido por habilidad,',
    '   cómo aprende, cómo maneja los errores, y en qué usa el inglés. Destacá lo que',
    '   más importa para personalizar la enseñanza.',
    '2) PRIMERA CLASE SUGERIDA: una propuesta concreta de cómo arrancar la primera',
    '   clase (foco, actividades, tono de las correcciones, qué reforzar entre clases),',
    '   coherente con el objetivo y el nivel del alumno.',
    '',
    'Formato: markdown claro con dos secciones ("## Ficha del alumno" y',
    '"## Primera clase sugerida"), con viñetas. Sé concreto y breve — el profesor',
    'lo tiene que poder leer en un minuto. No inventes datos que no estén en el',
    'formulario; si algo no lo respondió, no lo menciones.',
  ].join('\n');
}

function buildUserPrompt(input: FichaInput): string {
  const meta = [
    `Alumno/a: ${input.studentName}`,
    input.teacherName ? `Profesor/a: ${input.teacherName}` : '',
    input.level ? `Nivel: ${input.level}` : '',
    input.plan ? `Plan/producto: ${input.plan}` : '',
  ].filter(Boolean).join('\n');

  return `${meta}\n\nRespuestas del formulario inicial:\n\n${input.responsesText}`;
}

export async function generateFicha(input: FichaInput): Promise<FichaResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Sin API key: no generamos ficha, pero no rompemos el flujo.
    return { ficha: null, status: 'skipped' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: buildUserPrompt(input) }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[analyzeForm] Anthropic HTTP ${res.status}: ${detail.slice(0, 500)}`);
      return { ficha: null, status: 'error' };
    }

    const data = await res.json();
    // La respuesta es content[]: buscamos el primer bloque de texto.
    const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (!text) {
      console.error('[analyzeForm] Respuesta sin texto utilizable de Anthropic');
      return { ficha: null, status: 'error' };
    }
    return { ficha: text, status: 'ready' };
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? 'timeout tras 60s' : String(err?.message ?? err);
    console.error(`[analyzeForm] Falló la generación de la ficha: ${msg}`);
    return { ficha: null, status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}
