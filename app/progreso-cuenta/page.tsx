// ── La ficha de progreso dentro de "Mi cuenta" de WooCommerce ─────────────────
//
// LA MISMA ficha que /progreso/[token] (components/ProgresoFicha), pero:
//
//   · el alumno se identifica por EMAIL, no por token — el de su cuenta de
//     WooCommerce, que WordPress firma y manda en la URL;
//   · sin cabecera ni menú: vive en un iframe dentro del Escritorio de Mi cuenta,
//     que ya tiene su propia cabecera;
//   · TODO en el servidor. El secreto de la firma y la service role key no salen
//     de aquí, y el navegador del alumno recibe HTML, no una clave con la que
//     pedirle a la base los datos de otro.
//
// POR QUÉ LA FIRMA. El email viaja en la URL: sin firmar, cambiarlo por otro
// mostraría la ficha de un desconocido. No sirve fiarse de que el alumno esté
// logueado en WooCommerce, porque esa sesión es de otro dominio y este servidor no
// la ve. WordPress y este software comparten PROGRESO_SECRET y cada enlace lleva un
// HMAC del email y de un sello de tiempo. Ver lib/progresoSignature.
//
// SIN DATOS SI ALGO FALLA. Cualquier motivo de rechazo —firma mala, enlace viejo,
// falta de configuración— acaba en la misma pantalla amable, sin decir cuál fue.
// Distinguirlos le diría a quien prueba emails al azar cuáles existen.

import type { Metadata } from 'next';
import { ProgresoFicha, ProgresoStyles } from '@/components/ProgresoFicha';
import { ProgresoAltura } from '@/components/ProgresoAltura';
import { verifyProgresoLink } from '@/lib/progresoSignature';
import { findStudentsByEmail, loadProgresoFor, type ProgresoStudent } from '@/lib/progresoAccount';

// Fuera de Google: es la ficha privada de un alumno. Además no está enlazada desde
// ningún menú de la app.
export const metadata: Metadata = {
  title: 'Tu progreso · DRC Academy',
  robots: { index: false, follow: false, nocache: true },
};

/** Email de contacto que se ofrece cuando no encontramos al alumno. */
const CONTACTO = 'info@drcacademy.com';

/** Un parámetro de la URL puede llegar repetido; se usa el primero. */
function uno(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * La cáscara sin cabecera. `pg-page` es obligatorio: ahí viven el fondo #F7F7F5,
 * la tipografía Radio Canada y las variables de color que usa toda la ficha.
 */
function Marco({ children }: { children: React.ReactNode }) {
  return (
    <div className="pg-page pg-embed">
      <ProgresoStyles />
      {/* `min-height: 100dvh` de .pg-page dejaría el iframe siempre a la altura de
          la pantalla y pelearía con el ajuste automático; dentro del marco el alto
          lo manda el contenido. Y sin cabecera, el aire de arriba sobra. */}
      <style>{`
        .pg-embed { min-height: 0; }
        .pg-embed .pg-main { padding-top: 20px; padding-bottom: 28px; }
        @media (max-width: 720px) { .pg-embed .pg-main { padding-top: 14px; padding-bottom: 20px; } }
      `}</style>
      <main className="pg-main">{children}</main>
      <ProgresoAltura />
    </div>
  );
}

/** Enlace caducado o firma que no cuadra. Sin tecnicismos: no son del alumno. */
function Caducado() {
  return (
    <div className="pg-notice">
      <strong>Este enlace ha caducado.</strong>
      <span>Recarga la página de Mi cuenta y volverá a aparecer tu progreso.</span>
    </div>
  );
}

/** El email es válido pero no hay ningún alumno con él. */
function SinFicha() {
  return (
    <div className="pg-notice">
      <strong>Todavía no tenemos tu ficha de progreso.</strong>
      <span>
        Se crea a partir de tus primeras clases. Si ya has empezado, escríbenos a{' '}
        <a href={`mailto:${CONTACTO}`} style={{ color: 'var(--pg-green-dark)', fontWeight: 600 }}>{CONTACTO}</a>{' '}
        y lo revisamos.
      </span>
    </div>
  );
}

/**
 * Dos alumnos con el mismo email (una familia con dos hijos en la academia). No se
 * enseña nada de ninguno hasta que elige: la ficha es individual.
 *
 * Los enlaces repiten la firma tal cual y añaden `alumno`. La firma cubre el email y
 * el sello de tiempo, así que sigue valiendo — pero el sello sigue corriendo: si
 * tarda más de diez minutos en elegir, verá "caducado" y bastará con recargar.
 */
function Selector({ students, email, ts, sig }: {
  students: ProgresoStudent[]; email: string; ts: string; sig: string;
}) {
  return (
    <div className="pg-card">
      <p className="pg-kicker">¿De quién quieres ver el progreso?</p>
      <p className="pg-body" style={{ marginTop: 6, marginBottom: 16 }}>
        Con este correo hay más de un alumno en la academia.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {students.map(s => {
          const q = new URLSearchParams({ email, ts, sig, alumno: s.id });
          return (
            <a key={s.id} href={`/progreso-cuenta?${q.toString()}`}
              style={{
                display: 'block', padding: '13px 16px', borderRadius: 12,
                border: '1.5px solid var(--pg-line)', background: 'var(--pg-surface)',
                color: 'var(--pg-ink)', textDecoration: 'none', fontSize: 15, fontWeight: 600,
              }}>
              {s.name}
            </a>
          );
        })}
      </div>
    </div>
  );
}

export default async function ProgresoCuentaPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const ts = uno(sp.ts);
  const sig = uno(sp.sig);

  // 1) LA FIRMA, ANTES DE TOCAR LA BASE. Sin ella no se consulta nada.
  const verdict = verifyProgresoLink({ email: uno(sp.email), ts, sig });
  if (!verdict.ok) return <Marco><Caducado /></Marco>;

  // 2) EL ALUMNO, por email normalizado y en las dos columnas donde vive.
  const lookup = await findStudentsByEmail(verdict.email);
  if (lookup.kind === 'sin_configurar') return <Marco><Caducado /></Marco>;
  if (lookup.kind === 'no_encontrado') return <Marco><SinFicha /></Marco>;

  let student: ProgresoStudent;
  if (lookup.kind === 'varios') {
    const elegido = uno(sp.alumno);
    // El id elegido TIENE que ser uno de los que salieron de este email. Sin esta
    // comprobación, `alumno=<cualquier id>` sería una puerta a cualquier ficha con
    // una sola firma válida.
    const encontrado = lookup.students.find(s => s.id === elegido);
    if (!encontrado) {
      return <Marco><Selector students={lookup.students} email={verdict.email} ts={ts} sig={sig} /></Marco>;
    }
    student = encontrado;
  } else {
    student = lookup.student;
  }

  // 3) LOS DATOS, con las mismas columnas que /progreso/[token]. Nunca el transcript.
  const payload = await loadProgresoFor(student);
  if (!payload) return <Marco><Caducado /></Marco>;

  return (
    <Marco>
      <ProgresoFicha
        studentName={payload.student.name}
        profile={payload.profile}
        analyses={payload.analyses}
        assignment={payload.assignment}
        student={payload.studentLite}
      />
    </Marco>
  );
}
