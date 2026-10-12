import { eq } from "drizzle-orm";
import NextAuth, { type NextAuthConfig } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { z } from "zod";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { env } from "@/server/env";

/** Find-or-create the user row for an authenticated identity. */
export async function upsertUser(input: {
  name: string;
  email: string;
  image?: string | null;
  googleId?: string;
  googleAccessToken?: string | null;
  googleRefreshToken?: string | null;
  googleTokenExpiresAt?: Date | null;
  /** Space-separated scopes granted by Google; undefined leaves the stored value untouched. */
  googleScopes?: string | null;
}): Promise<{
  id: string;
  name: string;
  email: string;
  image?: string | null;
  timezone: string;
}> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (existing.length > 0) {
    const u = existing[0];
    const updates: Partial<{
      googleId: string;
      image: string | null;
      name: string;
      googleAccessToken: string | null;
      googleRefreshToken: string | null;
      googleTokenExpiresAt: Date | null;
      googleScopes: string | null;
    }> = {};
    if (input.googleId && u.googleId !== input.googleId) {
      updates.googleId = input.googleId;
    }
    if (input.image !== undefined && u.image !== input.image) {
      updates.image = input.image;
    }
    if (input.name && u.name !== input.name) {
      updates.name = input.name;
    }
    if (input.googleAccessToken !== undefined) {
      updates.googleAccessToken = input.googleAccessToken;
    }
    if (input.googleRefreshToken) {
      updates.googleRefreshToken = input.googleRefreshToken;
    }
    if (input.googleTokenExpiresAt !== undefined) {
      updates.googleTokenExpiresAt = input.googleTokenExpiresAt;
    }
    if (input.googleScopes !== undefined) {
      updates.googleScopes = input.googleScopes;
    }
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, u.id));
    }
    return {
      id: u.id,
      name: updates.name ?? u.name,
      email: u.email,
      image: updates.image !== undefined ? updates.image : u.image,
      timezone: u.timezone,
    };
  }
  const created = await db
    .insert(users)
    .values({
      name: input.name,
      email: input.email,
      image: input.image ?? null,
      googleId: input.googleId,
      googleAccessToken: input.googleAccessToken ?? null,
      googleRefreshToken: input.googleRefreshToken ?? null,
      googleTokenExpiresAt: input.googleTokenExpiresAt ?? null,
      googleScopes: input.googleScopes ?? null,
      timezone: env.DEFAULT_TIMEZONE,
    })
    .returning();
  return {
    id: created[0].id,
    name: created[0].name,
    email: created[0].email,
    image: created[0].image,
    timezone: created[0].timezone,
  };
}

const providers: NextAuthConfig["providers"] = [];

if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
          scope:
            "openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
        },
      },
    }),
  );
}

if (env.ALLOW_DEV_LOGIN) {
  providers.push(
    Credentials({
      id: "dev-login",
      credentials: { email: {}, name: {} },
      authorize: async (creds) => {
        const parsed = z
          .object({ email: z.email(), name: z.string().min(1).optional() })
          .safeParse(creds);
        if (!parsed.success) return null;
        const { email, name } = parsed.data;
        const u = await upsertUser({
          name: name ?? email.split("@")[0] ?? email,
          email,
        });
        return { id: u.id, name: name ?? email.split("@")[0] ?? email, email };
      },
    }),
  );
}

/**
 * Refresh expired Google access token using the stored refresh token.
 */
