/* KASAUTI — webview/assets.d.ts: esbuild inlines .svg files as text (see esbuild.mjs `loader`). */
declare module '*.svg' { const text: string; export default text; }
