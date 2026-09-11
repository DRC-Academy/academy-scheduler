'use client';

// NAVEGACIÓN DE /admin EN EL TELÉFONO (por debajo de 768 px).
//
// En escritorio las doce secciones son una fila de pestañas. En el teléfono esa
// fila no entraba: obligaba a deslizar de costado, no se veía cuántas
// secciones había ni dónde estaba uno parado, y los contadores (Validación con
// 36) quedaban escondidos. Esto lo reemplaza con la opción elegida en el lienzo
// "Navegación de Admin en el móvil" (sep/2026):
//
//   · Arriba: "‹ Volver" (44 px) a la izquierda, "Admin · Tema" a la derecha y
//     el nombre de la sección con su contador. Siempre se sabe dónde se está.
//   · Abajo, fija: las cuatro secciones más usadas (Validación, Riesgo,
//     Profesores, Emails) con sus contadores, y "Más", que abre las otras ocho
//     agrupadas por tema. Los contadores se ven sin abrir nada.
//   · Cero deslizamiento horizontal; zonas táctiles de 44 px; zona segura del
//     iPhone respetada.
//
// Este componente NO decide qué se muestra: recibe la sección activa y los
// contadores, y avisa con `onSelect`/`onVolver`. El contenido de cada sección
// sigue siendo el de la página. En escritorio no se pinta (display: none).

import { useState } from 'react';
import Link from 'next/link';
import { ClipboardCheck, AlertTriangle, Users, Mail, MoreHorizontal, ChevronLeft, ChevronRight, X } from 'lucide-react';

/** Las otras pantallas del admin, al final de "Más": acá la barra global no se
 *  pinta (dos barras apiladas no caben), así que este es el atajo. */
const OTRAS_PANTALLAS = [
  { href: '/dashboard', label: 'Inicio (Dashboard)' },
  { href: '/students',  label: 'Alumnos' },
  { href: '/finanzas',  label: 'Finanzas' },
  { href: '/setter',    label: 'Buscar' },
  { href: '/ayuda',     label: 'Centro de ayuda' },
];

export type AdminTabId =
  | 'teachers' | 'emails' | 'scoring' | 'tracking' | 'classlog' | 'leveltests'
  | 'validacion' | 'ai' | 'aiusage' | 'bajas' | 'notifications';

/** Contadores de pendientes. null = todavía cargando (se muestra sin número). */
export interface AdminContadores {
  validacion: number;
  /** Ámbar cuando la cola lleva días; gris si es reciente. */
  validacionUrgente: boolean;
  riesgo: number | null;
  emails: number;
  proximosACancelar: number;
}

// ─── Las secciones, agrupadas por tema ───────────────────────────────────────
// "Próximos a cancelar" es una ruta aparte (/proximos-cancelar), pero para el
// admin es una sección más de Alumnos: va en "Más" como enlace.
interface Seccion { id: AdminTabId | 'proximos'; label: string; href?: string }
const GRUPOS: Array<{ nombre: string; secciones: Seccion[] }> = [
  { nombre: 'Alumnos', secciones: [
    { id: 'tracking', label: 'Seguimiento' },
    { id: 'leveltests', label: 'Tests de nivel' },
    { id: 'ai', label: 'Riesgo' },
    { id: 'proximos', label: 'Próximos a cancelar', href: '/proximos-cancelar' },
    { id: 'bajas', label: 'Bajas' },
  ] },
  { nombre: 'Profesores', secciones: [
    { id: 'teachers', label: 'Profesores' },
    { id: 'scoring', label: 'Scoring' },
    { id: 'aiusage', label: 'Uso de IA' },
  ] },
  { nombre: 'Clases', secciones: [
    { id: 'classlog', label: 'Registro de clases' },
    { id: 'validacion', label: 'Validación' },
  ] },
  { nombre: 'Avisos', secciones: [
    { id: 'emails', label: 'Emails' },
    { id: 'notifications', label: 'Notificaciones' },
  ] },
];
const GRUPO_DE: Record<string, string> = Object.fromEntries(GRUPOS.flatMap(g => g.secciones.map(s => [s.id, g.nombre])));
const LABEL_DE: Record<string, string> = Object.fromEntries(GRUPOS.flatMap(g => g.secciones.map(s => [s.id, s.label])));

/** Las cuatro fijas de la barra; el resto va detrás de "Más". */
const FIJAS: AdminTabId[] = ['validacion', 'ai', 'teachers', 'emails'];

function Contador({ n, tono }: { n: number | null | undefined; tono: 'rojo' | 'ambar' | 'gris' }) {
  if (!n) return null;
  return <span className={`anm-badge is-${tono}`}>{n}</span>;
}