async function refreshGoogleAccessToken(token: JWT): Promise<JWT> {
  try {
    let refreshToken = token.refreshToken;

    // Fall back to database if refresh token is not on the JWT
    if (!refreshToken && token.userId) {
      const userRows = await db
        .select({ googleRefreshToken: users.googleRefreshToken })
        .from(users)
        .where(eq(users.id, token.userId))
        .limit(1);
      refreshToken = userRows[0]?.googleRefreshToken ?? undefined;
    }

    if (!refreshToken || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return token;
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const refreshedTokens = await response.json();

    if (!response.ok) {
      console.error(
        "Failed to refresh Google token in NextAuth JWT:",
        refreshedTokens,
      );
      if (token.userId) {
        await db
          .update(users)
          .set({
            googleAccessToken: null,
            googleRefreshToken: null,
            googleTokenExpiresAt: null,
          })
          .where(eq(users.id, token.userId as string))
          .catch(() => {});
      }
      return {
        ...token,
        accessToken: undefined,
        error: "RefreshAccessTokenError",
      };
    }

    const newAccessToken = refreshedTokens.access_token as string;
    const expiresIn = (refreshedTokens.expires_in as number) ?? 3600;
    const newExpiresAt = Math.floor(Date.now() / 1000 + expiresIn);
    const newRefreshToken =
      (refreshedTokens.refresh_token as string) ?? refreshToken;

    if (token.userId && newAccessToken) {
      await db
        .update(users)
        .set({
          googleAccessToken: newAccessToken,
          googleTokenExpiresAt: new Date(newExpiresAt * 1000),
          googleRefreshToken: newRefreshToken,
        })
        .where(eq(users.id, token.userId));
    }

    return {
      ...token,
      accessToken: newAccessToken,
      expiresAt: newExpiresAt,
      refreshToken: newRefreshToken,
      error: undefined,
    };
  } catch (error) {
    console.error("Error in refreshGoogleAccessToken:", error);
    return { ...token, error: "RefreshAccessTokenError" };
  }
}

const nextAuth = NextAuth({
  session: { strategy: "jwt" },
  trustHost: true,
  secret: env.AUTH_SECRET,
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers,
  callbacks: {
    async jwt({ token, user, account }) {
      if (account?.provider === "google") {
        token.accessToken = account.access_token;
        if (account.refresh_token) {
          token.refreshToken = account.refresh_token;
        }
        token.expiresAt = account.expires_at;
      }
      if (user) {
        const email = user.email ?? (token.email as string | undefined);
        if (email) {
          const isGoogle = account?.provider === "google";
          const googleId = isGoogle
            ? (account.providerAccountId as string | undefined)
            : undefined;
          const u = await upsertUser({
            name: user.name ?? email.split("@")[0] ?? email,
            email,
            image: user.image ?? undefined,
            googleId,
            googleAccessToken: isGoogle ? (account.access_token ?? null) : undefined,
            googleRefreshToken: isGoogle
              ? (account.refresh_token ?? undefined)
              : undefined,
            googleTokenExpiresAt:
              isGoogle && account.expires_at
                ? new Date(account.expires_at * 1000)
                : undefined,
            googleScopes: isGoogle ? (account.scope ?? null) : undefined,
          });
          token.userId = u.id;
          token.timezone = u.timezone;
          token.name = u.name;
          token.picture = u.image ?? undefined;
        }
        return token;
      }

      // If Google access token is expired or expiring within 60 seconds, refresh it
      if (
        token.expiresAt &&
        typeof token.expiresAt === "number" &&
        Date.now() >= token.expiresAt * 1000 - 60_000
      ) {
        return refreshGoogleAccessToken(token);
      }

      return token;
    },
    async session({ session, token }) {
      session.user.id = (token.userId as string | undefined) ?? "";
      session.user.timezone =
        (token.timezone as string | undefined) ?? env.DEFAULT_TIMEZONE;
      if (token.name) {
        session.user.name = token.name as string;
      }
      if (token.picture) {
        session.user.image = token.picture as string;
      }
      session.accessToken = token.accessToken as string | undefined;
      session.hasGoogleAuth = !!token.accessToken;
      session.error = token.error as string | undefined;

      // Fallback: if name or picture is not yet in token, read from DB
      if ((!session.user.image || !session.user.name) && token.userId) {
        try {
          const userRow = await db
            .select({ name: users.name, image: users.image })
            .from(users)
            .where(eq(users.id, token.userId as string))
            .limit(1);
          if (userRow[0]) {
            if (userRow[0].name && !session.user.name) {
              session.user.name = userRow[0].name;
            }
            if (userRow[0].image && !session.user.image) {
              session.user.image = userRow[0].image;
            }
          }
        } catch {
          // ignore DB error in session callback
        }
      }

      return session;
    },
    async redirect({ url, baseUrl }) {
      if (!url.startsWith("http") && !url.startsWith("/")) {
        return `${baseUrl}/${url}`;
      }
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      try {
        if (new URL(url).origin === baseUrl) return url;
      } catch {
        return baseUrl;
      }
      return baseUrl;
    },
  },
});

export const { handlers, signIn, signOut } = nextAuth;

let defaultUserCache: {
  id: string;
  name: string;
  email: string;
  timezone: string;
  image?: string | null;
} | null = null;

async function getBypassSession(): Promise<import("next-auth").Session | null> {
  if (defaultUserCache) {
    return {
      user: {
        id: defaultUserCache.id,
        name: defaultUserCache.name,
        email: defaultUserCache.email,
        timezone: defaultUserCache.timezone,
        image: defaultUserCache.image ?? null,
      },
      hasGoogleAuth: false,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  const defaultEmail = process.env.DEFAULT_USER_EMAIL || "user@example.com";
  let [u] = await db.select().from(users).where(eq(users.email, defaultEmail)).limit(1);
  if (!u) {
    const allUsers = await db.select().from(users).limit(1);
    u = allUsers[0];
  }
  if (!u) {
    [u] = await db
      .insert(users)
      .values({
        name: process.env.DEFAULT_USER_NAME || "Default User",
        email: defaultEmail,
        timezone: env.DEFAULT_TIMEZONE,
      })
      .returning();
  }

  defaultUserCache = {
    id: u.id,
    name: u.name,
    email: u.email,
    timezone: u.timezone || env.DEFAULT_TIMEZONE,
    image: u.image,
  };

  return {
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      timezone: u.timezone || env.DEFAULT_TIMEZONE,
      image: u.image ?? null,
    },
    hasGoogleAuth: false,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** True when DISABLE_AUTH makes auth() return a synthetic session. Single definition. */
export function isAuthBypassActive(): boolean {
  return (
    process.env.DISABLE_AUTH === "true" ||
    process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
    env.DISABLE_AUTH === true
  );
}

export const auth = (async (
  ...args: Parameters<typeof nextAuth.auth>
): Promise<import("next-auth").Session | null> => {
  if (isAuthBypassActive()) {
    const session = await getBypassSession();
    if (session) return session;
  }
  return (
    nextAuth.auth as (
      ...args: unknown[]
    ) => Promise<import("next-auth").Session | null>
  )(...args);
}) as typeof nextAuth.auth;
