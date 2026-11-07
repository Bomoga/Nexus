// The "coderef" route of the nexus:// URI handler. The link text is untrusted: decodeCodeRef never throws and returns null
// for anything malformed, which is ignored.
import { decodeCodeRef } from "../../contracts";
import { openCodeRef, type ResolveDeps } from "./resolve";
import type { UriRouteHandler } from "./uri-handler";

export function coderefRoute(deps: ResolveDeps): UriRouteHandler {
  return async uri => {
    const ref = decodeCodeRef(uri);
    if (!ref) return false;
    await openCodeRef(deps, ref);
    return true;
  };
}
