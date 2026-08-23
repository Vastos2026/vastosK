# Prompting rules for image-generation pipelines

This is a portable rulebook for building a prompt-construction layer in front of a text-to-image or image-editing model — the kind of code that turns structured application state (room dimensions, a style brief, a furniture list) into the exact string a model API receives. It was extracted from a production pipeline (Vastos, an interior-design render tool) that feeds two very different model families — FLUX.2 via Runware, and Gemini/Nano Banana — from one shared set of inputs. Every rule below is stated generically first; a "Vastos example" then shows the real code and the real bug that motivated it. If you are starting a new project against FLUX, Gemini, or a similar pair, treat this as a checklist, not folklore — each rule exists because its absence broke something in production.

The rules split into two groups: rules 1–2 are about the *target model's* hard constraints, and rules 3–13 are about how to build reliable prompt-construction code regardless of which model receives the output.

## Quick comparison: FLUX.2 vs Gemini/Nano Banana

| | FLUX.2 (via a text encoder like Mistral-Small-3.2-24B-Instruct) | Gemini / Nano Banana |
|---|---|---|
| Input shape it wants | Prose. It's an instruction-tuned LLM encoder trained on natural language; tag lists and JSON read as broken English. | Compact JSON. No prose requirement; structured input is an established effective pattern. |
| Hard limit | ~512 tokens ≈ 1,800 characters. The encoder **truncates silently** — no error, no warning, from either the model or the API layer in front of it. | No equivalent cliff. Has a reasoning pass before generation and follows long structured instructions well. |
| What that means for your code | You need a **hard character budget enforced by a throw**, not a suggestion. | You still want a **sanity ceiling** (catch a pathological input before it reaches the network), but it's not a truncation budget — nothing gets trimmed to fit it. |
| Negative instructions | No `negativePrompt` channel. Naming what you don't want tends to summon it. | Same — no reliable negative channel either. Positive phrasing rules apply to both. |
| Section ordering | Matters directly: truncation eats the tail, so put load-bearing content first. | Doesn't matter for truncation safety, but keep it anyway — key insertion order in `JSON.stringify` is your only free documentation of priority, and it keeps the two flows comparable. |

## 1. FLUX.2's hard limit: throw, don't silently overflow

**Rule.** If your target model has a token-limited encoder, measure your assembled prompt in characters (or tokens) against a hard, tested ceiling, and if it's still over after every planned trim, **throw and fail the job**. Never let an oversized prompt reach the API "successfully."

**Why.** FLUX.2's Runware-hosted text encoder is Mistral-Small-3.2-24B-Instruct, which truncates input at roughly 512 tokens (≈1,800 characters for this pipeline's prompt style). Runware's API accepts prompts up to 32,000 characters and returns 200 OK regardless — it does not tell you the encoder threw away everything past its own limit.

**What breaks without it.** In Vastos, an earlier version of the prompt-builder produced prompts around 3,500 characters, with the room-geometry clause (door/window counts, "every other wall is solid") starting near character 2,044 — past the truncation point. That clause never reached the model, for weeks. Every image-accuracy problem in that window was diagnosed as a *prompting* problem — wrong wording, wrong ordering within the visible text — when the actual failure was that the single most important paragraph in the prompt was being discarded before inference ever ran. The bug was invisible because nothing errored; the images just looked wrong in a way that resembled bad prompting.

**Vastos example** — `src/lib/ai/prompting/prompt-builder.ts:56-57`:
```ts
/** Section 1, R1. Hard ceiling. Throw and fail the job — never send over. */
const MAX_PROMPT_CHARS = 1800;
```
and the actual throw, `prompt-builder.ts:1092-1094`:
```ts
if (prompt.length > MAX_PROMPT_CHARS) {
  throw new Error(`Prompt is ${prompt.length} chars, over the ${MAX_PROMPT_CHARS} limit for room "${room.name}"`);
}
```
The file's header (`prompt-builder.ts:22-28`) narrates the incident directly: "The previous version of this file ran ~3,500 chars with the geometry clause starting near char 2,044, which means that clause NEVER REACHED THE MODEL."

## 2. A structured-JSON model is not a smaller prose model — build it a separate flow

**Rule.** Don't reuse your prose-model prompt text for a model that wants structured input, and don't reuse a JSON payload's assumptions on a prose model. Build two flows from the same underlying data, sharing every value-producing function but not the final assembly.

