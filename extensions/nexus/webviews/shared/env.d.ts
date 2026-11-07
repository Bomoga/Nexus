declare module "*.css?raw" {
  const css: string;
  export default css;
}

declare module "*.css";

declare module "react-dom/client" {
  import type { ReactNode } from "react";
  export function createRoot(container: Element | DocumentFragment): { render(children: ReactNode): void; unmount(): void };
}
