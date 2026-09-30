// Vista previa del REDISEÑO de la ficha de progreso. Solo para revisión interna:
// los alumnos siguen viendo /progreso/[token] y /progreso-cuenta, que no cambian.
//
// Esta cáscara es de servidor solo para poder poner los metadatos (fuera de
// Google). La carga de datos y la ficha van en el cliente, igual que en
// /progreso/[token] (ver PreviewCliente).

import type { Metadata } from 'next';
import { PreviewCliente } from './PreviewCliente';

export const metadata: Metadata = {
  title: 'Vista previa · Tu progreso · DRC Academy',
  robots: { index: false, follow: false, nocache: true },
};

export default async function ProgresoPreviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PreviewCliente token={token} />;
}
