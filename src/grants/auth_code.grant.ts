import { DateInterval } from "@jmondi/date-interval";

import { AbstractAuthorizedGrant } from "./abstract_authorized.grant";
import { base64decode } from "../utils";
import { AuthorizationRequest } from "../requests";
import { ICodeChallenge, PlainVerifier, S256Verifier } from "../code_verifiers";
import { OAuthException } from "../exceptions";
import { OAuthClient, OAuthScope } from "../entities";
import { GrantIdentifier } from "./grant.interface";
import { OAuthResponse, ResponseInterface } from "../responses/response";
import { RequestInterface } from "../requests/request";

export interface IAuthCodePayload {
  client_id: string;
  auth_code_id: string;
  expire_time: number;
  scopes: string[];
  user_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

export const REGEXP_CODE_CHALLENGE = /^[A-Za-z0-9-._~]{43,128}$/g;

export const REGEXP_CODE_VERIFIER  = /^[A-Za-z0-9-._~]{43,128}$/g;


export class AuthCodeGrant extends AbstractAuthorizedGrant {
  readonly identifier: GrantIdentifier = "authorization_code";

  protected readonly authCodeTTL: DateInterval = new DateInterval({
    minutes: 15,
  });

  private codeChallengeVerifiers = {
    plain: new PlainVerifier(),
    S256: new S256Verifier(),
  };

  async respondToAccessTokenRequest(
    request: RequestInterface,
    response: ResponseInterface,
    accessTokenTTL: DateInterval,
  ): Promise<ResponseInterface> {
    const [clientId] = this.getClientCredentials(request);

    const client = await this.clientRepository.getClientByIdentifier(clientId);

    if (client.isConfidential) await this.validateClient(request);

    const encryptedAuthCode = this.getRequestParameter("code", request);

    if (!encryptedAuthCode) {
      throw OAuthException.invalidRequest("code");
    }

    let validatedPayload: any;
    const scopes: OAuthScope[] = [];
    try {
      validatedPayload = await this.validateAuthorizationCode(this.decrypt(encryptedAuthCode), client, request);
    } catch (e) {
      throw OAuthException.invalidRequest("code", "cannot decrypt the authorization code");
    }

    try {
      const finalizedScopes = await this.scopeRepository.finalizeScopes(
        await this.validateScopes(validatedPayload.scopes ?? []),
        this.identifier,
        client,
        validatedPayload.user_id,
      );
      finalizedScopes.forEach((scope) => scopes.push(scope));
    } catch (e) {
      throw OAuthException.invalidRequest("code", "cannot verify scopes");
    }

    const authCode = await this.authCodeRepository.getAuthCodeByIdentifier(validatedPayload.auth_code_id);

    /**
     * If the authorization server requires public clients to use PKCE,
     * and the authorization request is missing the code challenge,
     * then the server should return the error response with
     * error=invalid_request and the error_description or error_uri
     * should explain the nature of the error.
     */
    if (authCode.codeChallenge !== validatedPayload.code_challenge) {
      throw OAuthException.invalidRequest("code_challenge", "Provided code challenge does not match auth code");
    }

    if (validatedPayload.code_challenge) {
      const codeVerifier = this.getRequestParameter("code_verifier", request);

      if (!codeVerifier) {
        throw OAuthException.invalidRequest("code_verifier");
      }

      // Validate code_verifier according to RFC-7636
      // @see: https://tools.ietf.org/html/rfc7636#section-4.1
      if (!REGEXP_CODE_VERIFIER.test(codeVerifier)) {
        throw OAuthException.invalidRequest(
          "code_verifier",
          "Code verifier must follow the specifications of RFS-7636",
        );
      }

      if (validatedPayload.code_challenge_method) {
        let verifier: ICodeChallenge;

        if (validatedPayload.code_challenge_method.toLowerCase() === "s256") {
          verifier = this.codeChallengeVerifiers.S256;
        } else if (validatedPayload.code_challenge_method.toLowerCase() === "plain") {
          verifier = this.codeChallengeVerifiers.plain;
        } else {
          throw OAuthException.invalidRequest(
            "code_challenge_method",
            "Code challenge method must be one of `plain` or `s256`",
          );
        }

        if (!verifier.verifyCodeChallenge(codeVerifier, validatedPayload.code_challenge)) {
          throw OAuthException.invalidGrant("Failed to verify code challenge.");
        }
      }
    }

    const accessToken = await this.issueAccessToken(accessTokenTTL, client, validatedPayload.user_id, scopes);

    const refreshToken = await this.issueRefreshToken(accessToken);

    await this.authCodeRepository.revokeAuthCode(validatedPayload.auth_code_id);

    response.body = {
      token_type: "Bearer",
      expires_in: Math.ceil((accessToken.expiresAt.getTime() - Date.now()) / 1000),
      access_token: accessToken.token, // @todo this needs to be a JWT
      refresh_token: refreshToken?.refreshToken,
    };

    response.set("Cache-Control", "no-store");
    response.set("Pragma", "no-cache");

    return response;
  }

