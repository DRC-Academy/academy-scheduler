# La ficha de progreso dentro de "Mi cuenta" de WooCommerce

Guía para quien trabaja en WordPress (drcacademy.com) y no tiene acceso al repositorio
del software de gestión.

---

## 1. Qué es y cómo funciona la seguridad

Cada alumno tiene una **ficha de progreso**: su nivel actual, lo que ya domina, lo que
está reforzando, las clases que lleva y hacia dónde va. Esa ficha la genera el software
de gestión de la academia, que es otra aplicación en otro dominio. Lo que vamos a hacer
es **mostrarla dentro del Escritorio de "Mi cuenta"**, en un recuadro (un `iframe`), para
que el alumno la vea donde ya entra a gestionar su suscripción, sin un segundo login y
sin salir de la web.

El problema a resolver es quién puede ver qué. La ficha se pide con el **email** del
alumno, y el email va en la dirección del recuadro. Si no hiciéramos nada más,
cualquiera podría cambiar ese email por el de otra persona y ver su ficha. Y no vale
que el software "compruebe si está logueado", porque la sesión de WordPress es de otro
dominio y esa otra aplicación no la puede ver.

La solución es una **firma**. WordPress y el software comparten una contraseña larga que
solo conocen ellos dos (`DRC_PROGRESO_SECRET`). Cada vez que se pinta la página, WordPress
coge el email del usuario logueado, le añade la hora actual y calcula con esa contraseña
un código que no se puede falsificar. El software recalcula ese código y solo enseña la
ficha si coincide. Como la hora va dentro de la firma, **un enlace copiado deja de
funcionar en 10 minutos**: sirve para cargar el recuadro y nada más. Quien no tenga la
contraseña compartida no puede fabricar un enlace válido para otro email.

---

## 2. La variable `PROGRESO_SECRET`

Es la contraseña compartida. **El mismo valor tiene que estar en los dos sitios.**

### Generarla

32 bytes aleatorios en hexadecimal. En una terminal:

```bash
openssl rand -hex 32
```

Sale algo como `9f2c41ab...` (64 caracteres). Ese es el valor.

### Dónde ponerla

**En el software de gestión (Vercel):** Project → Settings → Environment Variables

| Nombre | Valor |
|---|---|
| `PROGRESO_SECRET` | el valor generado |
| `SUPABASE_SERVICE_ROLE_KEY` | la clave `service_role` del proyecto de Supabase |

> La segunda no es opcional: sin ella la página no puede buscar al alumno y el recuadro
> saldrá con el mensaje de enlace caducado. Está en Supabase → Project Settings → API →
> `service_role`.

**En WordPress:** en `wp-config.php`, antes de la línea que dice
`/* That's all, stop editing! */`:

```php
define( 'DRC_PROGRESO_SECRET', 'PEGA_AQUI_EL_MISMO_VALOR' );
define( 'DRC_PROGRESO_URL', 'https://academy-scheduler-aqpt.vercel.app' );
```

No pongas el secreto dentro del snippet de Code Snippets: en `wp-config.php` no se ve
desde el panel de administración.

---

## 3. El snippet PHP

Plugin **Code Snippets** → *Add New* → pegar esto → *Run snippet everywhere* → *Save and
Activate*.

Va enganchado a `woocommerce_account_dashboard`, así que la ficha aparece **en el
Escritorio de Mi cuenta**, debajo del texto de bienvenida. No crea ninguna pestaña nueva.

