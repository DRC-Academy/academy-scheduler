// Definición de las 12 preguntas del formulario inicial del alumno.
// Fuente única de verdad: la usa tanto la página pública del formulario
// (render) como el endpoint /api/forms/submit (formateo para la IA).

export type QuestionType = 'short' | 'long' | 'radio' | 'checkbox' | 'matrix';

export interface FormQuestion {
  id: string;
  section: string;        // encabezado de sección (con emoji)
  title: string;
  hint?: string;
  type: QuestionType;
  options?: string[];     // radio / checkbox
  rows?: string[];        // matrix (una pregunta radio por fila)
  cols?: string[];        // matrix (opciones compartidas)
  required: boolean;
}

// Escala compartida de la matriz de habilidades (pregunta 6).
export const SKILL_LEVELS = ['Muy bajo', 'Básico', 'Intermedio', 'Bueno', 'Muy bueno'] as const;

export const FORM_QUESTIONS: FormQuestion[] = [
  {
    id: 'q1_dedicas',
    section: '💼 Sobre vos',
    title: '¿A qué te dedicás?',
    hint: 'Cuanto más específico/a, mejor — saber en qué trabajás me ayuda a que los ejemplos sean relevantes para tu vida real.',
    type: 'short',
    required: true,
  },
  {
    id: 'q2_objetivo',
    section: '🎯 Tu objetivo',
    title: '¿Por qué querés mejorar tu inglés ahora? ¿Qué cambia en tu vida cuando lo logres?',
    hint: 'Esta es la pregunta más importante. Tu respuesta me ayuda a mantener la motivación y diseñar clases que realmente importen.',
    type: 'long',
    required: true,
  },
  {
    id: 'q3_pausa',
    section: '📚 Tu historia con el inglés',
    title: '¿Cuánto tiempo hace que no estudiás inglés regularmente?',
    type: 'radio',
    options: [
      'Llevo estudiando sin pausa',
      'Menos de 6 meses de pausa',
      'Entre 6 meses y 1 año',
      'Entre 1 y 2 años',
      'Más de 2 años',
    ],
    required: true,
  },
  {
    id: 'q4_como_estudiaste',
    section: '📚 Tu historia con el inglés',
    title: '¿Cómo estudiaste inglés antes? (podés marcar más de uno)',
    type: 'checkbox',
    options: [
      'Academia o instituto',
      'Clases particulares',
      'App (Duolingo, Babbel, etc.)',
      'Por mi cuenta (series, libros, videos)',
      'En el trabajo o en el exterior',
      'Nunca estudié formalmente',
    ],
    required: true,
  },
  {
    id: 'q5_intentos',
    section: '📚 Tu historia con el inglés',
    title: '¿Intentaste mejorar tu inglés antes y no lo lograste? ¿Qué pasó?',
    hint: 'No es obligatoria, pero si algo no funcionó antes me ayuda a no repetirlo.',
    type: 'long',
    required: false,
  },
  {
    id: 'q6_nivel',
    section: '🧠 Cómo aprendés',
    title: '¿Cómo es tu nivel en cada habilidad?',
    type: 'matrix',
    rows: ['Hablar', 'Escuchar', 'Leer', 'Escribir'],
    cols: [...SKILL_LEVELS],
    required: true,
  },
  {
    id: 'q7_cuesta',
    section: '🧠 Cómo aprendés',
    title: '¿Qué es lo que más te cuesta del inglés?',
    type: 'long',
    required: true,
  },
  {
    id: 'q8_disfrutas',
    section: '🧠 Cómo aprendés',
    title: '¿Qué es lo que mejor hacés o más disfrutás?',
    type: 'long',
    required: true,
  },
  {
    id: 'q9_errores',
    section: '🧠 Cómo aprendés',
    title: '¿Cómo te sentís cuando cometés errores al hablar?',
    hint: 'Esto me ayuda a saber cómo manejamos las correcciones en clase.',
    type: 'radio',
    options: [
      'Me bloqueo y prefiero no hablar',
      'Me molesta pero sigo',
      'No me importa, es parte del proceso',
      'Depende del error',
    ],
    required: true,
  },
  {
    id: 'q10_uso',
    section: '🌍 El inglés en tu vida',
    title: '¿Usás el inglés fuera de las clases? (podés marcar más de uno)',
    type: 'checkbox',
    options: [
      'En el trabajo (reuniones, emails, presentaciones)',
      'Series o películas en inglés',
      'Música o podcasts',
      'Redes sociales o lectura online',
      'Viajes o contacto con hablantes nativos',
      'No lo uso fuera de clase',
    ],
    required: true,
  },
  {
    id: 'q11_practica',
    section: '🌍 El inglés en tu vida',
    title: '¿Podés practicar inglés entre clases? ¿Cuánto tiempo por semana tenés disponible?',
    hint: 'No hay respuesta buena ni mala — esto me ayuda a calibrar qué reforzamos entre clases.',
    type: 'short',
    required: true,
  },
  {
    id: 'q12_extra',
    section: '✨ Una última cosa',
    title: '¿Hay algo más que quieras contarme antes de nuestra primera clase?',
    hint: 'Cualquier cosa que creas que me ayuda a conocerte mejor.',
    type: 'long',
    required: false,
  },
];

export type FormResponses = Record<string, unknown>;

// Convierte la respuesta cruda de una pregunta a texto legible.
function answerToText(q: FormQuestion, value: unknown): string {
  if (value == null || value === '') return '(sin responder)';
  if (q.type === 'checkbox' && Array.isArray(value)) {
    return value.length ? value.join(', ') : '(sin responder)';
  }
  if (q.type === 'matrix' && typeof value === 'object') {
    const v = value as Record<string, string>;
    return (q.rows ?? [])
      .map(row => `${row}: ${v[row]?.trim() ? v[row] : '(sin responder)'}`)
      .join(' · ');
  }
  return String(value);
}

// Arma un texto legible con todas las preguntas y respuestas, para pasarle a la
// IA que genera la ficha (y como respaldo humano de las respuestas crudas).
export function formatResponsesForAI(responses: FormResponses): string {
  return FORM_QUESTIONS
    .map(q => `${q.title}\n→ ${answerToText(q, responses[q.id])}`)
    .join('\n\n');
}

// Valida que las preguntas obligatorias estén respondidas.
export function firstUnansweredRequired(responses: FormResponses): FormQuestion | null {
  for (const q of FORM_QUESTIONS) {
    if (!q.required) continue;
    const v = responses[q.id];
    if (q.type === 'checkbox') {
      if (!Array.isArray(v) || v.length === 0) return q;
    } else if (q.type === 'matrix') {
      const obj = (v ?? {}) as Record<string, string>;
      if ((q.rows ?? []).some(row => !obj[row])) return q;
    } else if (v == null || String(v).trim() === '') {
      return q;
    }
  }
  return null;
}
