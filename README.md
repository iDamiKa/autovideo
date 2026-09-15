# autovideo-render

Servicio de render de videos religiosos automáticos: recibe un guion ya partido
en escenas (imagen + audio de voz + texto por escena) y una pista de música
opcional, arma un video vertical (1080x1920) con efecto Ken Burns y subtítulo
por escena, mezcla la música bajita de fondo, y sube el resultado a Supabase
Storage.

Existe porque el n8n de producción corre en una imagen Docker "hardened" sin
gestor de paquetes: no hay forma de instalar FFmpeg ahí. Este servicio vive
aparte, expone un solo endpoint por HTTP, y n8n le habla con un nodo HTTP
Request normal — igual que le habla a Facebook o a Supabase.

## Variables de entorno

- `RENDER_API_KEY` — clave compartida con n8n; toda llamada a `/render` sin el
  header `x-api-key` correcto se rechaza.
- `PORT` — opcional, por defecto 3000.

## Endpoint

`POST /render`

```json
{
  "escenas": [
    { "imagenUrl": "https://...", "audioUrl": "https://...", "texto": "..." }
  ],
  "musicaUrl": "https://...",
  "supabase": {
    "url": "https://xxx.supabase.co",
    "bucket": "videos",
    "path": "sabiduria/2026-09-15-salmo23.mp4",
    "serviceRoleKey": "..."
  }
}
```

Responde `{ "url": "..." }` con el video ya público en Supabase.
