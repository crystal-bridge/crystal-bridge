/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The UI's word theme (see src/theme/words.ts): `crystal` (default) or `classic`. */
  readonly VITE_CB_THEME?: string;
}

/** Set at build time from CB_RELEASE (see vite.config.ts). */
declare const __CB_RELEASE__: string;