```php
<?php
/**
 * Ficha de progreso DRC dentro del Escritorio de "Mi cuenta".
 *
 * Requiere en wp-config.php:
 *   define('DRC_PROGRESO_SECRET', '...');
 *   define('DRC_PROGRESO_URL', 'https://academy-scheduler-aqpt.vercel.app');
 */
add_action( 'woocommerce_account_dashboard', 'drc_progreso_ficha', 20 );

function drc_progreso_ficha() {

	// Sin usuario logueado no se imprime nada.
	if ( ! is_user_logged_in() ) {
		return;
	}

	// Sin configuración tampoco: mejor no mostrar recuadro que mostrarlo roto.
	if ( ! defined( 'DRC_PROGRESO_SECRET' ) || ! defined( 'DRC_PROGRESO_URL' ) ) {
		return;
	}

	$user = wp_get_current_user();

	// El email se normaliza IGUAL que en el software: minúsculas y sin espacios.
	// Si esto no coincide exactamente, la firma no cuadra y el alumno ve
	// "este enlace ha caducado".
	$email = strtolower( trim( $user->user_email ) );
	if ( empty( $email ) ) {
		return;
	}

	$ts  = time();
	$sig = hash_hmac( 'sha256', $email . '|' . $ts, DRC_PROGRESO_SECRET );

	$base   = rtrim( DRC_PROGRESO_URL, '/' );
	$src    = $base . '/progreso-cuenta'
		. '?email=' . rawurlencode( $email )
		. '&ts='    . rawurlencode( $ts )
		. '&sig='   . rawurlencode( $sig );
	$origen = $base; // De aquí, y solo de aquí, aceptamos mensajes de altura.
	?>
	<section class="drc-progreso" style="margin-top:32px;">
		<iframe
			id="drc-progreso-iframe"
			src="<?php echo esc_url( $src ); ?>"
			title="Tu progreso en inglés"
			loading="lazy"
			style="width:100%;border:0;display:block;height:900px;overflow:hidden;"
			scrolling="no"
		></iframe>
	</section>
	<script>
	( function () {
		var iframe = document.getElementById( 'drc-progreso-iframe' );
		if ( ! iframe ) { return; }

		var origenPermitido = <?php echo wp_json_encode( $origen ); ?>;

		window.addEventListener( 'message', function ( event ) {
			// Solo mensajes del software de gestión. Sin esta comprobación,
			// cualquier otra web abierta podría cambiar el alto del recuadro.
			if ( event.origin !== origenPermitido ) { return; }

			var data = event.data;
			if ( ! data || data.type !== 'drc-progreso-height' ) { return; }

			var alto = parseInt( data.height, 10 );
			if ( ! alto || alto < 200 || alto > 20000 ) { return; }

			iframe.style.height = alto + 'px';
		}, false );
	} )();
	</script>
	<?php
}
```

### Qué hace, en orden

1. Si el visitante no está logueado, no imprime nada.
2. Coge el email del usuario, lo pasa a minúsculas y le quita espacios.
3. Calcula la hora (`ts`) y la firma (`sig`).
4. Imprime el `iframe` con los tres parámetros escapados.
5. Escucha los mensajes de altura que manda la ficha y ajusta el alto del recuadro, así
   no queda con doble barra de desplazamiento.

---

## 4. Cómo probar que la firma coincide

Antes de tocar nada en producción, comprobá que tu PHP calcula la misma firma que el
software. Con el **secreto de ejemplo** que trae `.env.example`:

```
secreto : ejemplo_no_usar_en_produccion_0123456789abcdef0123456789abcdef
email   : alumno@ejemplo.com
ts      : 1800000000
cadena  : alumno@ejemplo.com|1800000000
```

La firma tiene que salir **exactamente** esto:

```
62b8cafc8ef2b141e7f811ec687dc85f4815dbb7e103cf88e8abdd6f30b0e502
```

Comprobalo en PHP:

```php
<?php
$secreto = 'ejemplo_no_usar_en_produccion_0123456789abcdef0123456789abcdef';
$email   = 'alumno@ejemplo.com';
$ts      = 1800000000;

echo hash_hmac( 'sha256', $email . '|' . $ts, $secreto );
// 62b8cafc8ef2b141e7f811ec687dc85f4815dbb7e103cf88e8abdd6f30b0e502
```

Si te sale ese valor, tu PHP y el software hablan el mismo idioma. Si te sale otro, algo
de la cadena no coincide: revisá el separador (`|`, sin espacios), el orden
(email primero, hora después) y que el email vaya en minúsculas.

> Ese `ts` es de 2027, así que ese enlace concreto no abriría la ficha (está fuera de la
> ventana de 10 minutos). Sirve **solo** para comparar el valor de la firma.

---

## 5. Errores típicos

### El recuadro dice "Este enlace ha caducado"

Es el mensaje único para todos los rechazos, así que puede ser cualquiera de estas:

- **Los secretos no son el mismo.** El de `wp-config.php` y el de Vercel tienen que ser
  idénticos, carácter por carácter. Ojo con espacios al copiar y con comillas de más.
- **El email no está normalizado igual.** Tiene que ser `strtolower( trim( ... ) )`. Un
  email con una mayúscula da una firma distinta.
- **El reloj del servidor de WordPress está desfasado.** El enlace vale 10 minutos hacia
  atrás y admite 2 minutos de adelanto. Si el servidor va media hora atrasado, todos los
  enlaces nacen caducados. Comprobalo con `date` en el servidor.
