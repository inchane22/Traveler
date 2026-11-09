// «Cerca de mí» (RF-14): the location's lifecycle in one place. Pure, like router.ts: the app shell
// makes the browser call and feeds its answers back as events; screens only read the state.
//
//   off ── request ──▶ asking ── located ──▶ on ── forget ──▶ off
//                        │
//                        └── failed ──▶ denied | unavailable ── request ──▶ asking
//
// A device without navigator.geolocation goes straight from a request to «unavailable».

export interface Coords {
  lat: number;
  lon: number;
}

export type GeoState = { status: "off" } | { status: "asking" } | { status: "on"; coords: Coords } | { status: "denied" } | { status: "unavailable" };

export type GeoStatus = GeoState["status"];

export type GeoEvent =
  /** A tap on «Usar mi ubicación» or «Cerca de mí». */
  | { type: "request"; supported: boolean }
  | { type: "located"; coords: Coords }
  | { type: "failed"; reason: "denied" | "unavailable" }
  /** «Olvidar mi ubicación». */
  | { type: "forget" };

/**
 * The state after `event`, or `state` itself when the event does not apply, so the caller can
 * skip the re-render and the announcement: one request at a time, none once the location is on,
 * and an answer that comes when nothing is being asked (after «Olvidar», or a second answer) is
 * dropped instead of turning the location back on.
 */
export function nextGeo(state: GeoState, event: GeoEvent): GeoState {
  switch (event.type) {
    case "request":
      if (state.status === "asking" || state.status === "on") return state;
      return event.supported ? { status: "asking" } : { status: "unavailable" };
    case "located":
      return state.status === "asking" ? { status: "on", coords: event.coords } : state;
    case "failed":
      return state.status === "asking" ? { status: event.reason } : state;
    case "forget":
      return state.status === "off" ? state : { status: "off" };
  }
}
