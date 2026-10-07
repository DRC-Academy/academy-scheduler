// Dependencias de la transferencia en el NAVEGADOR (modal del panel).
//
// Resend solo existe en el servidor, así que los dos correos salen por las rutas
// de siempre: /api/emails (profesor nuevo) y /api/assignments/:id/welcome-email
// (bienvenida del alumno). Ninguna de las dos lanza: un fallo de correo no rompe
// la transferencia.

import { triggerEmail } from '@/lib/emailClient';
import { triggerWelcomeEmail } from '@/lib/welcomeEmail';
import type { TransferenciaDeps } from '@/lib/transferencia/core';

export const depsNavegador: TransferenciaDeps = {
  enviarEmailProfeNuevo: d => triggerEmail({
    type:         'new_student',
    teacherId:    d.teacherId,
    studentName:  d.studentName,
    studentEmail: d.studentEmail,
    plan:         d.plan,
    level:        d.level,
    slots:        d.slots,
    startDate:    d.startDate,
  }),
  enviarBienvenidaAlumno: assignmentId => triggerWelcomeEmail(assignmentId, 'cambio_profesor'),
};
