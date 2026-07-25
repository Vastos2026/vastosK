This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Floor-plan parsing pipeline

Uploaded plans flow through discrete, observable stages (`src/lib/pipeline/`):

```
Upload (JPG/PNG) → AWS S3 → Inngest → OCR → Gemini Flash → OpenCV → Merge Engine → FloorPlan
```

| Stage        | Module                                          | What it does                                                          |
| ------------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| AWS S3       | `pipeline/storage.ts`                           | Stores the upload; local-temp fallback when AWS env vars are unset    |
| Inngest      | `inngest/` + `app/api/inngest`                  | Runs the job as retryable, observable steps (opt-in)                  |
| OCR          | `pipeline/ocr.ts`                               | Gemini Vision transcribes labels (room names, dimensions, scale)      |
| Gemini Flash | `pipeline/semantic.ts`                          | Reasons over OCR text into structured rooms / types / scale          |
| OpenCV       | `pipeline/opencv.ts` + `scripts/parse_plan.py`  | Detects walls, doors, windows, room boxes (pixels)                    |
| Merge Engine | `pipeline/merge.ts`                             | Resolves scale, converts px→feet, labels each room                   |

### Running it

By default the pipeline runs **synchronously** — just `npm run dev`, no extra
services. It degrades gracefully: missing AWS creds → local storage; missing
`GEMINI_API_KEY` → OpenCV geometry with generic room names.

Relevant `.env.local` keys:

- `GEMINI_API_KEY` — enables the OCR + Gemini Flash stages
- `GEMINI_MODEL` — defaults to `gemini-2.0-flash`
- `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `S3_BUCKET` — real S3
- `INNGEST_ENABLED=1` — run parsing as an async Inngest job
- `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SECRET_KEY` — persist each run to the
  `parse_jobs` table (best-effort & non-blocking; the app works fine without them).
  Run `supabase/schema.sql` first so the table/columns exist.

For the async (Inngest) path, run the dev server alongside Next:

```bash
npx inngest-cli dev   # terminal 1
npm run dev           # terminal 2
```

> **PDF note:** PDFs currently fall back to a sample layout — OpenCV needs a
> raster image. Export plans to PNG/JPG for the full pipeline.
