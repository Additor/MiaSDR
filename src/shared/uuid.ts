const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID in its canonical text form, any case. An id that fails this cannot match a row, so a caller answers 404. */
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