**Why.** The two model families differ at the encoder level, not just in style preference. FLUX.2's encoder is an instruction-tuned *language model* trained on natural prose — tag lists and JSON keys read to it as poorly-formed English, and the vendor's own guidance is plain prose. Gemini's image path runs an explicit reasoning pass before generation and has no equivalent truncation cliff, so it can absorb long, structured instructions and JSON-structured prompting is an established effective pattern for it specifically.

**What breaks without it.** Send FLUX a JSON blob and you get worse instruction-following than a well-formed sentence would give, because the encoder is parsing broken English, not schema. Send Gemini a heavily-trimmed 1,800-character prose fragment and you're wasting a model that could have taken ten times the context and reasoned over it.

**Vastos example** — `prompt-builder.ts:33-53` documents the split explicitly, and the code has two entry points: `buildRoomPrompt` dispatches on the active provider (`prompt-builder.ts:885-888`) to either the FLUX prose path or `buildGeminiPrompt` (`prompt-builder.ts:638-851`). Both read from the *same* helper functions — `openingCounts`, `mappedFurnitureItems`, `roomLabelFor`, `guidanceFor`, `serviceContentsFor` — so the two flows carry identical information in identical priority order and can't silently drift apart; only the final assembly (joined prose vs. `JSON.stringify`) differs. Gemini also gets its own ceiling instead of a truncation budget: `MAX_JSON_PROMPT_CHARS = 12_000` (`prompt-builder.ts:93`), sized as roughly 6–7× the FLUX cap specifically so it never trips under legitimate input, with the comment noting it exists only to "catch a genuinely pathological input... before it reaches a network call."

## 3. Section order is a safety mechanism, not a style choice

**Rule.** If your model truncates from the end, order your prompt sections by consequence, not by narrative flow: irreversible/load-bearing facts (geometry, hard constraints) first, cosmetic or "nice to have" detail last.

**Why.** A truncating encoder eats the tail of the input. If your ordering is arbitrary, the thing that gets cut when a prompt runs long is *whatever happened to be written last* — which has nothing to do with what's safe to lose.

**What breaks without it.** This is the direct structural fix for the incident in Rule 1: the geometry clause used to live in the middle of the prompt. Moving it to the front means that even in a genuine overflow, geometry survives and only cosmetic detail is lost.

**Vastos example** — `prompt-builder.ts:30-31`: "Section order is a safety mechanism, not style: truncation eats the tail, so geometry goes first and expendable detail goes last." The assembly order in `buildRoomPrompt` (`prompt-builder.ts:1063-1064`) is `[medium, contract, ledger, briefOut, furnOut, furnishFully, accentOut]` — medium/lens and the structural (opening) contract first, the free-text "additional requirements" accent line last, by construction the first thing dropped.

## 4. A named overflow ladder — trim whole units, in a fixed order, never mid-phrase

**Rule.** When a prompt is over budget, define an explicit, ordered list of what gets cut or shrunk, applied as discrete stages, each re-measuring before moving to the next. Never truncate a string blindly mid-sentence or mid-word. Mark a subset of sections as permanently exempt from the ladder.

**Why.** A prompt truncated mid-phrase ("...cream boucle so") reads as garbage to the model and wastes the very characters you were trying to save. An unordered "just cut until it fits" approach also risks cutting the wrong thing under pressure — exactly the geometry-clause failure from Rule 1, but self-inflicted by your own trimming code instead of the vendor's encoder.

**What breaks without it.** Without a fixed order, two prompts of similar length but different content could get trimmed differently depending on incidental string lengths, breaking reproducibility (see Rule 12) and making the failure mode of "went over budget" unpredictable.

**Vastos example** — `prompt-builder.ts:1056-1086`. The ladder is: drop the accent/additional-requirements line entirely → re-derive the furniture line from the catalogue at a much smaller budget (dropping lowest-`promptPriority` items whole, never truncating a material phrase — see `furniture-layout.ts:82-89`) → trim the room brief at the nearest word boundary. The contract (opening census + geometry lock) and the "ledger" line are explicitly **never** touched: "Section 4.4 overflow order: drop accent, then trim furniture by priority, then trim brief. NEVER the contract or the ledger." (`prompt-builder.ts:1056-1057`). The furniture-priority drop itself lives in `furniture-layout.ts:82-89` and `furniture-layout.ts:141-149`, both looping `while (render(list).length > budget && list.length > 1)` and removing one whole catalogue entry per iteration — never slicing a string.