  canRespondToAuthorizationRequest(request: RequestInterface): boolean {
    const response_type = this.getQueryStringParameter("response_type", request);
    const client_id = this.getQueryStringParameter("client_id", request);
    return response_type === "code" && !!client_id;
  }

  async validateAuthorizationRequest(request: RequestInterface): Promise<AuthorizationRequest> {
    const clientId = this.getQueryStringParameter("client_id", request);

    if (typeof clientId !== "string") {
      throw OAuthException.invalidRequest("client_id");
    }

    const client = await this.clientRepository.getClientByIdentifier(clientId);

    let redirectUri = this.getQueryStringParameter("redirect_uri", request);

    if (Array.isArray(redirectUri) && redirectUri.length === 1) redirectUri = redirectUri[0];

    // @todo this might only need to be run if the redirect uri is actually here aka redirect url might be allowed to be null
    this.validateRedirectUri(redirectUri, client);

    // @todo add test for scopes as string or string[]
    const bodyScopes = this.getQueryStringParameter("scope", request, []);

    const scopes = await this.validateScopes(bodyScopes);

    const stateParameter = this.getQueryStringParameter("state", request);

    const authorizationRequest = new AuthorizationRequest(this.identifier, client);

    authorizationRequest.state = stateParameter;

    authorizationRequest.scopes = scopes;

    if (redirectUri) authorizationRequest.redirectUri = redirectUri;

    const codeChallenge = this.getQueryStringParameter("code_challenge", request);

    if (!codeChallenge) {
      throw OAuthException.invalidRequest(
        "code_challenge",
        "The authorization server requires public clients to use PKCE RFC-7636",
      );
    }

    const codeChallengeMethod = this.getQueryStringParameter("code_challenge_method", request, "plain");

    if (!REGEXP_CODE_CHALLENGE.test(base64decode(codeChallenge))) {
      throw OAuthException.invalidRequest(
        "code_challenge",
        "Code challenge must follow the specifications of RFC-7636 and match ${codeChallengeRegExp.toString()}.",
      );
    }

    authorizationRequest.codeChallenge = codeChallenge;
    authorizationRequest.codeChallengeMethod = codeChallengeMethod;

    return authorizationRequest;
  }

  async completeAuthorizationRequest(authorizationRequest: AuthorizationRequest): Promise<ResponseInterface> {
    const redirectUri = authorizationRequest.redirectUri ?? this.getClientRedirectUri(authorizationRequest);

    if (authorizationRequest.isAuthorizationApproved) {
      const authCode = await this.issueAuthCode(
        this.authCodeTTL,
        authorizationRequest.client,
        authorizationRequest.user?.identifier, // @todo should this be allowed null?
        authorizationRequest.redirectUri,
        authorizationRequest.codeChallenge,
        authorizationRequest.codeChallengeMethod,
        authorizationRequest.scopes,
      );

      const payload: IAuthCodePayload = {
        client_id: authCode.client.id,
        redirect_uri: authCode.redirectUri,
        auth_code_id: authCode.token,
        scopes: authCode.scopes.map((scope) => scope.name),
        user_id: authCode.userId,
        expire_time: this.authCodeTTL.end().getTime() / 1000,
        code_challenge: authorizationRequest.codeChallenge,
        code_challenge_method: authorizationRequest.codeChallengeMethod,
      };

      const jsonPayload = JSON.stringify(payload);

      const code = await this.encrypt(jsonPayload);

      const finalRedirectUri = this.makeRedirectUrl(redirectUri, {
        code,
        state: authorizationRequest.state,
      });

      const response = new OAuthResponse();

      response.redirect(finalRedirectUri);

      return response;
    }

    // @todo what exception should I throw here?
    throw OAuthException.invalidGrant();
  }

  private async validateAuthorizationCode(payload: any, client: OAuthClient, request: RequestInterface) {
    if (!payload.auth_code_id) {
      throw OAuthException.invalidRequest("code", "Authorization code malformed");
    }

    if (Date.now() / 1000 > payload.expire_time) {
      throw OAuthException.invalidRequest("code", "Authorization code has expired");
    }

    if (await this.authCodeRepository.isAuthCodeRevoked(payload.auth_code_id)) {
      throw OAuthException.invalidRequest("code", "Authorization code has expired");
    }

    if (payload.client_id !== client.id) {
      throw OAuthException.invalidRequest("code", "Authorization code was not issued to this client");
    }

    const redirectUri = this.getRequestParameter("redirect_uri", request);
    if (!!payload.redirect_uri && !redirectUri) {
      throw OAuthException.invalidRequest("redirect_uri");
    }

    if (payload.redirect_uri !== redirectUri) {
      throw OAuthException.invalidRequest("redirect_uri", "Invalid redirect URI");
    }
    return payload;
  }

  private getClientRedirectUri(authorizationRequest: AuthorizationRequest): string {
    if (authorizationRequest.client.redirectUris.length === 0) throw OAuthException.invalidRequest("redirect_uri");
    return authorizationRequest.client.redirectUris[0];
  }
}
