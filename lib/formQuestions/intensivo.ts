import { FormQuestion } from './types';

// Formulario inicial de CURSO INTENSIVO (no de examen).
// Se envía a los alumnos cuyo plan clasifica como 'intensivo': cursos de ritmo
// acelerado sin examen oficial de por medio. Un "Intensivo FCE" o un "intensivo
// PET" NO caen acá — classifyPlan los marca como 'examenes' y reciben el
// formulario del examen correspondiente.
export const FORM_INTENSIVO: FormQuestion[] = [
  // ── 💼 Sobre ti ──────────────────────────────────────────
  {
    id: 'q_int_ocupacion',
    section: '💼 Sobre ti',
    title: '¿A qué te dedicas?',
    hint: 'Así usamos vocabulario y situaciones que conecten con tu realidad.',
    type: 'short',
    required: true,
  },

  // ── 🎯 Tu objetivo ──────────────────────────────────────
  {
    id: 'q_int_motivacion',
    section: '🎯 Tu objetivo',
    title: '¿Para qué necesitas mejorar tu inglés rápido? ¿Qué hay detrás de esta urgencia?',
    hint: 'En un intensivo cada clase cuenta — saber tu "para qué" nos ayuda a enfocar al máximo.',
    type: 'long',
    required: true,
  },
  {
    id: 'q_int_deadline',
    section: '🎯 Tu objetivo',
    title: '¿Tienes una fecha límite o evento concreto?',
    hint: 'Si hay una fecha, planificamos hacia atrás desde ahí.',
    type: 'radio',
    options: [
      'Sí, en menos de 4 semanas',
      'Sí, en 1 a 2 meses',
      'Sí, en 2 a 3 meses',
      'No hay fecha fija, pero quiero avanzar lo más rápido posible',
    ],
    required: true,
  },
  {
    id: 'q_int_tipo_objetivo',
    section: '🎯 Tu objetivo',
    title: '¿Qué describe mejor lo que necesitas? Marca todo lo que aplique.',
    hint: 'Así diseñamos un programa que cubra exactamente lo que necesitas.',
    type: 'checkbox',
    options: [
      'Preparar una entrevista de trabajo en inglés',
      'Hacer una presentación o ponencia',
      'Empezar un trabajo donde se habla inglés',
      'Preparar un viaje o mudanza al extranjero',
      'Aprobar un examen o prueba de nivel',
      'Desenvolverme en reuniones y calls',
      'Otro objetivo específico',
    ],
    required: true,
  },

  // ── 📚 Tu historia con el inglés ────────────────────────
  {
    id: 'q_int_tiempo_sin_estudiar',
    section: '📚 Tu historia con el inglés',
    title: '¿Cuánto tiempo llevas sin estudiar inglés de forma regular?',
    hint: 'No pasa nada si hace mucho — necesitamos saber de dónde partimos.',
    type: 'radio',
    options: [
      'Estoy estudiando ahora mismo',
      'Menos de 6 meses',
      'Entre 6 meses y 2 años',
      'Más de 2 años',
    ],
    required: true,
  },
  {
    id: 'q_int_como_estudiaste',
    section: '📚 Tu historia con el inglés',
    title: '¿Cómo has estudiado inglés antes? Marca lo que aplique.',
    hint: 'Así evitamos repetir lo que no te ha funcionado.',
    type: 'checkbox',
    options: [
      'Clases en academia o colegio',
      'Clases particulares',
      'Apps (Duolingo, Babbel, etc.)',
      'Por mi cuenta',
      'Clases online en otra academia',
      'Inmersión en país de habla inglesa',
      'No he estudiado antes',
    ],
    required: true,
  },

  // ── 🧠 Tu nivel actual ──────────────────────────────────
  {
    id: 'q_int_autoevaluacion',
    section: '🧠 Tu nivel actual',
    title: '¿Cómo ves tu nivel HOY en cada destreza?',
    hint: 'No hay respuestas buenas ni malas — tu percepción nos da el punto de partida.',
    type: 'matrix',
    rows: ['Hablar', 'Escuchar', 'Leer', 'Escribir'],
    cols: ['Muy bajo', 'Básico', 'Intermedio', 'Bueno', 'Muy bueno'],
    required: true,
  },
  {
    id: 'q_int_foco_destreza',
    section: '🧠 Tu nivel actual',
    title: '¿Qué destreza es la más urgente para ti ahora mismo?',
    hint: 'En un intensivo hay que priorizar — esto nos ayuda a decidir dónde poner más peso.',
    type: 'radio',
    options: [
      'Hablar con fluidez y confianza',
      'Entender inglés hablado (llamadas, reuniones, vídeos)',
      'Escribir bien (emails, mensajes, informes)',
      'Leer y comprender textos',
      'Necesito mejorar en todo por igual',
    ],
    required: true,
  },

  // ── ⏰ Tu disponibilidad ────────────────────────────────
  {
    id: 'q_int_horas_semana',
    section: '⏰ Tu disponibilidad',
    title: '¿Cuánto tiempo puedes dedicar al inglés en TOTAL cada semana (clase + práctica)?',
    hint: 'Un intensivo pide compromiso real — ser sincero/a aquí nos ayuda a darte un plan viable.',
    type: 'radio',
    options: [
      '3 a 5 horas',
      '5 a 8 horas',
      '8 a 12 horas',
      'Más de 12 horas (dedicación casi completa)',
    ],
    required: true,
  },

  // ── ✨ Una última cosa ──────────────────────────────────
  {
    id: 'q_int_algo_mas',
    section: '✨ Una última cosa',
    title: '¿Hay algo más que debamos saber para diseñar tu intensivo?',
    hint: 'Contexto, miedos, experiencias previas… ¡todo nos viene bien!',
    type: 'long',
    required: false,
  },
];