## 5. Per-section character budgets — and the trap of a budget covering multiple joined fields

**Rule.** Give each prompt section its own budget. If a single budget has to cover several fields that get concatenated together, be explicit about which field is last in the join — because that's the one that silently loses everything when the earlier fields eat the whole budget.

**Why.** A `.slice(0, N)` applied to a joined string doesn't distribute N fairly across its parts. If field A is near its own natural length and field B is appended after it, B gets whatever's left over — which can be zero, with no error, no warning, and a "successful" prompt that's just missing content.

**What breaks without it.** A shrinking or disappearing field that no one asked to shrink, discovered only by noticing the output doesn't reflect it.

**Vastos example** — `prompt-builder.ts:58-75`, verbatim from the source:
```ts
const BUDGET = { brief: 300, furniture: 460, accent: 100 } as const;
```
The comment documents the exact bug: `BUDGET.brief` covers the room **label**, the **compactBrief**, and the per-room **guidance**, joined in that order (`prompt-builder.ts:1004`: `[cap(roomLabel)+".", spec.compactBrief, guidance].filter(Boolean).join(" ").slice(0, BUDGET.brief)`). At the old budget of 240 characters, "a 240-char compactBrief plus a 120-char compactGuidance silently lost the guidance entirely, every time, with no error." It was invisible because both fields came from an LLM whose output length varied naturally, masking the systematic loss. The fix (raising `brief` to 300, and — in the sibling table-driven design-spec generator — writing `compactBrief`/`compactGuidance` to fixed sub-budgets sized against that number) is a general pattern: when several fields share a downstream budget, either size the shared budget against the worst case of all of them combined, or give each field its own sub-budget at the source. The `furniture` budget carries the identical lesson in miniature: raised 200 → 460 because the older unmapped furniture line was a bare list, but the newer form spends characters on *which box* each material belongs to, and at 200 chars a three-piece room silently lost two pieces to the priority-drop in Rule 4.

## 6. Positive phrasing over negative — name what's there, not what isn't

**Rule.** State constraints as closed positive facts ("exactly one door and one window; every other surface is unbroken solid wall") rather than exclusions ("no extra doors", "no sofa in this room"). Apply this uniformly, everywhere a constraint is expressed.

**Why.** Neither FLUX.2 nor Gemini/Nano Banana has a reliable negative-prompt channel in this pipeline's usage. On a model without one, naming the unwanted object *puts it in the model's attention* — the classic "don't think of an elephant" failure. A closed positive statement gives the model something to satisfy instead of something to avoid.

**What breaks without it.** Both directions were observed. Under-specification: "the room has one door" is not a claim there's *exactly* one, so a model filling a large blank wall will happily add a second. Over-specification via negation: telling a "luxury living space" brief not to put a sofa in a bathroom is exactly the kind of instruction that increases the odds a sofa shows up.

**Vastos example** — `openingCensus` (`prompt-builder.ts:290-314`) is the canonical instance: "This room has exactly {N}, only where Image 1 shows {it/them}. Every other surface is unbroken solid wall." The doc comment is explicit about the reasoning: "Positive phrasing throughout... 'The room has one door' is not a claim that there is exactly one door... Writing 'no extra doors' would name the unwanted object, which on a model with no negativePrompt channel makes it MORE likely to appear." The same rule drives `SERVICE_ROOM_CONTENTS` (`prompt-builder.ts:336-354`), which states what a bathroom or storage room *does* contain ("sanitary fixtures, a vanity and tiled surfaces only") rather than telling the model not to add furniture — added specifically because an unqualified luxury brief was free-associating a sofa into rooms with no stated contents at all. It also shows up in `furnishFullyFor`'s clearance clause (`prompt-builder.ts:576-581`): "Place none of it in front of a door or window" / "Leave the doors and windows unblocked" — a positive requirement about the openings, not a negative about furniture placement.

## 7. Clamp, don't ask — every stated limit must also be enforced in code

**Rule.** If your prompt to an upstream LLM (a planning/reasoning call that produces text destined for a downstream image prompt) says "AT MOST N characters," don't trust that instruction. Enforce N with a real clamp on the returned value.

**Why.** An instruction inside a prompt is a request; the model can and will exceed it, especially under a schema that has no hard length validator (a JSON Schema `STRING` type has no `maxLength` enforcement path in most structured-output APIs). If a downstream consumer has its own hard budget (Rule 1), an unclamped upstream field is a live way to blow that budget.

