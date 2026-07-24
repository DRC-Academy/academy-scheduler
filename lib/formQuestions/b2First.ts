import { FormQuestion } from './types';

// Formulario inicial de PREPARACIÓN B2 FIRST (FCE).
// Se envía a los alumnos cuyo plan es de examen y nivel B2.
export const FORM_B2_FIRST: FormQuestion[] = [
  // ── 💼 Sobre ti ──────────────────────────────────────────
  {
    id: 'q_b2_ocupacion',
    section: '💼 Sobre ti',
    title: '¿A qué te dedicas?',
    hint: 'Así adaptamos temas de práctica a tu contexto real.',
    type: 'short',
    required: true,
  },

  // ── 🎯 Tu objetivo con el B2 ────────────────────────────
  {
    id: 'q_b2_motivacion',
    section: '🎯 Tu objetivo con el B2',
    title: '¿Por qué quieres sacarte el B2 First? ¿Qué se abre para ti cuando lo tengas?',
    hint: 'Tu motivación es el motor de la preparación — queremos conocerla bien.',
    type: 'long',
    required: true,
  },
  {
    id: 'q_b2_fecha_examen',
    section: '🎯 Tu objetivo con el B2',
    title: '¿Tienes fecha de examen o una fecha límite en mente?',
    hint: 'Así ajustamos el ritmo para que llegues preparado/a y sin agobios.',
    type: 'radio',
    options: [
      'Sí, en menos de 3 meses',
      'Sí, en 3 a 6 meses',
      'Sí, en más de 6 meses',
      'Todavía no, quiero sentirme listo/a antes de fijar fecha',
    ],
    required: true,
  },

  // ── 📚 Tu experiencia con exámenes ──────────────────────
  {
    id: 'q_b2_examenes_previos',
    section: '📚 Tu experiencia con exámenes',
    title: '¿Has hecho algún examen oficial de inglés antes?',
    hint: 'No importa el resultado — queremos saber si el formato te suena.',
    type: 'radio',
    options: [
      'No, este sería mi primer examen oficial',
      'Sí, tengo el B1 Preliminary (PET)',
      'Sí, intenté el B2 First pero no aprobé',
      'Sí, otro examen (IELTS, TOEFL, EOI, etc.)',
    ],
    required: true,
  },
  {
    id: 'q_b2_como_estudiaste',
    section: '📚 Tu experiencia con exámenes',
    title: '¿Cómo has estudiado inglés hasta ahora? Marca todo lo que aplique.',
    hint: 'Nos ayuda a entender tu recorrido y qué podemos hacer diferente.',
    type: 'checkbox',
    options: [
      'Clases en academia o colegio',
      'Clases particulares',
      'Apps (Duolingo, Babbel, etc.)',
      'Por mi cuenta con libros o vídeos',
      'Clases online en otra academia',
      'Viviendo en un país de habla inglesa',
      'Preparación previa de exámenes Cambridge',
    ],
    required: true,
  },

  // ── 🧠 Tu nivel actual ──────────────────────────────────
  {
    id: 'q_b2_autoevaluacion',
    section: '🧠 Tu nivel actual',
    title: '¿Cómo ves tu nivel HOY en cada destreza? Piensa en lo que el First te va a exigir.',
    hint: 'Tu percepción nos da el punto de partida — el profe ajustará desde ahí.',
    type: 'matrix',
    rows: ['Hablar', 'Escuchar', 'Leer', 'Escribir'],
    cols: ['Muy bajo', 'Básico', 'Intermedio', 'Bueno', 'Muy bueno'],
    required: true,
  },
  {
    id: 'q_b2_partes_preocupan',
    section: '🧠 Tu nivel actual',
    title: '¿Qué partes del examen te preocupan más?',
    hint: 'El First tiene secciones muy distintas — así priorizamos tu preparación.',
    type: 'checkbox',
    options: [
      'Use of English — gramática y vocabulario en contexto',
      'Reading — textos largos y preguntas de comprensión',
      'Writing — essays, reviews, emails formales',
      'Listening — audios con acentos variados y ritmo rápido',
      'Speaking — mantener una conversación fluida con el examinador',
      'No conozco bien el formato del examen todavía',
    ],
    required: true,
  },
  {
    id: 'q_b2_mayor_dificultad',
    section: '🧠 Tu nivel actual',
    title: '¿Qué es lo que más se te resiste del inglés a día de hoy?',
    hint: 'Puede ser gramática, vocabulario, pronunciación, fluidez… lo que sea.',
    type: 'long',
    required: true,
  },

  // ── 📖 Tu preparación ───────────────────────────────────
  {
    id: 'q_b2_horas_semana',
    section: '📖 Tu preparación',
    title: '¿Cuánto tiempo puedes dedicar al inglés fuera de clase cada semana?',
    hint: 'El First pide práctica constante — un plan realista es mejor que uno ideal.',
    type: 'radio',
    options: [
      'Menos de 1 hora',
      '1 a 2 horas',
      '2 a 4 horas',
      'Más de 4 horas',
    ],
    required: true,
  },
  {
    id: 'q_b2_exposicion',
    section: '📖 Tu preparación',
    title: '¿Dónde tienes contacto con el inglés fuera de clase?',
    hint: 'Todo cuenta — nos ayuda a sugerirte recursos que complementen las clases.',
    type: 'checkbox',
    options: [
      'Series, pelis o documentales en inglés',
      'Podcasts o audiolibros',
      'Lectura (libros, noticias, artículos)',
      'Redes sociales o YouTube',
      'En el trabajo o los estudios',
      'Apenas tengo contacto fuera de clase',
    ],
    required: true,
  },

  // ── ✨ Una última cosa ──────────────────────────────────
  {
    id: 'q_b2_algo_mas',
    section: '✨ Una última cosa',
    title: '¿Hay algo más que quieras contarnos antes de empezar la preparación?',
    hint: 'Cualquier duda, experiencia previa con el First o expectativa… ¡nos ayuda mucho!',
    type: 'long',
    required: false,
  },
];
