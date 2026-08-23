<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working in Vastos

An interior-design render tool: 2D floor plan in, AI-generated room photos
and a walkthrough video out. See `context.md` for the full onboarding
picture and `CLAUDE.md` for architecture detail — read those before making
non-trivial changes here.

## Hard rules

- **This Next.js version differs from your training data.** Read
  `node_modules/next/dist/docs/` for the relevant API before writing
  route/page code, especially around `proxy.ts` (not `middleware.ts`) and
  Server Actions.
- **`/api/dev-check` is the test suite.** No test runner is configured.
  Run it (`GET /api/dev-check` against a running dev server) after touching
  prompt text, greybox geometry, the furniture catalogue, or opening
  validation — it's what actually catches regressions in that code.
- **`react-hooks/set-state-in-effect` and `react-hooks/refs` are hard
  errors under `npm run lint`**, not warnings. Don't work around them by
  disabling the rule inline; fix the underlying effect/ref usage.
- **Prompt text is load-bearing, not copy.** Anything that ends up in a
  string sent to an image/video model (`src/lib/ai/prompting/*`,
  `prompt_templates` table content) was worded deliberately against a real
  failure mode — see `docs/PROMPTING-RULES.md`. Don't reword it casually;
  if you change it, understand why the current wording exists first.
- **The greybox camera is locked and deterministic** — the same room spec
  and aspect always pick the same viewpoint. Don't change candidate
  ordering or scoring in `src/lib/greybox/camera.ts` without checking what
  depends on tie-breaking by that order (see `CLAUDE.md`).
- **Room bounds clamp furniture drags continuously; they don't gate on
  pointerup.** If you touch `furniture-editor-canvas.tsx`, keep that split
  — it's what fixed a specific "glitchy drag" bug, not a stylistic choice.
- **Never run a mutating git command** (`stash`/`checkout`/`reset`/`commit`/
  `add`/`clean`/`restore`/`merge`/`rebase`) unless the user or task
  explicitly asks for it.

## Before you're done

Run `npm run lint` and, if you touched prompting/greybox/furniture code,
`/api/dev-check`. State what you checked, not just what you changed.
