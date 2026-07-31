import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";

const AUTH_USERS_PAGE_SIZE = 1000;
const MAX_AUTH_USER_PAGES = 20; // 20,000 users — a generous cap against a runaway loop, not a real expected ceiling

/**
 * `listUsers` is paginated (default/max page size varies by Supabase version)
 * — a single unpaginated call silently truncates any admin view built on top
 * of it. Fetches every page instead, stopping as soon as a page comes back
 * short (the last page). Shared by the console's Users page and Analytics
 * page — both need email addresses, which only live in `auth.users`, not
 * `profiles`.
 */
export async function listAllAuthUsers(admin: SupabaseClient): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; page <= MAX_AUTH_USER_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: AUTH_USERS_PAGE_SIZE });
    if (error) {
      console.warn("[console] listUsers failed (non-fatal):", error.message);
      break;
    }
    users.push(...data.users);
    if (data.users.length < AUTH_USERS_PAGE_SIZE) break;
    if (page === MAX_AUTH_USER_PAGES) {
      console.warn(`[console] hit the ${MAX_AUTH_USER_PAGES}-page safety cap — some users may be missing`);
    }
  }
  return users;
}
