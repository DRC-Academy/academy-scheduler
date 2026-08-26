import { afterEach, describe, expect, it, vi } from 'vitest';

// El módulo lee NEXT_PUBLIC_APP_URL al importarse, así que cada caso que toque
// la variable necesita reimportarlo en limpio.
async function load(envUrl?: string) {
  vi.resetModules();
  if (envUrl === undefined) vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  else vi.stubEnv('NEXT_PUBLIC_APP_URL', envUrl);
  return import('./appUrl');
}

// La URL larga y protegida que rompía los enlaces de los alumnos.
const DEPLOY_URL = 'https://academy-scheduler-aqpt-abc123-facupezzu-9302s-projects.vercel.app';
const PUBLICA    = 'https://academy-scheduler-aqpt.vercel.app';

afterEach(() => vi.unstubAllEnvs());

describe('publicBase — el origin de la petición no manda fuera de local', () => {
  it('una petición que llega por la URL de deployment devuelve igualmente la pública', async () => {
    const { publicBase } = await load();
    expect(publicBase({ url: `${DEPLOY_URL}/api/level-test/generate` })).toBe(PUBLICA);
  });

  it('una petición por la URL pública devuelve la pública', async () => {
    const { publicBase } = await load();
    expect(publicBase({ url: `${PUBLICA}/api/forms/generate-token` })).toBe(PUBLICA);
  });

  it('en local se respeta el origin, para poder probar los enlaces', async () => {
    const { publicBase } = await load();
    expect(publicBase({ url: 'http://localhost:3000/api/forms/generate-token' })).toBe('http://localhost:3000');
    expect(publicBase({ url: 'http://127.0.0.1:3000/api/x' })).toBe('http://127.0.0.1:3000');
  });

  it('sin petición, o con una URL ilegible, cae en la pública', async () => {
    const { publicBase } = await load();
    expect(publicBase()).toBe(PUBLICA);
    expect(publicBase(null)).toBe(PUBLICA);
    expect(publicBase({ url: 'no-es-una-url' })).toBe(PUBLICA);
  });
});

describe('PUBLIC_APP_URL — lectura de la variable de entorno', () => {
  it('sin variable usa el dominio de producción', async () => {
    const { PUBLIC_APP_URL } = await load();
    expect(PUBLIC_APP_URL).toBe(PUBLICA);
  });

  it('normaliza la barra final y el esquema que falta', async () => {
    expect((await load('https://gestion.drcacademy.com/')).PUBLIC_APP_URL).toBe('https://gestion.drcacademy.com');
    expect((await load('gestion.drcacademy.com')).PUBLIC_APP_URL).toBe('https://gestion.drcacademy.com');
    expect((await load('  https://gestion.drcacademy.com///  ')).PUBLIC_APP_URL).toBe('https://gestion.drcacademy.com');
  });

  it('la variable manda sobre el origin de la petición', async () => {
    const { publicBase } = await load('https://gestion.drcacademy.com');
    expect(publicBase({ url: `${DEPLOY_URL}/api/x` })).toBe('https://gestion.drcacademy.com');
  });
});

describe('isLocalHost', () => {
  it('reconoce las máquinas de desarrollo', async () => {
    const { isLocalHost } = await load();
    for (const h of ['localhost', '127.0.0.1', '::1', 'app.localhost', 'mac.local']) {
      expect(isLocalHost(h)).toBe(true);
    }
  });

  it('no confunde un host de Vercel con uno local', async () => {
    const { isLocalHost } = await load();
    expect(isLocalHost('academy-scheduler-aqpt.vercel.app')).toBe(false);
    expect(isLocalHost(new URL(DEPLOY_URL).hostname)).toBe(false);
  });
});

// El otro canal: el botón "copiar link" que usa la profesora. Aquí la trampa era
// window.location.origin — la pestaña en la que ella tenga abierta la app.
describe('publicBaseClient — el navegador tampoco manda fuera de local', () => {
  const setWindow = (href: string) => {
    // @ts-expect-error: entorno node, se simula lo justo de window.location.
    globalThis.window = { location: new URL(href) };
  };
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it('la profesora con la app abierta en la URL de deployment copia igualmente la pública', async () => {
    const { publicBaseClient } = await load();
    setWindow(`${DEPLOY_URL}/mis-alumnos`);
    expect(publicBaseClient()).toBe(PUBLICA);
  });

  it('con la app abierta en la URL pública, copia la pública', async () => {
    const { publicBaseClient } = await load();
    setWindow(`${PUBLICA}/mis-alumnos`);
    expect(publicBaseClient()).toBe(PUBLICA);
  });

  it('en local copia localhost, para poder abrir el enlace mientras se desarrolla', async () => {
    const { publicBaseClient } = await load();
    setWindow('http://localhost:3000/mis-alumnos');
    expect(publicBaseClient()).toBe('http://localhost:3000');
  });

  it('en el servidor (sin window) devuelve la pública', async () => {
    const { publicBaseClient } = await load();
    expect(publicBaseClient()).toBe(PUBLICA);
  });
});

// Los dos enlaces que de verdad recibe el alumno, de punta a punta.
describe('los enlaces que se le mandan al alumno', () => {
  it('el del test y el del formulario salen con la URL pública', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    const { publicBase } = await import('./appUrl');
    const peticion = { url: `${DEPLOY_URL}/api/cron/form-reminders` };
    expect(`${publicBase(peticion)}/test/abc-123`).toBe(`${PUBLICA}/test/abc-123`);
    expect(`${publicBase(peticion)}/formulario/abc-123`).toBe(`${PUBLICA}/formulario/abc-123`);
    expect(`${publicBase(peticion)}/progreso/abc-123`).toBe(`${PUBLICA}/progreso/abc-123`);
  });
});
