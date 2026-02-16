import { BadRequestException, Injectable } from "@nestjs/common";
import { OAuthProvider } from "./oauth-provider.interface";
import { GoogleOAuthProvider } from "./providers/google-oauth.provider";
import { SlackOAuthProvider } from "./providers/slack-oauth.provider";

@Injectable()
export class OAuthProviderFactory {
  private readonly providers: Record<string, OAuthProvider> = {
    slack: new SlackOAuthProvider(),
    google: new GoogleOAuthProvider()
  };

  getProvider(providerKey: string): OAuthProvider {
    const provider = this.providers[providerKey];
    if (!provider) {
      throw new BadRequestException("Unsupported OAuth provider");
    }
    return provider;
  }
}
