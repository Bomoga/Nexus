// @types/react-dom is not a dependency yet, and the kit only declares "*.css?raw".
declare module "react-dom/client" {
  import type { ReactNode } from "react";
  export function createRoot(container: Element | DocumentFragment): { render(children: ReactNode): void; unmount(): void };
}
declare module "*.css";