**What breaks without it.** A downstream throw (Rule 1) firing because an upstream field the code assumed was short turned out not to be — a failure mode that looks like a prompt-builder bug but is actually a trust bug one layer up.

**Vastos example** — `design-planning.ts` asks the planner for `compactBrief: AT MOST 240 characters` (`design-planning.ts:143-145`, note: budget was later widened alongside the `BUDGET.brief` change in Rule 5) and then clamps it anyway, regardless of what the model returned (`design-planning.ts:183-198`):
```ts
compactBrief: clamp(stripWallFinishes(spec.compactBrief), 240),
wallColour: clamp(stripWallFinishes(spec.wallColour), 40),
accentColours: clamp(stripWallFinishes(spec.accentColours), 60),
roomGuidelines: spec.roomGuidelines.map((g) => ({
  ...g,
  compactGuidance: clamp(stripWallFinishes(g.compactGuidance), 120),
  dressing: clamp(stripWallFinishes(g.dressing), 70),
})),
```
The comment states the principle directly: "The prompt asks for these limits; a hard clamp is what guarantees them." `clamp` itself (`design-planning.ts:232-239`) is worth copying — it trims to the last sentence or word boundary, never mid-word, tying back into Rule 4. The same discipline appears in `prompt-builder.ts:95-118`'s `LABEL_BUDGET`, added after an unbounded free-text style/subcategory label was found capable of eating the *entire* 1,800-character prompt on its own, silently starving every other section down to nothing while the prompt still came in "successfully" under the cap — arguably worse than throwing, because it looked like success.

## 8. Ban-list post-processing — for words the model keeps reintroducing despite instructions

**Rule.** When an instruction ("never describe a wall finish") is repeatedly ignored by the model, don't just repeat the instruction louder — strip the offending vocabulary out of the model's own output with a fixed, explicit regex/word list, applied after generation.

**Why.** An instruction competes with everything else in the model's training and context; a deterministic string filter doesn't. This is a stronger, cheaper backstop than prompt engineering once you've confirmed the instruction alone doesn't hold.

**What breaks without it.** A specific, reported visual bug (oily/waxy-looking walls) kept recurring because the planner LLM kept writing wall *treatments* ("lime-wash", "venetian plaster", "tadelakt") even when told the walls were "ordinary smooth painted plaster." The instruction not to do this was already in the prompt; it wasn't enough on its own.

**Vastos example** — `design-planning.ts:219-229`:
```ts
const WALL_FINISHES =
  /\b(lime[-\s]?wash(ed)?|lime[-\s]plaster|venetian[-\s]plaster|micro[-\s]?cement|tadelakt|stucco|chalky|chalk[-\s]finish|patina(ted)?|textured[-\s]plaster)\b/gi;

export function stripWallFinishes(s: string | undefined): string {
  return (s ?? "")
    .replace(WALL_FINISHES, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/([,;])\s*([,.;])/g, "$2")
    .trim();
}
```
Two details worth keeping: the list is a **fixed set of finish nouns**, not a generic "texture word" heuristic — the brief is still free to say "honed limestone" about a floor, only the specific wall-finish vocabulary is stripped — and the trailing regexes repair the punctuation/whitespace gap the removal leaves ("warm sand lime-wash walls" → "warm sand walls", not "warm sand  walls" or a dangling comma). This function is applied at *every* layer that can introduce the banned vocabulary, not just its origin: both the planner's own output (`design-planning.ts:183-198`) and a separate vision-model call that reads a user-uploaded photo (`design-reference.ts:47, 132-135` — "a reference photo of a limewashed wall would otherwise put 'limewash' into materials, from there into colour_palette, from there into the planner's compactBrief, and from there into the image prompt").

## 9. One source of spatial truth — position must be derived, never independently asserted

**Rule.** If a reference image (or any other channel) already carries authoritative spatial/geometric information, prose position claims must be *computed from that same source*, never written by hand or guessed independently. If your prose wants to anchor an object to a landmark ("under the window"), the proximity test that licenses that anchor must use the same coordinate space as the ground truth — physical/world units, not the object's apparent position in a 2D projection — and there must be a clean, silent fallback when nothing is actually near.

**Why.** Two independently-written descriptions of the same physical scene can disagree, and when they do, the model has to pick one — non-deterministically, from the render's point of view. A screen-space ("looks close in the image") proximity test is a false positive machine: perspective means two objects can appear adjacent on screen while sitting fifteen feet apart in the physical room (an object against the near wall can line up on screen with a window on the far wall).