- **La página de Mi cuenta está en caché.** Si un plugin de caché guarda el HTML, la hora
  de la firma se queda congelada y a los 10 minutos todo el mundo ve el mensaje. Las
  páginas de "Mi cuenta" tienen que estar **excluidas de la caché** (normalmente lo están
  por defecto en WooCommerce, pero conviene mirarlo).
- **Falta `SUPABASE_SERVICE_ROLE_KEY` en Vercel.** Ver el punto 2.

### El recuadro sale en blanco

Casi siempre es la cabecera que autoriza el iframe. El software solo permite incrustar la
ficha desde `https://drcacademy.com` y `https://www.drcacademy.com`. Si la web se sirve
desde otro dominio o subdominio (un `staging.`, por ejemplo), el navegador bloquea el
recuadro y en la consola aparece un aviso de `frame-ancestors`. Hay que añadir ese dominio
en el software (`next.config.ts`).

### El recuadro dice "Todavía no tenemos tu ficha de progreso"

La firma está bien, pero no hay ningún alumno con ese email en el software. Suele ser:

- el alumno compró con un email y en la academia está dado de alta con otro;
- todavía no ha empezado las clases y no tiene ficha.

El software busca en los **dos** emails que guarda de cada alumno (el suyo y el de su
matrícula), así que cubre el caso habitual de que pague el padre o la madre. Si aun así no
aparece, hay que corregir el email en el software.

### El recuadro se queda muy alto o con doble scroll

El alto lo ajusta el `<script>` del snippet al recibir el mensaje de la ficha. Si no
funciona:

- comprobá que `DRC_PROGRESO_URL` **no** lleva barra al final ni `http://` en vez de
  `https://`: el origen tiene que coincidir exactamente con el del `iframe`;
- comprobá en la consola del navegador que llegan mensajes `drc-progreso-height`.


---

## 6. El botón «Amplía tu plan» lleva al cambio de plan de WooCommerce

Dentro de la ficha hay un botón **«Amplía tu plan →»**. Tiene que llevar al alumno a la
**misma URL** que el botón nativo «Aumentar o Disminuir Plan» de la pestaña *Suscripción*
(`/producto/…/?switch-subscription={id}&item={item}&_wcsnonce={nonce}`), y en la **ventana
principal**, no dentro del recuadro.

Esa URL lleva un *nonce* que **solo WordPress puede generar** para el usuario logueado, así
que el software de gestión no la construye. Lo que hace el botón, dentro del iframe, es
pedírsela al padre por `postMessage` (`{ type: 'drc:ampliar-plan' }`), y este snippet es el
que la calcula y navega. Fuera del iframe (la ficha abierta a pelo, o `/progreso/{token}`)
el botón es un enlace normal a la lista de suscripciones.

**Red de seguridad:** el snippet contesta `drc:ampliar-plan-ok` justo antes de navegar. Si
la ficha no recibe esa respuesta en 1,2 s (snippet sin instalar, o desactivado), lleva la
ventana principal a `/mi-cuenta/subscriptions/` por su cuenta: el botón nunca queda muerto.

### El snippet

Plugin **Code Snippets** → *Add New* → pegar esto → *Run snippet everywhere* → *Save and
Activate*. Es **independiente** del snippet de la ficha (sección 3): no toca su `<iframe>` ni
su listener de altura; añade un segundo listener de `message` en el pie de la página.

