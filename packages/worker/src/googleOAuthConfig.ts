/** Shared by the publish and poll-status processors — both mint a fresh
 *  YouTube access token from the connection's refresh token. */
export function loadGoogleOAuthConfig(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET environment variables are not set');
  }
  return { clientId, clientSecret };
}
