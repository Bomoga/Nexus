import { z } from "zod";

export const IsoTime = z.string().datetime({ offset: true });          // ISO 8601 with offset or Z
export const Sha = z.string().regex(/^[0-9a-f]{40}$/, "full 40-char lowercase SHA");
export const Id = z.string().min(1);
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);     // ids are ULIDs (time-sortable)
export type IsoTime = z.infer<typeof IsoTime>;
export type Sha = z.infer<typeof Sha>;
