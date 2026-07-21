// Contenido del Centro de ayuda (/ayuda). Preguntas frecuentes para profesores.
// Las respuestas son texto literal (no se editan); la P10 lleva una tabla.
//
// `plain` es el texto de la respuesta SIN formato, que usa el buscador para
// filtrar y resaltar (la tabla no es buscable, pero su fila queda igualmente
// visible por la pregunta).

export type HelpCategory = 'alumnos' | 'clases' | 'ia';

export interface HelpItem {
  id: string;
  category: HelpCategory;
  question: string;
  answer: string;          // texto plano; '' cuando la respuesta es una tabla
  table?: boolean;         // la respuesta se renderiza como tabla (P10)
}

export const HELP_CATEGORIES: Array<{ id: HelpCategory; label: string }> = [
  { id: 'alumnos', label: 'Alumnos' },
  { id: 'clases',  label: 'Clases y finanzas' },
  { id: 'ia',      label: 'Sistema de IA' },
];

export const HELP_ITEMS: HelpItem[] = [
  // ── Alumnos ──
  {
    id: 'q1', category: 'alumnos',
    question: '¿Cómo añado un alumno a mi calendario?',
    answer: 'Ve a tu calendario y haz clic en cualquier celda marcada como «Libre». Se abrirá un formulario donde puedes seleccionar un alumno existente o crear uno nuevo. Una vez asignado, esa celda pasará a «Ocupado» con el nombre del alumno y el horario quedará fijo todas las semanas de forma automática.',
  },
  {
    id: 'q2', category: 'alumnos',
    question: '¿Cómo cambio el horario de un alumno?',
    answer: 'Ve a «Mis alumnos», busca al alumno y haz clic en «Editar». Desde ahí puedes modificar los horarios asignados. Los cambios se actualizan automáticamente en el calendario.',
  },
  {
    id: 'q3', category: 'alumnos',
    question: '¿Qué pasa si elimino un alumno?',
    answer: 'Al eliminar un alumno, sus celdas en tu calendario vuelven a quedar «Libres» automáticamente. Sus clases ya registradas en el sistema de finanzas se conservan para el cálculo de tu nómina del mes en curso. No se pierde el historial de pagos.',
  },
  {
    id: 'q4', category: 'alumnos',
    question: '¿Cómo envío el formulario inicial al alumno?',
    answer: 'Cuando recibes un nuevo alumno, en la sección «Avisos» aparece una notificación con el botón «Enviar formulario inicial». Al hacer clic se genera un enlace único y se abre tu gestor de correo con el mensaje ya redactado. El alumno completa el formulario desde ese enlace y tú recibes una notificación cuando termina.',
  },
  {
    id: 'q5', category: 'alumnos',
    question: '¿Cómo comparto el progreso con un alumno?',
    answer: 'Entra en la ficha del alumno desde «Mis alumnos» y haz clic en «Compartir progreso con el alumno». Se genera un enlace único que puedes enviarle por email o WhatsApp. El alumno verá su objetivo, sus puntos fuertes y el resumen de su evolución clase a clase.',
  },

  // ── Clases y finanzas ──
  {
    id: 'q6', category: 'clases',
    question: '¿Cómo registro una clase dada?',
    answer: 'Ve a «Mis alumnos», entra en la ficha del alumno y haz clic en «Registrar clase dada». Selecciona la fecha, pega el transcript de Fathom y haz clic en «Analizar y generar siguiente clase». El sistema registra la clase y genera automáticamente el plan para la próxima sesión.',
  },
  {
    id: 'q7', category: 'clases',
    question: '¿Qué necesito para que una clase sea pagable?',
    answer: 'Para que una clase cuente como pagable necesitas cumplir dos condiciones: acceder a la clase usando el botón «Ingresar a clase» en «Próximas clases», y subir el transcript de la sesión en la ficha del alumno. Si solo cumples una de las dos, la clase queda como «A revisar» y el admin puede aprobarla manualmente.',
  },
  {
    id: 'q8', category: 'clases',
    question: '¿Qué es el transcript y cómo lo subo?',
    answer: 'El transcript es el texto que genera Fathom automáticamente al finalizar una clase grabada. Para subirlo, entra en «Mis alumnos», abre la ficha del alumno y haz clic en «Registrar clase dada». En el segundo paso encontrarás un campo donde puedes pegarlo directamente.',
  },
  {
    id: 'q9', category: 'clases',
    question: '¿Cómo accedo a una clase mediante el botón?',
    answer: 'En la sección «Próximas clases» verás tus clases del día ordenadas por hora. Cada clase tiene un botón «Ingresar a clase» que abre el enlace de Meet y registra tu acceso automáticamente. Es importante usar siempre este botón en lugar de abrir Meet directamente, ya que el acceso queda registrado para el cálculo de tu nómina.',
  },
  {
    id: 'q10', category: 'clases',
    question: '¿Cuáles son las tarifas por tipo de alumno?',
    answer: 'Inglés general, Intensivos, Niños: 4,00 € con menos de 30 días y 4,50 € con más de 30 días. Exámenes: 4,50 € con menos de 30 días y 5,00 € con más de 30 días.',
    table: true,
  },
  {
    id: 'q11', category: 'clases',
    question: '¿Cuándo y cómo solicito el bono de retención?',
    answer: 'Cuando un alumno lleva 6 meses contigo, recibirás una notificación en la app y por email avisándote que tienes derecho al bono de €30. Para solicitarlo, escribe a pagos@drcacademy.com indicando el nombre del alumno y la fecha de inicio de su suscripción.',
  },
  {
    id: 'q12', category: 'clases',
    question: '¿Qué pasa si un alumno falta sin avisar?',
    answer: 'En «Mis alumnos» → «Registrar clase dada», selecciona el tipo «Falta sin aviso». Esto queda registrado como constancia. Las primeras 2 faltas sin aviso por alumno sí generan cobro con tarifa normal. A partir de la tercera, ya no cuentan para el pago.',
  },

  // ── Sistema de IA ──
  {
    id: 'q13', category: 'ia',
    question: '¿Qué es la ficha del alumno?',
    answer: 'La ficha es un perfil inteligente que se genera automáticamente cuando el alumno completa el formulario inicial. Incluye su objetivo personal, estilo de aprendizaje, puntos fuertes, áreas a trabajar y un diagnóstico inicial. Con cada clase analizada, la ficha se actualiza con el progreso real del alumno.',
  },
  {
    id: 'q14', category: 'ia',
    question: '¿Cómo genero la primera clase?',
    answer: 'Una vez que el alumno completa el formulario inicial, recibirás una notificación. Entra en su ficha desde «Mis alumnos» y verás el botón «Generar primera clase». La IA analiza el perfil del alumno y crea una clase completamente personalizada lista para usar.',
  },
  {
    id: 'q15', category: 'ia',
    question: '¿Cómo analizo una clase con el transcript?',
    answer: 'Al registrar una clase en «Registrar clase dada», pega el transcript de Fathom y haz clic en «Analizar y generar siguiente clase». La IA analiza lo que ocurrió en la sesión, detecta errores y patrones, evalúa el progreso del alumno y genera automáticamente el plan para la próxima clase.',
  },
  {
    id: 'q16', category: 'ia',
    question: '¿Qué significa la señal de riesgo verde/amarillo/rojo?',
    answer: 'La señal refleja el estado del alumno según el análisis de sus clases. Verde significa que el alumno progresa y está comprometido. Amarillo indica señales de desmotivación o dificultades que requieren tu atención. Rojo significa riesgo de baja — en ese caso el equipo de DRC también recibe una alerta para actuar.',
  },
  {
    id: 'q17', category: 'ia',
    question: '¿Cómo genero la siguiente clase?',
    answer: 'Después de analizar el transcript de una clase, aparece automáticamente la siguiente clase ya generada en la pestaña «Próxima clase» de la ficha del alumno. La IA tiene en cuenta los errores detectados, el progreso y el programa del alumno para crear una continuación coherente y personalizada.',
  },
];

// Tabla de tarifas de la P10 (fuente única para renderizarla).
export const RATE_TABLE = {
  head: ['Plan', 'Menos de 30 días', 'Más de 30 días'],
  rows: [
    ['Inglés general, Intensivos, Niños', '4,00 €', '4,50 €'],
    ['Exámenes', '4,50 €', '5,00 €'],
  ],
};

// Texto que el buscador usa para filtrar (pregunta + respuesta).
export function haystack(item: HelpItem): string {
  return `${item.question} ${item.answer}`.toLowerCase();
}
