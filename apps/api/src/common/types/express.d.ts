import { AuthUserContext } from "../../auth/auth.types";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      user?: AuthUserContext;
      rawBody?: Buffer;
    }
  }
}

export {};
