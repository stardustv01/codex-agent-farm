/** A browser-session authority shared by production OAuth and local mode. */
export interface BrowserSessionAuthority<AuthenticatedSession, MutationSession = AuthenticatedSession> {
  authenticateCookie(cookieHeader?: string): AuthenticatedSession | null | Promise<AuthenticatedSession | null>;
  requireCsrf(
    cookieHeader: string | undefined,
    suppliedToken: unknown,
  ): MutationSession | Promise<MutationSession>;
}
