// Los paquetes de pi sólo existen dentro del proceso de pi y son peerDependencies
// opcionales: para el typecheck alcanza con declarar la superficie que usamos.
// El código propio, `decibri` y los módulos de este repo se chequean de verdad.

declare module "@earendil-works/pi-coding-agent" {
  export type NotifyLevel = "info" | "warning" | "error";

  export interface UiComponent {
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
  }

  export interface CustomTheme {
    fg(color: string, text: string): string;
  }

  export interface CustomKeybindings {
    matches(data: string, keybinding: string): boolean;
  }

  export interface CustomTui {
    requestRender?(): void;
  }

  export interface CommandContext {
    ui: {
      notify(message: string, level?: NotifyLevel): void;
      pasteToEditor(text: string): void | Promise<void>;
      /** Selector de lista nativo de pi: devuelve la opción elegida o null si se cancela. */
      select(title: string, options: string[]): Promise<string | null>;
      /** Entrada de texto de una línea. Devuelve null si se cancela. */
      input(title: string, placeholder?: string): Promise<string | null>;
      custom<T>(
        factory: (
          tui: CustomTui,
          theme: CustomTheme,
          keybindings: CustomKeybindings,
          done: (value: T) => void,
        ) => UiComponent | Promise<UiComponent>,
        options?: { overlay?: boolean },
      ): Promise<T>;
    };
    sessionManager: { getSessionId(): string };
    modelRegistry: {
      // Forma real medida: { auth: { apiKey, baseUrl? }, env?, source? }. Se declara laxa
      // a propósito: `auth.ts` normaliza, y así un cambio de forma del host no rompe el tipado.
      getProviderAuth(id: string): Promise<unknown>;
      getApiKeyForProvider?(id: string): Promise<string | undefined>;
    };
  }

  export interface ExtensionAPI {
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: CommandContext) => Promise<void> | void;
      },
    ): void;
    registerShortcut(
      shortcut: string,
      options: {
        description?: string;
        handler: (ctx: CommandContext) => Promise<void> | void;
      },
    ): void;
    on(event: "session_shutdown", handler: () => void | Promise<void>): void;
  }
}
