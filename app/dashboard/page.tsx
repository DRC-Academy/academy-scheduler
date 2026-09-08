'use client';

// Dashboard general del negocio: la pantalla de entrada del admin.
//
// Era la pestaña "Resumen" de /admin. Se separó en septiembre de 2026 porque es
// lo que se mira todos los días y estaba escondida detrás de una pestaña entre
// otras once. El contenido vive en components/admin/DashboardGeneral; esta página
// solo pone el marco (barra, título, tirar para recargar) y el guardián de rol.
//
// SOLO ADMIN. `AuthGuard` manda a cada rol a su pantalla si entra acá por error:
// el profesor a su calendario y el setter a su buscador.

import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { useTeachers } from '@/lib/TeachersContext';
import DashboardGeneral from '@/components/admin/DashboardGeneral';

function DashboardContent() {
  const { teachers, students, assignments, reloadAll } = useTeachers();

  return (
    <div style={{ minHeight: '100vh', background: '#f4f5f2' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div className="adm">
          <div className="adm-head">
            <div>
              <h1 className="adm-title">Dashboard</h1>
              <p className="adm-sub">
                {teachers.length} profesores · {students.length} alumnos · {assignments.length} asignaciones
              </p>
            </div>
          </div>

          <DashboardGeneral />
        </div>
      </PullToRefresh>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AuthGuard allowedRoles={['admin']}>
      <DashboardContent />
    </AuthGuard>
  );
}
