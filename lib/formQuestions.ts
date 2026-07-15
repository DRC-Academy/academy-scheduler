// Definición de las 11 preguntas del formulario inicial del alumno.
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
    section: '💼 Sobre ti',
    title: '¿A qué te dedicas?',
    hint: 'Saber esto nos ayuda a usar ejemplos en tus clases que tengan que ver con tu día a día.',
    type: 'short',
    required: true,
  },
  {
    id: 'q2_objetivo',
    section: '🎯 Tu objetivo',
    title: '¿Por qué quieres mejorar tu inglés justo ahora? ¿Qué cambiaría en tu vida si lo consigues?',
    hint: 'Para mí es la pregunta más importante. Esto nos ayudará a que las clases te acerquen a donde de verdad quieres llegar.',
    type: 'long',
    required: true,
  },
  {
    id: 'q3_pausa',
    section: '📚 Tu historia con el inglés',
    title: '¿Cuánto tiempo llevas sin estudiar inglés de forma regular?',
    hint: 'No hay una respuesta mejor que otra. Es solo para que sepamos desde dónde empezar contigo.',
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
    title: '¿Cómo has estudiado inglés hasta ahora?',
    hint: 'Puedes marcar todas las que quieras. Nos sirve para no repetir contigo lo que no te ha funcionado.',
    type: 'checkbox',
    options: [
      'Academia tradicional',
      'Clases particulares',
      'App (Duolingo, Babbel, etc.)',
      'Por mi cuenta (series, libros, vídeos)',
      'En el trabajo o en el extranjero',
      'Clases grupales',
      'Solo colegio/instituto',
      'Nunca he estudiado formalmente',
    ],
    required: true,
  },
  {
    id: 'q5_intentos',
    section: '📚 Tu historia con el inglés',
    title: '¿Hay algo que no te haya funcionado?',
    hint: 'Cuéntamelo todo para que tu experiencia sea la mejor posible. Puede ser la forma de enseñar, falta de conversación o cualquier otra cosa que te gustaría evitar.',
    type: 'long',
    required: true,
  },
  {
    id: 'q6_nivel',
    section: '🧠 Cómo aprendes',
    title: '¿Qué nivel crees que tienes?',
    hint: 'Marca lo que sientes de verdad en cada caso, tu profe medirá tu nivel de inglés real en la primera clase.',
    type: 'matrix',
    rows: ['Hablar', 'Escuchar', 'Leer', 'Escribir'],
    cols: [...SKILL_LEVELS],
    required: true,
  },
  {
    id: 'q7_cuesta',
    section: '🧠 Cómo aprendes',
    title: '¿Qué es lo que más se te resiste del inglés?',
    hint: 'Eso que notas que se te atasca una y otra vez. Cuanto más concreto seas, mejor podremos ayudarte.',
    type: 'long',
    required: true,
  },
  {
    id: 'q9_errores',
    section: '🧠 Cómo aprendes',
    title: '¿Cómo te sientes cuando cometes un error hablando?',
    hint: 'Te lo pregunto porque de esto depende cómo te va a corregir tu profe. A algunas personas les viene bien que las frenen en el momento y a otras que las dejen seguir.',
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
    title: '¿Usas el inglés fuera de clase?',
    hint: 'Si ya convives con el inglés en algún sitio, nos ayudará a personalizar tus clases mejor.',
    type: 'checkbox',
    options: [
      'En el trabajo (reuniones, emails, presentaciones)',
      'Series o películas en inglés',
      'Música o podcasts',
      'Redes sociales o lectura online',
      'Viajes',
      'No lo uso fuera de clase',
    ],
    required: true,
  },
  {
    id: 'q11_practica',
    section: '🌍 El inglés en tu vida',
    title: '¿Cuánto tiempo puedes dedicarle al inglés aparte de las clases?',
    hint: 'No pasa nada si es poco tiempo. Saber de cuánto dispones ayuda a tu profe a decidir qué reforzáis entre una clase y la siguiente.',
    type: 'radio',
    options: [
      'Nada',
      'Menos de 1 hora',
      'Entre 1 y 3 horas',
      'Más de 4 horas',
    ],
    required: true,
  },
  {
    id: 'q12_extra',
    section: '✨ Una última cosa',
    title: '¿Hay algo más que quieras contarme antes de la primera clase?',
    hint: 'Lo que sea. Cualquier cosa que creas que va a ayudar a tu profe a conocerte un poco mejor.',
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