**What breaks without it.** Telling the model "there is a sofa near the window" when the sofa and window are actually on opposite sides of the room produces a prompt that contradicts its own reference image — the model has to guess which one to trust, and you've reintroduced the exact class of error the reference image was supposed to eliminate.

**Vastos example** — `src/lib/greybox/furniture-descriptors.ts` builds short phrases that identify *which grey box* in a reference render a furniture item is, deriving every claim from the same locked camera that rendered the reference image, "so they cannot disagree with it" (file header, lines 17-24). Its opening-anchoring extension (`furniture-descriptors.ts:56-115, 176-215`) states the rule in almost these exact words:
```
Measured in WORLD FEET between footprint edges, never in screen space. That
choice is load-bearing: "under the window" is a claim about PHYSICAL
adjacency, and two things can sit next to each other on screen while being
fifteen feet apart in the room (a piece against the near wall lines up with
a window on the far one all the time). Anchoring off screen proximity would
therefore state a spatial fact the render contradicts...
```
The margin (`ANCHOR_MARGIN_FT = 2.5`, `furniture-descriptors.ts:81`) is measured from each piece's *edge*, not its centre, specifically because a centre-based radius is wrong in both directions: "a bed pushed flat against the window wall has its centre 3.4ft out and would have been rejected, while a nightstand marooned in open floor 3ft from a wall would have been accepted." And the fallback is explicit and deliberate, not an oversight: "No opening within reach: this piece keeps the frame-band phrasing untouched. The explicit, required fallback" (`furniture-descriptors.ts:210-212`) — most furniture in most rooms isn't next to an opening, and inventing an anchor for it would be worse than the mild ambiguity of "at centre."

## 10. A closed, exhaustive list reads as the room's complete contents — say so explicitly if it isn't

**Rule.** If you give the model a complete, itemized list of what to include (every piece of furniture, every fixture), the model will treat that list as exhaustive and render *only* those items — even if you didn't intend the list to be a ceiling. If more is allowed, say so in a separate, explicitly-scoped sentence, and make sure that permission can't be read as license to override a placement lock you've stated elsewhere.

**Why.** A list with no accompanying "there may be more" statement is, from the model's point of view, a complete specification. This is the same mechanism as Rule 6 in reverse: just as naming an unwanted object invites it, giving an exhaustive *wanted* list without qualification suppresses everything not on it.

**What breaks without it.** Reported: rooms coming back under-furnished — a bedroom with just a bed and a nightstand and nothing else, because the furniture section (correctly, per Rule 9) names *exactly* the in-frame proxies and nothing more. Naming a piece the camera can't see would tell the model to invent one; but saying nothing extra at all reads as "that's everything."

**Vastos example** — `furnishFullyFor` (`prompt-builder.ts:550-585`) is built entirely around this problem, and shows the scoping trap directly. Its own history: the first fix ("furnish this bedroom completely, as a real finished bedroom would be") solved the bareness but created a new problem — "furnish completely" asks for *architecture*, so the model was free to invent another wardrobe, and an invented wardrobe can land wherever it likes, including in front of the window the geometry contract just spent hundreds of characters pinning down. The fix scopes the permission to a specific, bounded category — small, loose "dressing" objects (rug, lamps, cushions, art, plants) that can't contradict the massing render — and phrases it as an addition, not a free-for-all: `"Beyond the pieces named above, add the finishing layer — {dressing} — so the {room} looks complete."` The clearance clause on the same line ("Place none of it in front of a door or window") exists specifically to stop even *that* bounded addition from drifting onto an opening — permission to add more must be scoped tightly enough that it can never override a lock stated elsewhere in the prompt.

## 11. Prompt-injection containment for any AI-derived text that reaches a later prompt

**Rule.** Whenever a model reads user-supplied content (an uploaded image, a pasted document) and its output later gets concatenated into a *different* prompt sent to another model call, treat that first output as untrusted, and apply all of: a closed response schema with no catch-all/freeform field, an explicit scope restriction in the extraction prompt itself, per-field length clamps, and the same ban-list stripping (Rule 8) you apply to your own first-party content.