```php
<?php
/**
 * «Amplía tu plan» (dentro de la ficha de progreso) → cambio de plan de WooCommerce
 * Subscriptions, en la ventana principal.
 *
 * Reutiliza DRC_PROGRESO_URL de wp-config.php (sección 2) como origen permitido.
 */
add_action( 'wp_footer', 'drc_ampliar_plan_listener', 20 );

function drc_ampliar_plan_listener() {

	// Solo en Mi cuenta y con usuario logueado. En el resto de la web no se imprime nada.
	if ( ! is_user_logged_in() || ! function_exists( 'is_account_page' ) || ! is_account_page() ) {
		return;
	}

	// Destino de reserva: la lista de suscripciones. Vale aunque falte el plugin.
	$destino = function_exists( 'wc_get_account_endpoint_url' )
		? wc_get_account_endpoint_url( 'subscriptions' )
		: home_url( '/mi-cuenta/subscriptions/' );

	// La primera suscripción activa (o en espera, si no hay activa) con un item que el
	// usuario pueda cambiar: la misma comprobación y la misma URL que usa el botón
	// «Aumentar o Disminuir Plan» de la pestaña Suscripción.
	if ( class_exists( 'WC_Subscriptions_Switcher' ) && function_exists( 'wcs_get_users_subscriptions' ) ) {
		$suscripciones = wcs_get_users_subscriptions( get_current_user_id() );

		foreach ( array( 'active', 'on-hold' ) as $estado ) {
			foreach ( $suscripciones as $suscripcion ) {
				if ( ! $suscripcion->has_status( $estado ) ) {
					continue;
				}
				foreach ( $suscripcion->get_items() as $item_id => $item ) {
					if ( WC_Subscriptions_Switcher::can_item_be_switched_by_user( $item, $suscripcion ) ) {
						$destino = WC_Subscriptions_Switcher::get_switch_url( $item_id, $item, $suscripcion );
						break 3;
					}
				}
			}
		}
	}

	// De aquí, y solo de aquí, aceptamos el mensaje. Mismo origen que el iframe.
	$origen = defined( 'DRC_PROGRESO_URL' )
		? rtrim( DRC_PROGRESO_URL, '/' )
		: 'https://academy-scheduler-aqpt.vercel.app';
	?>
	<script>
	( function () {
		var SWITCH_URL = <?php echo wp_json_encode( $destino ); ?>;
		var origenPermitido = <?php echo wp_json_encode( $origen ); ?>;

		window.addEventListener( 'message', function ( event ) {
			// Solo mensajes de la ficha de progreso. Sin esta comprobación, cualquier
			// otra web abierta podría mandar al usuario a donde quisiera.
			if ( event.origin !== origenPermitido ) { return; }

			var data = event.data;
			if ( ! data || data.type !== 'drc:ampliar-plan' ) { return; }

			// Avisar a la ficha de que nos hacemos cargo (así no usa su reserva) y
			// llevar la VENTANA PRINCIPAL al cambio de plan. Es una navegación
			// directa, no un clic en a.wcs-switch-link: el modal de advertencia
			// (#drc-switch-confirmar) que intercepta ese enlace no se dispara.
			if ( event.source && typeof event.source.postMessage === 'function' ) {
				try { event.source.postMessage( { type: 'drc:ampliar-plan-ok' }, event.origin ); } catch ( e ) {}
			}
			window.location.href = SWITCH_URL;
		}, false );
	} )();
	</script>
	<?php
}
```

### Qué hace, en orden

1. Fuera de Mi cuenta, o sin usuario logueado, no imprime nada.
2. Calcula el destino de reserva (`/mi-cuenta/subscriptions/`).
3. Recorre las suscripciones del usuario —primero las activas, luego las en espera— y se
   queda con el primer item que `can_item_be_switched_by_user` deje cambiar; su URL sale
   de `get_switch_url`, que es exactamente la del botón «Aumentar o Disminuir Plan».
4. Imprime un `<script>` que escucha `message`, comprueba el origen, y ante
   `drc:ampliar-plan` contesta `drc:ampliar-plan-ok` y navega a esa URL.

### Cómo probarlo

Con un alumno de prueba logueado en drcacademy.com:

1. Abrí `/mi-cuenta/view-subscription/{id}/` y copiá el `href` del botón «Aumentar o
   Disminuir Plan» (`a.wcs-switch-link`). Apuntá `switch-subscription` e `item`.
2. Volvé a `/mi-cuenta/`, abrí la consola del navegador y pulsá «Amplía tu plan →» dentro
   de la ficha.
3. La **ventana principal** (no el recuadro) tiene que cargar `/producto/…/?switch-subscription=…&item=…&_wcsnonce=…`
   con el **mismo** `switch-subscription` y el mismo `item` del paso 1. El nonce puede
   cambiar de un día a otro: es normal.
4. El modal `#drc-switch-confirmar` **no** debe aparecer: no se ha hecho clic en
   `a.wcs-switch-link`.
5. Si en vez de eso acabás en `/mi-cuenta/subscriptions/`: o el snippet no está activo
   (la ficha usó su reserva al no recibir respuesta), o el alumno no tiene ninguna
   suscripción activa/en espera con un item cambiable (el snippet usó la suya). Para
   distinguirlo, en la consola de `/mi-cuenta/` ejecutá
   `window.postMessage({type:'drc:ampliar-plan'}, location.origin)`: no debe pasar nada
   (el origen no es el de la ficha), y `document.documentElement.innerHTML.includes('drc:ampliar-plan')`
   tiene que dar `true` si el snippet está impreso.
