// Fuente única de las especialidades. Antes esta lista y su estilo estaban
// duplicados en app/teacher/page.tsx y app/admin/page.tsx, y las dos copias ya
// habían empezado a divergir (fontSize 11 vs 10, padding distinto).
export const ALL_SPECIALTIES = ['Adultos', 'Niños', 'Exámenes'] as const;

export type Specialty = typeof ALL_SPECIALTIES[number];
