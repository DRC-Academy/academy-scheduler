import { FormQuestion } from './types';

// Formulario inicial de PREPARACIÓN IELTS.
// A diferencia de los de Cambridge, el IELTS NO se identifica por nivel CEFR
// (su plan es "Preparación del examen IELTS", sin B1/B2/C1): su variante matchea
// por nombre de examen y va PRIMERA en el registro, ver FORM_VARIANTS.
export const FORM_IELTS: FormQuestion[] = [
  // ── 💼 Sobre ti ──────────────────────────────────────────
  {
    id: 'q_ielts_ocupacion',
    section: '💼 Sobre ti',
    title: '¿A qué te dedicas actualmente?',
    hint: 'Así adaptamos los temas de práctica a tu contexto real.',
    type: 'short',
    required: true,
  },

  // ── 🎯 Tu objetivo con el IELTS ─────────────────────────
  {
    id: 'q_ielts_motivacion',
    section: '🎯 Tu objetivo con el IELTS',
    title: '¿Para qué necesitas el IELTS? ¿Qué se abre para ti cuando lo tengas?',
    hint: 'Saber tu motivación nos ayuda a enfocar cada clase en lo que de verdad necesitas.',
    type: 'long',
    required: true,
  },
  {
    id: 'q_ielts_modalidad',
    section: '🎯 Tu objetivo con el IELTS',
    title: '¿Qué modalidad del IELTS necesitas?',
    hint: 'El Academic y el General Training tienen tareas distintas — es importante saberlo desde el principio.',
    type: 'radio',
    options: [
      'IELTS Academic (universidad, máster, formación)',
      'IELTS General Training (inmigración, trabajo, residencia)',
      'No estoy seguro/a todavía',
    ],
    required: true,
  },
  {
    id: 'q_ielts_banda_objetivo',
    section: '🎯 Tu objetivo con el IELTS',
    title: '¿Qué banda necesitas conseguir?',
    hint: 'Si te lo pide una universidad o un proceso migratorio, suele haber una banda mínima.',
    type: 'radio',
    options: [
      '5.0 – 5.5',
      '6.0 – 6.5',
      '7.0 – 7.5',
      '8.0 o más',
      'No lo tengo claro todavía',
    ],
    required: true,
  },
  {
    id: 'q_ielts_fecha_examen',
    section: '🎯 Tu objetivo con el IELTS',
    title: '¿Tienes fecha de examen o una fecha límite?',
    hint: 'Así planificamos el ritmo para que llegues con confianza.',
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
    id: 'q_ielts_examenes_previos',
    section: '📚 Tu experiencia con exámenes',
    title: '¿Has hecho el IELTS u otro examen oficial de inglés antes?',
    hint: 'No importa el resultado — nos ayuda a saber si el formato te suena.',
    type: 'radio',
    options: [
      'No, este es mi primer examen oficial de inglés',
      'Sí, hice el IELTS antes (no conseguí la banda que necesitaba)',
      'Sí, hice el IELTS antes (conseguí mi banda pero ha caducado)',
      'Sí, tengo un certificado Cambridge (B1, B2, C1…)',
      'Sí, otro examen (TOEFL, Duolingo English Test, etc.)',
    ],
    required: true,
  },
  {
    id: 'q_ielts_como_estudiaste',
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
      'Preparación previa específica de IELTS',
    ],
    required: true,
  },

  // ── 🧠 Tu nivel actual ──────────────────────────────────
  {
    id: 'q_ielts_autoevaluacion',
    section: '🧠 Tu nivel actual',
    title: '¿Cómo ves tu nivel HOY en cada destreza? Piensa en lo que el IELTS te va a exigir.',
    hint: 'Tu percepción nos da el punto de partida — el profe ajustará desde ahí.',
    type: 'matrix',
    rows: ['Hablar (Speaking)', 'Escuchar (Listening)', 'Leer (Reading)', 'Escribir (Writing)'],
    cols: ['Muy bajo', 'Básico', 'Intermedio', 'Bueno', 'Muy bueno'],
    required: true,
  },
  {
    id: 'q_ielts_partes_preocupan',
    section: '🧠 Tu nivel actual',
    title: '¿Qué partes del IELTS te preocupan más?',
    hint: 'El IELTS tiene tareas muy específicas — así enfocamos tu preparación.',
    type: 'checkbox',
    options: [
      'Listening — audios con distintos acentos (británico, australiano, etc.)',
      'Reading — textos largos y académicos con preguntas variadas',
      'Writing Task 1 — describir gráficos, tablas o mapas (Academic) / escribir una carta (General)',
      'Writing Task 2 — redactar un essay argumentativo',
      'Speaking — la entrevista cara a cara con el examinador',
      'Gestión del tiempo durante el examen',
      'No conozco bien el formato del IELTS todavía',
    ],
    required: true,
  },

  // ── 📖 Tu preparación ───────────────────────────────────
  {
    id: 'q_ielts_horas_semana',
    section: '📖 Tu preparación',
    title: '¿Cuánto tiempo puedes dedicar al inglés fuera de clase cada semana?',
    hint: 'El IELTS pide práctica constante — un plan realista es mejor que uno ideal.',
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
    id: 'q_ielts_exposicion',
    section: '📖 Tu preparación',
    title: '¿Dónde tienes contacto con el inglés fuera de clase?',
    hint: 'Todo cuenta — nos ayuda a sugerirte recursos que complementen las clases.',
    type: 'checkbox',
    options: [
      'Series, pelis o documentales en inglés',
      'Podcasts o audiolibros',
      'Lectura (libros, noticias, artículos académicos)',
      'Redes sociales o YouTube',
      'En el trabajo o los estudios',
      'Apenas tengo contacto fuera de clase',
    ],
    required: true,
  },

  // ── ✨ Una última cosa ──────────────────────────────────
  {
    id: 'q_ielts_algo_mas',
    section: '✨ Una última cosa',
    title: '¿Hay algo más que quieras contarnos antes de empezar la preparación?',
    hint: 'Experiencias previas con el IELTS, dudas, expectativas… ¡todo nos ayuda!',
    type: 'long',
    required: false,
  },
];