function contadorDe(id: string, c: AdminContadores): { n: number | null; tono: 'rojo' | 'ambar' | 'gris' } | null {
  switch (id) {
    case 'validacion': return { n: c.validacion, tono: c.validacionUrgente ? 'ambar' : 'gris' };
    case 'ai':         return { n: c.riesgo, tono: 'rojo' };
    case 'emails':     return { n: c.emails, tono: 'rojo' };
    case 'proximos':   return { n: c.proximosACancelar, tono: 'ambar' };
    default:           return null;
  }
}

export function AdminNavMovil({ activeTab, contadores, onSelect, onVolver, children }: {
  activeTab: AdminTabId;
  contadores: AdminContadores;
  onSelect: (tab: AdminTabId) => void;
  onVolver: () => void;
  /** Acción propia de la sección (p. ej. "Nuevo profesor"), debajo del título. */
  children?: React.ReactNode;
}) {
  const [masAbierto, setMasAbierto] = useState(false);
  const enFijas = FIJAS.includes(activeTab);
  const actual = contadorDe(activeTab, contadores);
  // Lo que espera detrás de "Más": hoy solo Próximos a cancelar lleva contador.
  const pendientesMas = contadores.proximosACancelar;

  const elegir = (id: AdminTabId) => { setMasAbierto(false); onSelect(id); };

  const ICONO: Record<AdminTabId, React.ReactNode> = {
    validacion: <ClipboardCheck size={22} strokeWidth={1.75} aria-hidden />,
    ai: <AlertTriangle size={22} strokeWidth={1.75} aria-hidden />,
    teachers: <Users size={22} strokeWidth={1.75} aria-hidden />,
    emails: <Mail size={22} strokeWidth={1.75} aria-hidden />,
    scoring: null, tracking: null, classlog: null, leveltests: null, aiusage: null, bajas: null, notifications: null,
  };

  return (
    <div className="anm">
      {/* ── Cabecera de la sección ── */}
      <div className="anm-head">
        <div className="anm-head-row">
          <button type="button" className="anm-volver" onClick={onVolver}>
            <ChevronLeft size={20} strokeWidth={2.25} aria-hidden /> Volver
          </button>
          <span className="anm-donde">Admin{enFijas ? '' : ` · ${GRUPO_DE[activeTab]}`}</span>
        </div>
        <div className="anm-title">
          <h1 className="anm-h1">{LABEL_DE[activeTab]}</h1>
          {actual && <Contador n={actual.n} tono={actual.tono} />}
        </div>
        {children}
      </div>

      {/* ── "Más": las otras ocho, por tema ── */}
      {masAbierto && (
        <>
          <div className="anm-scrim" onClick={() => setMasAbierto(false)} />
          <div className="anm-sheet" role="dialog" aria-label="Más secciones">
            <div className="anm-grab" />
            <div className="anm-sheet-h">
              <h2 className="anm-sheet-t">Más secciones</h2>
              <button type="button" className="anm-sheet-x" onClick={() => setMasAbierto(false)} aria-label="Cerrar"><X size={20} strokeWidth={2} /></button>
            </div>
            {GRUPOS.map(g => {
              const secs = g.secciones.filter(s => !FIJAS.includes(s.id as AdminTabId));
              if (!secs.length) return null;
              return (
                <div key={g.nombre}>
                  <p className="anm-grp">{g.nombre}</p>
                  <div className="anm-rows">
                    {secs.map(s => {
                      const c = contadorDe(s.id, contadores);
                      const inner = <><span className="anm-row-l">{s.label}</span>{c && <Contador n={c.n} tono={c.tono} />}<ChevronRight size={18} strokeWidth={2} aria-hidden className="anm-chev" /></>;
                      return s.href
                        ? <Link key={s.id} href={s.href} className="anm-row">{inner}</Link>
                        : <button key={s.id} type="button" className={`anm-row${activeTab === s.id ? ' is-cur' : ''}`} onClick={() => elegir(s.id as AdminTabId)}>{inner}</button>;
                    })}
                  </div>
                </div>
              );
            })}
            <p className="anm-grp">Otras pantallas</p>
            <div className="anm-rows">
              {OTRAS_PANTALLAS.map(o => (
                <Link key={o.href} href={o.href} className="anm-row"><span className="anm-row-l">{o.label}</span><ChevronRight size={18} strokeWidth={2} aria-hidden className="anm-chev" /></Link>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Barra inferior fija ── */}
      <nav className="anm-bar" aria-label="Secciones de Admin">
        {FIJAS.map(id => {
          const c = contadorDe(id, contadores);
          return (
            <button key={id} type="button" className={`anm-bi${activeTab === id ? ' is-on' : ''}`} onClick={() => elegir(id)} aria-current={activeTab === id ? 'page' : undefined}>
              <span className="anm-bi-ic">{ICONO[id]}{c && <Contador n={c.n} tono={c.tono} />}</span>
              <span className="anm-bi-l">{LABEL_DE[id]}</span>
            </button>
          );
        })}
        <button type="button" className={`anm-bi${!enFijas || masAbierto ? ' is-on' : ''}`} onClick={() => setMasAbierto(o => !o)} aria-expanded={masAbierto}>
          <span className="anm-bi-ic"><MoreHorizontal size={22} strokeWidth={2} aria-hidden /><Contador n={pendientesMas} tono="ambar" /></span>
          <span className="anm-bi-l">Más</span>
        </button>
      </nav>

      <style>{ESTILOS}</style>
    </div>
  );
}

// Solo por debajo de 768 px. Mientras esto está montado (solo en /admin) la fila
// de pestañas y la cabecera de escritorio se ocultan en el teléfono, y la
// página deja sitio abajo para la barra.
const ESTILOS = `
.anm { display: none; }
@media (max-width: 767.98px) {
  .anm { display: block; font-size: 14px; }
  .adm-tabs, .adm-head { display: none !important; }
  .adm { padding-bottom: calc(84px + env(safe-area-inset-bottom)) !important; }

  .anm-head { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
  .anm-head-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .anm-volver { display: inline-flex; align-items: center; gap: 2px; min-height: 44px; padding: 0 10px 0 0; border: none; background: transparent; font-family: inherit; font-size: 15px; font-weight: 600; color: var(--accent); cursor: pointer; }
  .anm-donde { font-size: 13.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .anm-title { display: flex; align-items: center; gap: 10px; }
  .anm-h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.015em; }

  .anm-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 7px; border-radius: 999px; font-size: 12.5px; font-weight: 700; }
  .anm-badge.is-ambar { background: rgba(255,196,0,0.22); color: #8a6d00; border: 1px solid rgba(255,196,0,0.5); }
  .anm-badge.is-rojo { background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger-border); }
  .anm-badge.is-gris { background: var(--bg-surface-3); color: var(--text-secondary); border: 1px solid transparent; }

  .anm-scrim { position: fixed; left: 0; right: 0; top: 0; bottom: calc(68px + env(safe-area-inset-bottom)); z-index: 44; background: rgba(26,26,26,0.38); }
  .anm-sheet { position: fixed; left: 0; right: 0; bottom: calc(68px + env(safe-area-inset-bottom)); z-index: 45; background: #fff; border-radius: 18px 18px 0 0; box-shadow: 0 -8px 24px rgba(0,0,0,0.12); padding: 8px 8px 12px; max-height: calc(100dvh - 140px); overflow-y: auto; }
  .anm-grab { width: 40px; height: 4px; border-radius: 2px; background: var(--border-light); margin: 4px auto 6px; }
  .anm-sheet-h { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 6px; }
  .anm-sheet-t { margin: 0; font-size: 17px; font-weight: 700; }
  .anm-sheet-x { width: 44px; height: 44px; display: grid; place-items: center; border: none; background: transparent; color: var(--text-muted); cursor: pointer; margin-right: -8px; }
  .anm-grp { margin: 0; padding: 8px 8px 4px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
  .anm-rows { display: flex; flex-direction: column; }
  .anm-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 46px; padding: 4px 8px 4px 14px; border: none; border-top: 1px solid #ECECE8; background: transparent; font-family: inherit; font-size: 15px; font-weight: 500; color: var(--text-primary); text-align: left; text-decoration: none; cursor: pointer; border-radius: 8px; }
  .anm-rows .anm-row:first-child { border-top: 0; }
  .anm-row.is-cur { background: #eef6ef; color: #15803d; font-weight: 600; }
  .anm-row-l { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .anm-chev { color: var(--text-muted); flex-shrink: 0; }

  .anm-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 46; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); height: calc(68px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); background: #fff; border-top: 1px solid var(--border); }
  .anm-bi { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 44px; padding: 0 2px; border: none; background: transparent; font-family: inherit; font-size: 11.5px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; color: var(--text-muted); cursor: pointer; }
  .anm-bi.is-on { color: var(--accent); }
  .anm-bi-ic { position: relative; width: 26px; height: 26px; display: grid; place-items: center; }
  .anm-bi-ic .anm-badge { position: absolute; top: -8px; left: 16px; min-width: 18px; height: 18px; padding: 0 5px; font-size: 11px; }
}
`;
