import * as oc from 'openid-client';
import type { Config } from '../config.js';

export interface OidcClaims { sub: string; email: string; emailVerified: boolean; name: string }
export interface OidcClient {
  authUrl(p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): Promise<string>;
  exchange(p: { currentUrl: URL; state: string; nonce: string; codeVerifier: string }): Promise<OidcClaims>;
}

const GOOGLE_ISSUER = new URL('https://accounts.google.com');

/** Real Google client (openid-client, authorization code + PKCE, id_token validated with state and nonce). */
export function googleOidcClient(cfg: Config): OidcClient {
  let conf: Promise<oc.Configuration> | undefined;
  const config = () => (conf ??= oc.discovery(GOOGLE_ISSUER, cfg.google.clientId, cfg.google.clientSecret));
  return {
    async authUrl(p) {
      const c = await config();
      return oc.buildAuthorizationUrl(c, {
        redirect_uri: p.redirectUri, scope: 'openid email profile', state: p.state, nonce: p.nonce,
        code_challenge: p.codeChallenge, code_challenge_method: 'S256', prompt: 'select_account',
      }).href;
    },
    async exchange(p) {
      const c = await config();
      const tokens = await oc.authorizationCodeGrant(c, p.currentUrl, {
        pkceCodeVerifier: p.codeVerifier, expectedState: p.state, expectedNonce: p.nonce, idTokenExpected: true,
      });
      const cl = tokens.claims();
      if (!cl) throw new Error('no id_token');
      return { sub: String(cl.sub), email: String(cl.email ?? ''), emailVerified: cl.email_verified === true, name: String(cl.name ?? '') };
    },
  };
}

export const newPkce = async () => {
  const verifier = oc.randomPKCECodeVerifier();
  return { verifier, challenge: await oc.calculatePKCECodeChallenge(verifier), state: oc.randomState(), nonce: oc.randomNonce() };
};
