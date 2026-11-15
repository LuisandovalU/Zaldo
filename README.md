# Zaldo

Punto de venta en WhatsApp. El dueño de un negocio le escribe o le manda una nota de voz: Zaldo arma el ticket con su catálogo, cobra con CoDi por la API de Pey, avisa cuando el banco confirma el pago y lleva el corte de caja. El dinero cae directo en la cuenta ligada a la API key; Zaldo nunca lo toca.

Repo del equipo: https://github.com/LuisandovalU/Zaldo

## Qué hace

- **Cobrar con solo el monto:** «cobra 150». No hace falta vender un producto ni dar un concepto.
- **Tres formas de cobrar con CoDi:** QR para quien está enfrente, notificación al celular del cliente («cóbrale 200 a Ana 5512345678») o link de pago con CoDi o tarjeta, con propina opcional.
- **Cobros recurrentes:** «cóbrale 500 de renta a Ana cada mes». Se confirma una vez; después Zaldo manda la notificación solo cada semana, quincena o mes, y avisa. A los tres cobros seguidos sin pagar se pausa solo.
- **QR fijo de mostrador:** no vence y recibe muchos pagos; cada uno cae como una venta aparte. También de monto abierto: quien paga escribe la cantidad.
- **Tarjeta con Confirmar y Cancelar** antes de crear cualquier cobro, con el desglose y a quién le llega. Un cobro corregido («mejor 200») reemplaza al anterior.
- **«Ya cayó»** cuando pey confirma el pago: por webhook y, si el webhook no llega, consultando a pey cada 30 segundos. «¿Ya pagó Ana?» le pregunta a pey en ese momento.
- **Pey en vivo:** «mis últimos pagos» (con comisión y propina, como los registró pey) y «¿mi cuenta ya está activa?».
- **Catálogo y ticket:** «agrega corte a 150», «cobra 2 cortes y un tinte». Los precios y el total salen del catálogo, no del modelo.
- **Corte de caja** de hoy, ayer, la semana o el mes: ventas CoDi, ticket promedio, lo más vendido, efectivo, propinas, gastos, lo que queda y la meta del día.
- **Fiado:** «Ana me quedó a deber 300». Cuando Ana paga por CoDi, su fiado se abona solo.
- **Memoria:** recuerda el nombre, el negocio, los clientes, los últimos cobros y lo que se le pida («recuerda que cierro a las 8»).
- Nota de voz o texto. «Ayuda» muestra todo lo que sabe hacer.

## Candados

El modelo conversa; la caja decide. Estas reglas viven en código, no en el prompt:

- Un cobro solo lleva un monto que la persona escribió, que sale del catálogo o que es un fiado apuntado. Un precio inventado se rechaza.
- Las cifras de cada respuesta salen del libro tal cual: el modelo no las vuelve a escribir.
- Si el modelo dice «apuntado» sin haber guardado nada, se le obliga a hacerlo o la persona recibe un «no lo pude apuntar».
- CONFIRMAR y CANCELAR los resuelve la caja, sin pasar por el modelo.
- Si el modelo rechaza un cobro por su cuenta («el mínimo es 1 peso»), se le obliga a consultar a la caja: no hay monto mínimo.
- Una persona, un mensaje a la vez; si el modelo se cae, la persona recibe respuesta igual; veinte mensajes por minuto por persona.
- Tope diario de cobros, y no más de 3 notificaciones sin pagar al mismo celular en 24 horas.
- El cobro va al celular del dueño solo si él lo pide («cóbrame»). Otro celular, si hay lista blanca, no crea cobros.

## Correrlo

```bash
npm install
copy .env.example .env
npm test
npm run dev
```

Las llaves van en `.env`. No se suben a git.

Pey y WhatsApp tienen que poder llegar al servidor por HTTPS:

- `https://TU_URL/webhooks/whatsapp`
- `https://TU_URL/webhooks/pey`

En Meta, el token de verificación es el mismo `WHATSAPP_VERIFY_TOKEN`. En el portal de Pey, el webhook es uno solo por API key: guarda el secreto en `PEY_WEBHOOK_SECRET`.

La API key tiene que tener una cuenta CoDi ligada y activa (portal de Pey: Finanzas para registrar la CLABE, Desarrolladores para ligarla a la llave). Sin eso, Pey responde `INVALID_STATE: API key does not have CoDi enabled` y Zaldo se lo explica a quien cobra. Mientras Banxico activa la cuenta propia (unos 5 días hábiles), la documentación de Pey da una CLABE de pruebas que se activa al momento. Cobra $0.01.

## Publicar sin push

En producción Zaldo vive dentro de otro servidor (zaldo.ih0st.app). Ni la landing ni el bot necesitan un deploy de ese servidor:

```bash
npm run zaldo:publish     # corre los tests, empaqueta src/core.ts y cambia el bot en caliente
npm run zaldo:status      # qué versión corre (también se ve en /health)
npm run zaldo:rollback    # vuelve a la versión anterior
npm run landing:publish   # sube landing/ (landing:watch la sube cada que guardas)
```

