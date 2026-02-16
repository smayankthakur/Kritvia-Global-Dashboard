import { BadRequestException, Injectable } from "@nestjs/common";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

interface OAuthStatePayload {
  orgId: string;
  appKey: string;
  provider: string;
  userId: string;
  nonce: string;
  iat: number;
}

export interface CreateOAuthStateInput {
  orgId: string;
  appKey: string;
  provider: string;
  userId: string;
}

@Injectable()
export class OAuthStateService {
  private static readonly MAX_AGE_SECONDS = 15 * 60;

  createState(input: CreateOAuthStateInput): string {
    const payload: OAuthStatePayload = {
      orgId: input.orgId,
      appKey: input.appKey,
      provider: input.provider,
      userId: input.userId,
      nonce: randomBytes(12).toString("hex"),
      iat: Math.floor(Date.now() / 1000)
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.sign(encodedPayload);
    return `${encodedPayload}.${signature}`;
  }

  verifyState(state: string): OAuthStatePayload {
    const [encodedPayload, signature] = state.split(".");
    if (!encodedPayload || !signature) {
      throw new BadRequestException("Invalid OAuth state");
    }

    const expectedSignature = this.sign(encodedPayload);
    if (!this.safeCompare(signature, expectedSignature)) {
      throw new BadRequestException("Invalid OAuth state signature");
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as OAuthStatePayload;
    if (!payload.orgId || !payload.appKey || !payload.provider || !payload.userId || !payload.iat) {
      throw new BadRequestException("Invalid OAuth state payload");
    }

    const now = Math.floor(Date.now() / 1000);
    if (now - payload.iat > OAuthStateService.MAX_AGE_SECONDS) {
      throw new BadRequestException("OAuth state expired");
    }
    return payload;
  }

  private sign(input: string): string {
    const secret = process.env.APP_OAUTH_STATE_SECRET ?? process.env.JWT_SECRET;
    if (!secret) {
      throw new BadRequestException("OAuth state secret is not configured");
    }
    return createHmac("sha256", secret).update(input).digest("base64url");
  }

  private safeCompare(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}
