# Zaldo

Asistente de saldo en WhatsApp. Le escribes o le mandas una nota de voz, confirma con un botón y cobra con CoDi por la API de Pey. El dinero cae en la cuenta ligada a la API key. Zaldo solo apunta y avisa cuando el webhook dice que ya se pagó.

Repo del equipo: https://github.com/LuisandovalU/Zaldo

## Qué hace

- Nota de voz o texto.
- Tarjeta con Confirmar y Cancelar antes de crear el cobro.
- Push CoDi al celular. Si pides QR, manda la imagen. Si pides link, manda la página de pago.
- «Ya cayó» cuando Pey avisa.
- Contactos, repetir un cobro, apuntes que no mueven dinero y «¿cómo va mi zaldo?».
- Tope diario. Otro celular, si hay lista, no crea cobros.

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

Mientras Banxico activa la cuenta (unos 5 días), la key de prueba apunta a la CLABE de pruebas. Cobra $0.01.

## Demo

Desde el número de prueba de WhatsApp:

1. Nota de voz: «Zaldo, cóbrame un centavo de prueba.»
2. Confirmar.
3. Pagar el push en la app del banco.
4. Zaldo contesta: «Ya cayó, $0.01 de ti · Prueba.»
