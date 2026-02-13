import { randomUUID } from "node:crypto";

const REQUEST_ID_HEADER = "X-Request-Id";
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuidV4(value: string): boolean {
  return UUID_V4_REGEX.test(value);
}

export function requestIdMiddleware(req: any, res: any, next: () => void): void {
  const incomingRequestId = req.header(REQUEST_ID_HEADER);
  const requestId =
    incomingRequestId && isValidUuidV4(incomingRequestId) ? incomingRequestId : randomUUID();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
