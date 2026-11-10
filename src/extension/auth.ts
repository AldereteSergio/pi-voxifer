/**
 * auth.ts — la forma de la credencial que usa el dictado.
 *
 * `normalizarCredencial` y su tabla de casos se fueron con el camino de OpenCode Go, que
 * era el único proveedor que resolvía la key desde el `AuthResult` de pi. Hoy la key sale
 * de `config.json` o de una variable de entorno, así que alcanza con el tipo.
 */

export interface CredencialResuelta {
  apiKey: string;
  baseUrl: string;
}
