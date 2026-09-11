'use client';

// BARRA INFERIOR DEL ADMIN EN EL TELÉFONO, en TODAS las pantallas.
//
// La monta el NavBar (que está en todas las páginas) solo para el rol admin y
// por debajo de 768 px, así la navegación no desaparece al cambiar de pantalla:
// Inicio · Admin · Alumnos · Finanzas siempre a un toque, y "Más" con el resto
// (Buscar, Próximos a cancelar, Ayuda, Salir).
//
// La única pantalla que NO la muestra es /admin, que tiene su propia barra de
// secciones (components/admin/AdminNavMovil): dos barras apiladas se comerían
// un tercio de la pantalla. Desde ahí se vuelve con "Volver" o con "Más".
//
// Mientras está montada, el body deja sitio abajo para que ningún contenido
// quede detrás de la barra.

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Settings, Users, Wallet, MoreHorizontal, Search, CalendarClock, LifeBuoy, LogOut, ChevronRight, X } from 'lucide-react';

const FIJAS = [
  { href: '/dashboard', label: 'Inicio',   Icon: LayoutDashboard },
  { href: '/admin',     label: 'Admin',    Icon: Settings },
  { href: '/students',  label: 'Alumnos',  Icon: Users },
  { href: '/finanzas',  label: 'Finanzas', Icon: Wallet },
];
const MAS = [
  { href: '/setter',            label: 'Buscar',              Icon: Search },
  { href: '/proximos-cancelar', label: 'Próximos a cancelar', Icon: CalendarClock },
  { href: '/ayuda',             label: 'Centro de ayuda',     Icon: LifeBuoy },
];

export function AdminBottomNav({ badgeFinanzas = 0, onLogout }: { badgeFinanzas?: number; onLogout: () => void }) {
  const path = usePathname();
  const [masAbierto, setMasAbierto] = useState(false);
  const activo = (href: string) => path === href || (href !== '/dashboard' && path.startsWith(href + '/'));
  const enMas = MAS.some(m => activo(m.href));

  return (
    <div className="abn">
      {masAbierto && (
        <>
          <div className="abn-scrim" onClick={() => setMasAbierto(false)} />
          <div className="abn-sheet" role="dialog" aria-label="Más pantallas">
            <div className="abn-grab" />
            <div className="abn-sheet-h">
              <h2 className="abn-sheet-t">Más</h2>
              <button type="button" className="abn-sheet-x" onClick={() => setMasAbierto(false)} aria-label="Cerrar"><X size={20} strokeWidth={2} /></button>
            </div>
            <div className="abn-rows">
              {MAS.map(({ href, label, Icon }) => (
                <Link key={href} href={href} className={`abn-row${activo(href) ? ' is-cur' : ''}`} onClick={() => setMasAbierto(false)}>
                  <Icon size={20} strokeWidth={1.75} aria-hidden />
                  <span className="abn-row-l">{label}</span>
                  <ChevronRight size={18} strokeWidth={2} aria-hidden className="abn-chev" />
                </Link>
              ))}
              <button type="button" className="abn-row" onClick={() => { setMasAbierto(false); onLogout(); }}>
                <LogOut size={20} strokeWidth={1.75} aria-hidden />
                <span className="abn-row-l">Salir</span>
              </button>
            </div>
          </div>
        </>
      )}

      <nav className="abn-bar" aria-label="Navegación principal">
        {FIJAS.map(({ href, label, Icon }) => {
          const on = activo(href);
          const badge = href === '/finanzas' ? badgeFinanzas : 0;
          return (
            <Link key={href} href={href} className={`abn-bi${on ? ' is-on' : ''}`} aria-current={on ? 'page' : undefined}>
              <span className="abn-bi-ic">
                <Icon size={22} strokeWidth={on ? 2.25 : 1.75} aria-hidden />
                {badge > 0 && <span className="abn-badge">{badge}</span>}
              </span>
              <span className="abn-bi-l">{label}</span>
            </Link>
          );
        })}
        <button type="button" className={`abn-bi${enMas || masAbierto ? ' is-on' : ''}`} onClick={() => setMasAbierto(o => !o)} aria-expanded={masAbierto}>
          <span className="abn-bi-ic"><MoreHorizontal size={22} strokeWidth={2} aria-hidden /></span>
          <span className="abn-bi-l">Más</span>
        </button>
      </nav>

      <style>{ESTILOS}</style>
    </div>
  );
}

const ESTILOS = `
.abn { display: none; }
@media (max-width: 767.98px) {
  .abn { display: block; font-family: var(--font-app); }
  body { padding-bottom: calc(68px + env(safe-area-inset-bottom)); }

  .abn-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 46; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); height: calc(68px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); background: #fff; border-top: 1px solid var(--border); }
  .abn-bi { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 44px; padding: 0 2px; border: none; background: transparent; font-family: inherit; font-size: 11.5px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; color: var(--text-muted); text-decoration: none; cursor: pointer; }
  .abn-bi.is-on { color: var(--accent); }
  .abn-bi-ic { position: relative; width: 26px; height: 26px; display: grid; place-items: center; }
  .abn-badge { position: absolute; top: -8px; left: 16px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: rgba(255,196,0,0.22); color: #8a6d00; border: 1px solid rgba(255,196,0,0.5); font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }

  .abn-scrim { position: fixed; left: 0; right: 0; top: 0; bottom: calc(68px + env(safe-area-inset-bottom)); z-index: 44; background: rgba(26,26,26,0.38); }
  .abn-sheet { position: fixed; left: 0; right: 0; bottom: calc(68px + env(safe-area-inset-bottom)); z-index: 45; background: #fff; border-radius: 18px 18px 0 0; box-shadow: 0 -8px 24px rgba(0,0,0,0.12); padding: 8px 8px 12px; }
  .abn-grab { width: 40px; height: 4px; border-radius: 2px; background: var(--border-light); margin: 4px auto 6px; }
  .abn-sheet-h { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 6px; }
  .abn-sheet-t { margin: 0; font-size: 17px; font-weight: 700; color: var(--text-primary); }
  .abn-sheet-x { width: 44px; height: 44px; display: grid; place-items: center; border: none; background: transparent; color: var(--text-muted); cursor: pointer; margin-right: -8px; }
  .abn-rows { display: flex; flex-direction: column; }
  .abn-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 4px 8px 4px 12px; border: none; border-top: 1px solid #ECECE8; background: transparent; font-family: inherit; font-size: 15px; font-weight: 500; color: var(--text-primary); text-align: left; text-decoration: none; cursor: pointer; border-radius: 8px; }
  .abn-rows .abn-row:first-child { border-top: 0; }
  .abn-row.is-cur { background: #eef6ef; color: #15803d; font-weight: 600; }
  .abn-row-l { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .abn-chev { color: var(--text-muted); flex-shrink: 0; }
}
`;
