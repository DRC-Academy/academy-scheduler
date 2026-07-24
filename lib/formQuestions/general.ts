import { FormQuestion, SKILL_LEVELS } from './types';

// Formulario inicial de INGLÉS GENERAL — el que se venía usando para todos.
// Es la variante por defecto: la reciben los alumnos de inglés general, los de
// intensivo, y los de examen cuyo examen todavía no tiene formulario propio.
export const FORM_GENERAL: FormQuestion[] = [
  // ── 💼 Sobre ti ──────────────────────────────────────────
  {
    id: 'q1_dedicas',
    section: '💼 Sobre ti',
    title: '¿A qué te dedicas?',
    hint: 'Saber esto nos ayuda a usar ejemplos en tus clases que tengan que ver con tu día a día.',
    type: 'short',
    required: true,
  },

  // ── 🎯 Tu objetivo ───────────────────────────────────────
  {
    id: 'q2_objetivo',
    section: '🎯 Tu objetivo',
    title: '¿Por qué quieres mejorar tu inglés justo ahora? ¿Qué cambiaría en tu vida si lo consigues?',
    hint: 'Para mí es la pregunta más importante. Esto nos ayudará a que las clases te acerquen a donde de verdad quieres llegar.',
    type: 'long',
    required: true,
  },

  // ── 📚 Tu historia con el inglés ─────────────────────────
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

  // ── 🧠 Cómo aprendes ─────────────────────────────────────
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

  // ── 🌍 El inglés en tu vida ──────────────────────────────
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

  // ── ✨ Una última cosa ───────────────────────────────────
  {
    id: 'q12_extra',
    section: '✨ Una última cosa',
    title: '¿Hay algo más que quieras contarme antes de la primera clase?',
    hint: 'Lo que sea. Cualquier cosa que creas que va a ayudar a tu profe a conocerte un poco mejor.',
    type: 'long',
    required: false,
  },
];
