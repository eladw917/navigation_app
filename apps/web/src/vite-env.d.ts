/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Street walk polylines via `/v1/walk-route`. Off unless `"true"`. */
  readonly VITE_WALK_ROUTE_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
