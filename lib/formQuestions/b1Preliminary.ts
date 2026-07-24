import { FormQuestion } from './types';

// Formulario inicial de PREPARACIÓN B1 PRELIMINARY (PET).
// Se envía a los alumnos cuyo plan es de examen y nivel B1.
export const FORM_B1_PRELIMINARY: FormQuestion[] = [
  // ── 💼 Sobre ti ──────────────────────────────────────────
  {
    id: 'q_b1_ocupacion',
    section: '💼 Sobre ti',
    title: '¿A qué te dedicas?',
    hint: 'Así adaptamos ejemplos y temas de práctica a tu contexto.',
    type: 'short',
    required: true,
  },

  // ── 🎯 Tu objetivo con el B1 ────────────────────────────
  {
    id: 'q_b1_motivacion',
    section: '🎯 Tu objetivo con el B1',
    title: '¿Por qué quieres sacarte el B1 Preliminary? ¿Qué cambiará cuando lo tengas?',
    hint: 'Saber tu motivación real nos ayuda a mantenerte enfocado/a cuando la preparación se ponga intensa.',
    type: 'long',
    required: true,
  },
  {
    id: 'q_b1_fecha_examen',
    section: '🎯 Tu objetivo con el B1',
    title: '¿Tienes fecha de examen o una fecha límite en mente?',
    hint: 'Así planificamos el ritmo de preparación para que llegues con confianza.',
    type: 'radio',
    options: [
      'Sí, en menos de 3 meses',
      'Sí, en 3 a 6 meses',
      'Sí, en más de 6 meses',
      'Todavía no, quiero prepararme bien primero',
    ],
    required: true,
  },

  // ── 📚 Tu experiencia con exámenes ──────────────────────
  {
    id: 'q_b1_examenes_previos',
    section: '📚 Tu experiencia con exámenes',
    title: '¿Has hecho algún examen de inglés antes (Cambridge, IELTS, TOEFL, de la escuela…)?',
    hint: 'No importa el resultado — nos ayuda a saber si el formato de examen te es familiar.',
    type: 'radio',
    options: [
      'No, este es mi primer examen oficial',
      'Sí, aprobé uno de nivel inferior (A2 Key u otro)',
      'Sí, intenté el B1 pero no aprobé',
      'Sí, he hecho exámenes pero de otro tipo (IELTS, TOEFL, etc.)',
    ],
    required: true,
  },
  {
    id: 'q_b1_como_estudiaste',
    section: '📚 Tu experiencia con exámenes',
    title: '¿Cómo has estudiado inglés hasta ahora? Marca todo lo que aplique.',
    hint: 'Así entendemos qué métodos ya conoces y qué podemos hacer diferente.',
    type: 'checkbox',
    options: [
      'Clases en academia o colegio',
      'Clases particulares',
      'Apps (Duolingo, Babbel, etc.)',
      'Por mi cuenta con libros o vídeos',
      'Clases online en otra academia',
      'Viviendo o viajando a un país de habla inglesa',
      'No he estudiado de forma regular',
    ],
    required: true,
  },

  // ── 🧠 Tu nivel actual ──────────────────────────────────
  {
    id: 'q_b1_autoevaluacion',
    section: '🧠 Tu nivel actual',
    title: '¿Cómo ves tu nivel HOY en cada destreza? Piensa en lo que el B1 te va a pedir.',
    hint: 'Tu percepción es el punto de partida — desde ahí construimos juntos.',
    type: 'matrix',
    rows: ['Hablar', 'Escuchar', 'Leer', 'Escribir'],
    cols: ['Muy bajo', 'Básico', 'Intermedio', 'Bueno', 'Muy bueno'],
    required: true,
  },
  {
    id: 'q_b1_partes_preocupan',
    section: '🧠 Tu nivel actual',
    title: '¿Qué partes del examen te preocupan más?',
    hint: 'Así dedicamos más tiempo a lo que más necesitas.',
    type: 'checkbox',
    options: [
      'Reading — entender textos y responder preguntas',
      'Writing — redactar emails, historias o artículos cortos',
      'Listening — entender audios y conversaciones',
      'Speaking — hablar con el examinador y con otro candidato',
      'No conozco bien el formato del examen todavía',
    ],
    required: true,
  },
  {
    id: 'q_b1_sensacion_error',
    section: '🧠 Tu nivel actual',
    title: '¿Cómo te sientes cuando cometes un error al hablar en inglés?',
    hint: 'En el Speaking la confianza es clave — queremos ayudarte a sentirte seguro/a.',
    type: 'radio',
    options: [
      'Me bloqueo y prefiero no hablar',
      'Me da vergüenza pero sigo intentándolo',
      'No me preocupa demasiado, es parte de aprender',
    ],
    required: true,
  },

  // ── 📖 Tu preparación ───────────────────────────────────
  {
    id: 'q_b1_horas_semana',
    section: '📖 Tu preparación',
    title: '¿Cuánto tiempo puedes dedicar al inglés fuera de clase cada semana?',
    hint: 'Ser realista aquí nos ayuda a darte un plan que puedas seguir de verdad.',
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
    id: 'q_b1_exposicion',
    section: '📖 Tu preparación',
    title: '¿Tienes contacto con el inglés fuera de clase?',
    hint: 'Todo cuenta — nos ayuda a sugerirte recursos extra.',
    type: 'checkbox',
    options: [
      'Series o películas en inglés',
      'Música o podcasts',
      'Redes sociales o YouTube',
      'En el trabajo o los estudios',
      'Con amigos o familia',
      'Apenas tengo contacto fuera de clase',
    ],
    required: true,
  },

  // ── ✨ Una última cosa ──────────────────────────────────
  {
    id: 'q_b1_algo_mas',
    section: '✨ Una última cosa',
    title: '¿Hay algo más que quieras contarnos antes de empezar la preparación?',
    hint: 'Cualquier duda, miedo o expectativa… ¡nos viene genial saberlo!',
    type: 'long',
    required: false,
  },
];
