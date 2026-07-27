import { FormQuestion } from './types';

// Formulario inicial de PREPARACIÓN C1 ADVANCED (CAE).
// Se envía a los alumnos cuyo plan es de examen y nivel C1.
export const FORM_C1_ADVANCED: FormQuestion[] = [
  // ── 💼 Sobre ti ──────────────────────────────────────────
  {
    id: 'q_c1_ocupacion',
    section: '💼 Sobre ti',
    title: '¿A qué te dedicas y cómo encaja el inglés en tu vida profesional o académica?',
    hint: 'A nivel C1 el inglés suele estar muy ligado a tu carrera. Queremos entender ese contexto.',
    type: 'long',
    required: true,
  },

  // ── 🎯 Tu objetivo con el C1 ────────────────────────────
  {
    id: 'q_c1_motivacion',
    section: '🎯 Tu objetivo con el C1',
    title: '¿Por qué quieres el C1 Advanced? ¿Qué puertas te abre conseguirlo?',
    hint: 'Sacarse el C1 es un reto serio. Tu motivación va a ser tu mejor aliada.',
    type: 'long',
    required: true,
  },
  {
    id: 'q_c1_fecha_examen',
    section: '🎯 Tu objetivo con el C1',
    title: '¿Tienes fecha de examen o una fecha límite?',
    hint: 'Así diseñamos un plan de preparación con el ritmo adecuado.',
    type: 'radio',
    options: [
      'Sí, en menos de 3 meses',
      'Sí, en 3 a 6 meses',
      'Sí, en más de 6 meses',
      'Todavía no, quiero sentir que estoy listo/a antes',
    ],
    required: true,
  },

  // ── 📚 Tu recorrido ─────────────────────────────────────
  {
    id: 'q_c1_examenes_previos',
    section: '📚 Tu recorrido',
    title: '¿Qué exámenes oficiales has aprobado o intentado?',
    hint: 'Tu historial nos dice mucho sobre tu nivel de partida y tu familiaridad con el formato.',
    type: 'radio',
    options: [
      'Tengo el B2 First aprobado',
      'Intenté el B2 First pero no aprobé',
      'Tengo otro certificado B2 (IELTS, TOEFL, EOI…)',
      'No tengo certificados pero creo que tengo nivel B2+',
      'Ya intenté el C1 Advanced pero no aprobé',
    ],
    required: true,
  },
  {
    id: 'q_c1_uso_actual',
    section: '📚 Tu recorrido',
    title: '¿Cómo usas el inglés actualmente? Marca todo lo que aplique.',
    hint: 'A este nivel, lo que haces con el inglés fuera de clase importa tanto como las clases.',
    type: 'checkbox',
    options: [
      'Reuniones o llamadas de trabajo en inglés',
      'Escribo emails o informes en inglés',
      'Consumo contenido (series, podcasts, libros) en inglés',
      'Interactúo en redes sociales o foros en inglés',
      'Viajo con frecuencia a países de habla inglesa',
      'Estudio o he estudiado en inglés (máster, cursos, etc.)',
      'No lo uso mucho fuera de las clases',
    ],
    required: true,
  },

  // ── 🧠 Tu nivel actual ──────────────────────────────────
  {
    id: 'q_c1_autoevaluacion',
    section: '🧠 Tu nivel actual',
    title: '¿Cómo ves tu nivel HOY en cada destreza? Piensa en lo que el C1 Advanced te va a exigir.',
    hint: 'El salto del B2 al C1 es grande. Sé sincero/a, es la mejor forma de ayudarte.',
    type: 'matrix',
    rows: ['Hablar', 'Escuchar', 'Leer', 'Escribir'],
    cols: ['Muy bajo', 'Básico', 'Intermedio', 'Bueno', 'Muy bueno'],
    required: true,
  },
  {
    id: 'q_c1_partes_preocupan',
    section: '🧠 Tu nivel actual',
    title: '¿Qué partes del examen te preocupan más?',
    hint: 'El Advanced tiene secciones exigentes. Así enfocamos tu preparación.',
    type: 'checkbox',
    options: [
      'Use of English: transformaciones, formación de palabras, clozed texts',
      'Reading: textos complejos con preguntas sutiles',
      'Writing: essays, proposals, reports y reviews de nivel avanzado',
      'Listening: audios rápidos con vocabulario sofisticado y múltiples acentos',
      'Speaking: argumentar, especular y mantener un discurso fluido y preciso',
      'No conozco bien el formato del C1 todavía',
    ],
    required: true,
  },
  {
    id: 'q_c1_meseta',
    section: '🧠 Tu nivel actual',
    title: '¿Sientes que llevas tiempo "estancado/a" en algún aspecto del inglés?',
    hint: 'En niveles altos es normal. Identificarlo nos ayuda a romper ese techo.',
    type: 'long',
    required: true,
  },

  // ── 📖 Tu preparación ───────────────────────────────────
  {
    id: 'q_c1_horas_semana',
    section: '📖 Tu preparación',
    title: '¿Cuánto tiempo puedes dedicar al inglés fuera de clase cada semana?',
    hint: 'El C1 pide inmersión constante. Un plan realista marca la diferencia.',
    type: 'radio',
    options: [
      'Menos de 2 horas',
      '2 a 4 horas',
      '4 a 6 horas',
      'Más de 6 horas',
    ],
    required: true,
  },

  // ── ✨ Una última cosa ──────────────────────────────────
  {
    id: 'q_c1_algo_mas',
    section: '✨ Una última cosa',
    title: '¿Hay algo más que quieras contarnos antes de empezar?',
    hint: 'Experiencias previas con el Advanced, miedos, expectativas… todo nos sirve.',
    type: 'long',
    required: false,
  },
];
