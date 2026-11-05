## Revisión humana (R12, R3)

Abre cada fuente antes de aprobar. Rechazar un cambio dudoso es un buen resultado: cada mes hay una propuesta trampa con un error sembrado, y CI la bloquea aunque la apruebes.

### Si el PR toca `data/`

- [ ] Cada cambio tiene una fuente https que abrí, y la fuente dice exactamente eso.
- [ ] Por **cada fecha de Nivel 1** pegué abajo el fragmento que leí yo en la fuente, no la cita que trae la IA.
- [ ] Las fechas de Nivel 1 tienen una fuente A (organizador o gobierno) o dos fuentes B independientes. (R1, R2)
- [ ] La ciudad es la correcta y está en el país de la fiesta, no es una homónima de otro país.
- [ ] La edición es la correcta: la fuente habla de este año, no de la edición anterior.
- [ ] Nada parece sembrado: fecha fuera de la ventana de la regla, salto raro de asistentes, dominio desconocido, una «confirmada» que pasa a «tentativa» sin fuente, una fiesta borrada. Si dudo, rechazo ese cambio.
- [ ] Idioma de las fuentes que leí: ______. No apruebo cambios marcados «revisar idioma» en un idioma que no leo. (R3)
- [ ] El PR tiene 15 cambios o menos; si tiene más, pido dividirlo.
- [ ] Un país pasa de `borrador` a `publicado` solo con 3 fiestas o más con fecha y fuente A o B, y regeneré `data/index.json` con `node scripts/build-data.ts`.

| Fiesta | Fecha propuesta | Fragmento literal que leí en la fuente | URL | Idioma |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Pega los fragmentos editando esta descripción o en un comentario de revisión.

### Si el PR toca código (`src/`, `scripts/`, `.github/`, `locales/`)

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` y `pnpm e2e` pasan en local.
- [ ] Ningún texto visible fuera de `locales/`; datos externos solo con `textContent` o `h()`.
- [ ] Fechas con los helpers de `src/dates.ts`, nunca `new Date("YYYY-MM-DD")`.
- [ ] Ningún secreto en archivos; acciones nuevas fijadas por SHA con la versión en un comentario.
- [ ] Cada pantalla nueva tiene su prueba e2e con axe.
