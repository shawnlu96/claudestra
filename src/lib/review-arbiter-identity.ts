/** Canonical finding-family identity, independent of both review readers and arbitration writers. */
export const normalizedFamily = (family: string): string => family.normalize("NFKC").toLowerCase().replace(/[-_.]/g, "");
