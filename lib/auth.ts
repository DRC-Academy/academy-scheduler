import { AppUser } from '@/types';

// ─────────────────────────────────────────────
// USUARIOS DEL SISTEMA
// Para cambiar una contraseña, editá el campo "password" abajo.
// Para agregar un usuario nuevo, copiá un bloque y cambiá los datos.
// ─────────────────────────────────────────────

export const USERS: AppUser[] = [
  // ── ADMIN ──────────────────────────────────
  {
    id: 'admin1',
    username: 'admin',
    password: 'admin123',
    role: 'admin',
    displayName: 'Administrador',
  },

  // ── SETTERS ────────────────────────────────
  {
    id: 'setter1',
    username: 'setter',
    password: 'setter123',
    role: 'setter',
    displayName: 'Setter',
  },
  {
    id: 'setter2',
    username: 'setter2',
    password: 'setter123',
    role: 'setter',
    displayName: 'Setter 2',
  },

  // ── PROFESORES ─────────────────────────────
  { id: 'u_t1',  username: 'sebastian',  password: 'Seba2026',   role: 'teacher', teacherId: 't1',  displayName: 'Sebastian' },
  { id: 'u_t2',  username: 'mauricio',   password: 'Mauri2026',  role: 'teacher', teacherId: 't2',  displayName: 'Mauricio' },
  { id: 'u_t3',  username: 'johny',      password: 'Johny2026',  role: 'teacher', teacherId: 't3',  displayName: 'Johny' },
  { id: 'u_t4',  username: 'barbara',    password: 'Barb2026',   role: 'teacher', teacherId: 't4',  displayName: 'Barbara' },
  { id: 'u_t5',  username: 'ana',        password: 'Ana2026',    role: 'teacher', teacherId: 't5',  displayName: 'Ana' },
  { id: 'u_t6',  username: 'ignacio',    password: 'Igna2026',   role: 'teacher', teacherId: 't6',  displayName: 'Ignacio' },
  { id: 'u_t7',  username: 'daianam',    password: 'Daiana2026', role: 'teacher', teacherId: 't7',  displayName: 'Daiana M.' },
  { id: 'u_t8',  username: 'victoria',   password: 'Vicky2026',  role: 'teacher', teacherId: 't8',  displayName: 'Victoria' },
  { id: 'u_t9',  username: 'silvia',     password: 'Silvi2026',  role: 'teacher', teacherId: 't9',  displayName: 'Silvia' },
  { id: 'u_t10', username: 'solg',       password: 'SolG2026',   role: 'teacher', teacherId: 't10', displayName: 'Sol G.' },
  { id: 'u_t11', username: 'milagros',   password: 'Mili2026',   role: 'teacher', teacherId: 't11', displayName: 'Milagros' },
  { id: 'u_t12', username: 'mflorencia', password: 'Flor2026',   role: 'teacher', teacherId: 't12', displayName: 'M. Florencia' },
  { id: 'u_t13', username: 'sol',        password: 'Sol2026',    role: 'teacher', teacherId: 't13', displayName: 'Sol' },
  { id: 'u_t14', username: 'cristian',   password: 'Cris2026',   role: 'teacher', teacherId: 't14', displayName: 'Cristian' },
  { id: 'u_t15', username: 'danielan',   password: 'DaniN2026',  role: 'teacher', teacherId: 't15', displayName: 'Daniela N.' },
  { id: 'u_t16', username: 'rebeca',     password: 'Rebe2026',   role: 'teacher', teacherId: 't16', displayName: 'Rebeca' },
  { id: 'u_t17', username: 'marina',     password: 'Mari2026',   role: 'teacher', teacherId: 't17', displayName: 'Marina' },
  { id: 'u_t18', username: 'jimena',     password: 'Jime2026',   role: 'teacher', teacherId: 't18', displayName: 'Jimena' },
  { id: 'u_t19', username: 'daniela',    password: 'Dani2026',   role: 'teacher', teacherId: 't19', displayName: 'Daniela' },
  { id: 'u_t20', username: 'antonella',  password: 'Anto2026',   role: 'teacher', teacherId: 't20', displayName: 'Antonella' },
  { id: 'u_t21', username: 'wanda',      password: 'Wanda2026',  role: 'teacher', teacherId: 't21', displayName: 'Wanda' },
  { id: 'u_t22', username: 'luciana',    password: 'Lucy2026',   role: 'teacher', teacherId: 't22', displayName: 'Luciana' },
  { id: 'u_t23', username: 'agustin',    password: 'Agus2026',   role: 'teacher', teacherId: 't23', displayName: 'Agustín' },
  { id: 'u_t24', username: 'liliana',    password: 'Lili2026',   role: 'teacher', teacherId: 't24', displayName: 'Liliana' },
  { id: 'u_t25', username: 'dana',       password: 'Dana2026',   role: 'teacher', teacherId: 't25', displayName: 'Dana' },
  { id: 'u_t26', username: 'vanesa',     password: 'Vane2026',   role: 'teacher', teacherId: 't26', displayName: 'Vanesa' },
  { id: 'u_t27', username: 'carmela',    password: 'Carme2026',  role: 'teacher', teacherId: 't27', displayName: 'Carmela' },
  { id: 'u_t28', username: 'chiara',     password: 'Chiara2026', role: 'teacher', teacherId: 't28', displayName: 'Chiara' },
  { id: 'u_t29', username: 'maribel',    password: 'Mabel2026',  role: 'teacher', teacherId: 't29', displayName: 'Maribel' },
  { id: 'u_t30', username: 'daiana',     password: 'Daiana2026', role: 'teacher', teacherId: 't30', displayName: 'Daiana' },
];

export function authenticate(username: string, password: string): AppUser | null {
  const u = USERS.find(
    u => u.username.toLowerCase() === username.toLowerCase().trim() && u.password === password
  );
  return u ?? null;
}
