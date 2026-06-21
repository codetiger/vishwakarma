/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute base URL for the height-tile pyramid (manifest + tiles). Set this
   *  to a CDN/object-store URL for the world-scale build; unset falls back to the
   *  app-relative `public/pyramid/`. A trailing slash is added if missing. */
  readonly VITE_TILE_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
