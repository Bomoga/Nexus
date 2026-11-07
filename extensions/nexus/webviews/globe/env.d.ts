// @types/react-dom is not installed (dependencies are not ours to change); declare the one entry point we use.
declare module "react-dom/client" {
  import type { ReactNode } from "react";
  export function createRoot(container: Element | DocumentFragment): { render(children: ReactNode): void; unmount(): void };
}
declare module "*.css";