**Why.** A field the model can write anything into is a channel an attacker (or just an unlucky photo) can use to smuggle instructions into a downstream prompt that also carries your safety-critical content (in this pipeline: the door/window count and geometry lock). "The model summarized what it saw" is not automatically safe if what it saw contained adversarial text, and even non-adversarial images can leak content (a wall finish) that reintroduces a previously-fixed bug (Rule 8) through a side channel.

**What breaks without it.** An open-ended `notes` field on a vision-extraction schema is a place for anything the model "noticed" to end up verbatim in an image-generation prompt — including, in principle, text the model read directly off the image, or content that contradicts the geometry lock.

**Vastos example** — `design-reference.ts` turns a user-uploaded interior photo into six design attributes via one vision call, and its header states the threat model outright: "This text is written by a model looking at a user-supplied image, and it is merged into a prompt that also carries the room's opening census and geometry lock — the two things this app most needs the image model to obey." Four concrete controls, all present in the code:
1. **Closed schema, no catch-all** (`design-reference.ts:70-81`): exactly six named string fields (`style`, `luxuryLevel`, `colourPalette`, `materials`, `lighting`, `furniture`), `luxuryLevel` further constrained to a three-value enum so constrained decoding can't emit a fourth value. No `notes`, no freeform field.
2. **Scope restriction inside the extraction prompt** (`design-reference.ts:114`): "never describe, mention or refer to: doors, windows, openings, walls, wall positions, ceiling height, room size or dimensions, layout, floor plan, where any object sits or faces, the camera, the viewpoint, the framing or the angle." The vision model is told to describe *look only*.
3. **Per-field clamps** (`design-reference.ts:96-102`), with `style` pinned to the *same* constant (`LABEL_BUDGET.style`) the downstream prompt-builder uses, "rather than a copied number" — one source of truth for that bound, not two that can drift.
4. **Ban-list stripping** applied to every field (`design-reference.ts:132-135`'s `sanitise`), plus quote and newline stripping specifically because a newline could forge a section boundary in a prompt whose sections are joined by `"\n\n"` and whose order is load-bearing (Rule 3), and a raw quote character would close an interpolated `"..."` string early in the no-greybox contract.

Also re-sanitised at every boundary it crosses, not just at the point of generation (`design-reference.ts:138-144`): the attributes are cached client-side and re-submitted later, so the server re-runs the identical sanitisation pass on what comes back, rather than trusting a value it already validated once.

## 12. Determinism — prompt text should be a pure function of its inputs

**Rule.** Given the same application state (room geometry, chosen furniture, design spec, additional notes), your prompt-builder should produce the *exact same string* every time — no hidden randomness, no dependency on wall-clock time or call order. If a value depends on a client-side computation (like a camera position), rebuild it deterministically server-side from the same inputs rather than trusting a value shipped over the wire.

**Why.** If regenerating an image can silently change the prompt for reasons unrelated to a deliberate user action, you've destroyed your own ability to do controlled experimentation — you can't tell whether a different output came from a different prompt or the same prompt behaving non-deterministically. It also closes a client-trust gap: reconstructing derived values server-side from primitive inputs means the server never has to trust a client's account of its own computation.

**What breaks without it.** "Generate more" for a room silently producing a differently-worded prompt with no user-visible cause, or a security gap where a client could ship a fabricated camera position that the server just accepts.

**Vastos example** — `mappedFurnitureItems` (`prompt-builder.ts:390-410`) rebuilds the room's camera from scratch on the server via `greyboxCamera(spec, aspect)`, rather than accepting camera data from the client, specifically because "greyboxCamera is a deterministic pure function of the spec and aspect (a dev-check fixture proves the same inputs always yield an identical camera), so reconstructing it server-side lands on exactly the viewpoint the client rendered from, without shipping camera internals through the request body and without trusting the client to describe its own layout." Every prompt build also logs a content hash for observability (`prompt-builder.ts:1097`, `fnv1a(prompt)`), which only means anything as a debugging signal if identical inputs are guaranteed to hash identically.

## 13. Grammar matters to a prose-trained encoder

**Rule.** When application data (a user-typed label, a config string) gets interpolated into prose destined for a prose-trained encoder, run it through the same grammatical normalization a human editor would: fix symbols that aren't words (`+`, `&`, `/`), and pick the correct indefinite article (`a`/`an`) instead of hardcoding one.

**Why.** FLUX.2's encoder is an instruction-tuned LLM trained on natural prose. A literal `+` or a mismatched article ("a Independent House") is exactly the kind of malformed-English input such an encoder handles worst — it's not a cosmetic nit, it measurably degrades how the surrounding instruction is parsed.

**What breaks without it.** A UI-facing room-type string like "Living + Dining" — a real, common combined room type in this pipeline's residential/apartment configs — lowercased and dropped directly into a sentence produced "a real, ordinary living + dining in a 3BHK Apartment" and "so the living + dining looks complete": a literal arithmetic operator sitting mid-sentence, in the *one* prompt section (the never-trimmed `medium`/contract line) that costs a constant, unavoidable number of characters on every single generation. Separately, a free-text subcategory field made "in a Independent House" and "in a Office" both reachable whenever the location noun happened to start with a vowel sound.

**Vastos example** — `prosaicRoomType` (`prompt-builder.ts:452-477`) is a general normalizer, not a lookup table for one string, specifically "so a future combined type ('Kitchen & Utility') is right the day it is added rather than the day someone notices":
```ts
function prosaicRoomType(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const joined = lower.replace(/\s*[+&/]\s*/g, " and ").replace(/\s{2,}/g, " ").trim();
  return joined === lower ? joined : `${joined} area`;
}
```
It appends `" area"` only when a join actually happened, because "the living and dining looks complete" is missing a noun where "the living and dining area looks complete" is not. It's applied everywhere a room type is turned into prose rather than used as a UI label: `roomLabelFor` (`prompt-builder.ts:425-431`), the structural contract's room-type sentence (`prompt-builder.ts:161`), the Gemini flow's image-1 description (`prompt-builder.ts:675`), and the `medium` line (`prompt-builder.ts:954`). The article-agreement fix sits right beside the last of those (`prompt-builder.ts:950-956`):
```ts
const article = /^[aeiou]/i.test(place) ? "an" : "a";
```
with the comment: "The article is picked, not hardcoded: subcategory is free text, so 'in a Independent House' and 'in a Office' are both reachable. FLUX.2's encoder is an instruction-tuned LLM trained on prose — broken English in the opening clause is exactly the input it handles worst."

## Checklist for a new prompt-construction pipeline

Run this against any new FLUX/Gemini (or similar prose-model/JSON-model pair) prompt-builder before shipping it:

- [ ] Does the prose-model path have a **measured, tested character/token ceiling**, and does exceeding it after all planned trims **throw** rather than send?
- [ ] Is that ceiling based on the *actual* encoder limit for the model in use, verified against a real overflow test — not a guess?
- [ ] Does the structured-JSON model path (if any) get its **own** sanity ceiling, clearly documented as *not* a truncation budget?
- [ ] Are the two flows (prose vs. JSON) built from **shared value-producing functions**, so they can't silently describe the same input differently?
- [ ] Is the prompt **assembled in priority order**, with the least-consequential content last?
- [ ] Is there a **named, ordered overflow ladder** that drops or shrinks whole semantic units — never truncates mid-phrase — and are the load-bearing sections explicitly exempt from it?
- [ ] Does every section have its **own character budget**? If any budget covers multiple joined fields, is the last field in that join protected from being silently zeroed out?
- [ ] Is every constraint phrased **positively** (what's true) rather than negatively (what's forbidden)?
- [ ] Does every length/format limit **stated inside a prompt to an upstream LLM** also get **enforced by a hard clamp** on that LLM's output?
- [ ] For vocabulary the model keeps reintroducing despite instructions, is there a **deterministic ban-list strip** applied after generation, everywhere that vocabulary could enter?
- [ ] When a reference image (or other channel) carries geometry, is all prose about position **derived from that same source** — and if anything anchors to a landmark, is the proximity test in the **same coordinate space as the ground truth** (not screen space), with a clean fallback when nothing qualifies?
- [ ] Does any **closed, exhaustive list** in the prompt (furniture, contents) come with an explicit, narrowly-scoped statement of what else is allowed — one that can't override a placement lock stated elsewhere?
- [ ] For any AI-derived text that flows from **user-uploaded content into a later prompt**: closed schema, no catch-all field, explicit scope restriction in the extraction prompt, per-field clamps, and the same ban-list stripping as first-party content?
- [ ] Is prompt text a **pure function of its inputs** — same state in, same string out, every time — with derived values (like a camera) rebuilt deterministically server-side rather than trusted from a client?
- [ ] Is user- or config-supplied text that reaches prose **grammar-normalized** (symbols like `+`/`&`, indefinite articles) before interpolation?