`zaldo:publish` arma un solo archivo con todo el bot y lo sube con `ZALDO_CORE_TOKEN`. El servidor comprueba su sha256, lo carga, y solo si arranca reemplaza al que corría: las peticiones a medias terminan con la versión vieja y el libro (catálogo, cobros, fiado) sigue igual. Guarda las últimas 5 versiones.

Ese token permite ejecutar código en el servidor. Va en `.env`, nunca en git, y solo lo tiene quien despliega.

## Demo

Desde WhatsApp:

1. «Agrega corte a 150 y tinte a 450.»
2. «Cobra un corte y un tinte.» Zaldo contesta la tarjeta con el desglose y el total, $600.00.
3. Confirmar. Llega el QR CoDi; el cliente lo escanea desde la app de su banco.
4. Zaldo contesta: «Ya cayó: $600.00 · 1 corte, 1 tinte. Confirmado por CoDi.»
5. «Corte.» Zaldo manda las ventas del día, el ticket promedio y lo más vendido.

Para probar sin cliente: «cóbrame a mí un centavo de prueba» manda la notificación al celular de quien escribe.

## Panel administrador

En `/admin`. Vive en dos carpetas independientes: `src/auth/` es el login y no
sabe nada de cobros; `src/admin/` es el panel y solo lee. Ninguno crea cobros
ni manda WhatsApp, así que entrar al panel nunca mueve dinero.

### Encenderlo

```bash
npm run admin:hash -- tu-usuario
```

Pide la contraseña sin mostrarla y escupe las dos líneas que faltan en `.env`:

```
ADMIN_USERS=tu-usuario:scrypt$16384$8$1$...
ADMIN_SESSION_SECRET=...
```

Sin esas dos variables el panel queda apagado y Zaldo corre igual: `/admin`
responde 404. Varios admins van separados por comas.

### Qué muestra

| Pestaña | Qué hay |
|---|---|
| Resumen | Cobrado hoy contra el tope diario, pendiente, pagado, conversión, barras de 14 días |
| Cobros | Todos los cobros, con filtros por estado, método, dueño y texto, y descarga a CSV |
| Usuarios | Un renglón por celular que usa Zaldo, con sus cobros, contactos y apuntes |
| Conciliación | Lo que Pey dice que cobró, frente al libro de Zaldo |
| Ajustes | La configuración en vigor, sin las llaves |

### Conciliación

Lee `GET /transaction/api-key` de Pey, que devuelve las transacciones reales de
la API key, 80 por página. De ahí sale lo que el libro local no guarda: la
comisión que Pey descuenta (`amountBreakdown.fee`) y el neto que de verdad
llega a la cuenta. Las cruza por `metadata.chargeId`, que Zaldo ya manda al
crear cada CoDi y cada link, y señala cuatro descuadres:

- **Pagado en Pey, no en Zaldo** — se perdió el webhook. Tiene botón «Marcar
  pagado», que vuelve a preguntarle a Pey por esa transacción y solo corrige el
  libro si Pey la confirma `PAID` y pertenece a ese cobro.
- **Pagado en Zaldo, no en Pey** — revisar a mano.
- **Monto distinto** — Pey cobró algo diferente de lo que Zaldo esperaba.
- **Sin cobro local** — entró dinero por fuera de Zaldo con la misma API key.

Se consulta a Pey una vez por minuto como máximo; «Actualizar» fuerza la
lectura. Si Pey no responde, el panel lo dice y sigue mostrando lo local.

### Privacidad

Los celulares salen enmascarados (`52•••••111`) y las URL usan un
identificador opaco derivado del secreto de sesión, para que el número no
quede en el historial del navegador ni en los logs del proxy. Las llaves de
Pey, WhatsApp y OpenRouter no se muestran en ninguna pantalla.

### Seguridad

Contraseñas con scrypt y comparación en tiempo constante; un usuario que no
existe cuesta lo mismo que uno real, para no delatarlo por el tiempo de
respuesta. Sesión en cookie firmada con HMAC, `HttpOnly`, `Secure`,
`SameSite=Strict`. Token CSRF en los dos POST (entrar y reparar). Cinco
intentos fallidos por IP y por usuario frenan quince minutos. El panel solo
acepta `GET`, salvo el POST de reparar.

### Desplegarlo en un PaaS (ih0st, Railway y similares)

El puerto ya se toma de `PORT`, que es lo que inyecta la plataforma.

- `ADMIN_COOKIE_SECURE=true` — la plataforma sirve HTTPS.
- `ADMIN_TRUST_PROXY=true` — para contar la IP real detrás del proxy. Déjalo en
  `false` si nada hace de proxy, porque entonces cualquiera podría saltarse el
  límite mandando un `X-Forwarded-For` inventado.
- `PUBLIC_BASE_URL=https://tu-dominio` — hace falta para el link de pago.
- **`DATA_PATH` tiene que apuntar a un volumen persistente**, por ejemplo
  `/data/zaldo.json`. El disco de un contenedor se borra en cada redeploy: sin
  volumen se pierde el libro completo de cobros. La conciliación ayuda a
  recuperar el dinero desde Pey, pero no los contactos ni los apuntes.
