/* The shape an uploaded card becomes, and the rules for changing it.
 *
 * Two features share this file: Destructure takes a file someone already has
 * and breaks it into parts; Enhance takes those parts (or a brief) and returns
 * a version that will actually print. Neither owns the shape, so it lives here
 * and both build against it.
 *
 * ── Why this is not a canvas ─────────────────────────────────────────────
 *
 * Master PRD Decision 1 says designs are composed from validated components
 * and refined through bounded operations — never by dragging elements around,
 * because a blank canvas hands the print risk back to someone who cannot
 * evaluate it. Letting a customer take apart a card they uploaded and restyle
 * its pieces sounds like it crosses that line. It does not, and the
 * distinction is worth being precise about because everything below depends
 * on it:
 *
 *   Allowed — change what a part IS: its colour (from a palette that has been
 *   contrast-checked at physical size), its family (from the OFL library), its
 *   size step, weight, case, alignment within its own slot, and whether it
 *   appears at all.
 *
 *   Not allowed — change where a part SITS. No arbitrary x/y. Geometry is the
 *   composer's output, never an input, and that is the property that makes
 *   "the output cannot be wrong" true.
 *
 * So a part edit is not a nudge; it re-selects a value and re-composes. Every
 * mutation returns to `compose()` and then to `preflight()`, which means an
 * edit that would put type under the floor, break contrast, or push ink over
 * TAC is refused at the moment it is made rather than discovered at the press.
 * A customer gets the control they asked for and still cannot produce a card
 * that fails.
 *
 * ── The shape ────────────────────────────────────────────────────────────
 *
 * `CardParts` is deliberately DesignSpec-adjacent rather than DesignSpec
 * itself: an ingested card carries confidence and provenance that a generated
 * one does not, and dropping that information would let a guess about someone
 * else's artwork be mistaken for a fact the engine derived.
 */

/** @typedef {'text'|'mark'|'rule'|'panel'|'qr'|'image'} PartKind */

/**
 * A single decomposed piece of an uploaded card.
 *
 * `slot` maps the part onto the engine's vocabulary (`name`, `role`,
 * `company`, `contact`, `mark`, `qr`) when we can tell; `null` when we cannot,
 * which is honest and is what the UI shows as "unassigned".
 *
 * `confidence` is 0–1 and is never cosmetic: anything below `CONFIDENT` is
 * shown to the customer as a guess they should confirm, because a wrong slot
 * assignment silently changes what the composer will do with the text.
 *
 * `source` records where the value came from — read from the file, inferred
 * from position, or defaulted — so no screen can present an inference as if
 * it were measured. Same discipline as the engine's decision trace.
 */
export const PART = () => ({
  id: '',
  kind: /** @type {PartKind} */ ('text'),
  slot: /** @type {string|null} */ (null),
  text: '',
  script: /** @type {'latin'|'bangla'|'mixed'} */ ('latin'),

  /* Observed styling. Sizes in points, colours as hex; the ingest layer
     converts whatever the source file used into these two units so nothing
     downstream has to care what it was originally. */
  style: {
    family: /** @type {string|null} */ (null),
    weight: /** @type {number|null} */ (null),
    sizePt: /** @type {number|null} */ (null),
    color: /** @type {string|null} */ (null),
    tracking: /** @type {number|null} */ (null),
    case: /** @type {'upper'|'lower'|'title'|'as-is'} */ ('as-is'),
    align: /** @type {'left'|'centre'|'right'} */ ('left')
  },

  /* Where it sat in the original, in millimetres from the trim's top-left.
     Read-only for ever: this is evidence about the uploaded file, not an
     instruction to the composer. Nothing downstream may write to it, and
     nothing may pass it to compose(). */
  observed: { x: 0, y: 0, w: 0, h: 0 },

  confidence: 1,
  source: /** @type {'read'|'inferred'|'default'} */ ('read')
});

/** Below this, a part is presented as a guess for the customer to confirm. */
export const CONFIDENT = 0.75;

/**
 * The whole decomposed card.
 *
 * `findings` uses the same `{ s, label, note }` shape the engine's preflight
 * emits, so the existing `checkRow` renderer draws them without translation
 * and the severity vocabulary stays one vocabulary.
 */
export const CARD_PARTS = () => ({
  schema: 'cardparts/1',
  origin: { filename: '', mime: '', bytes: 0, pages: 1 },

  /* Trim in millimetres as found, plus what we snapped it to. A card that
     arrives at 88.9 × 50.8 (3.5 × 2 inches) is not an error — it is an inch
     card — and saying so beats silently resizing it. */
  format: { wMm: 0, hMm: 0, orientation: 'landscape', matchedFormatId: null, exact: false },

  parts: /** @type {ReturnType<typeof PART>[]} */ ([]),

  /* Colours actually used, most-used first, already deduplicated by
     perceptual distance rather than by hex equality — a file exported from
     three tools will carry four near-identical blacks. */
  palette: /** @type {{hex:string, area:number, role:string|null}[]} */ ([]),
  fonts: /** @type {{family:string, weight:number|null, embedded:boolean, licensed:boolean|null}[]} */ ([]),

  findings: /** @type {{s:'pass'|'review'|'fail', label:string, note:string}[]} */ ([]),
  quality: { score: 0, band: /** @type {'poor'|'fair'|'good'} */ ('fair') }
});

/* ── The bounded edit vocabulary ──────────────────────────────────────────
   The closed set of things a customer may change about a part. It is closed
   for the same reason the typed-instruction grammar is closed (PRD Epic C):
   an operation that re-selects a library value can be validated, and an
   operation that writes arbitrary geometry cannot.

   `MOVE` is absent, and its absence is the feature. */
export const PART_OPS = {
  setColor:   'setColor',    // to a palette-valid, contrast-checked colour
  setFamily:  'setFamily',   // to an OFL family that covers the part's script
  stepSize:   'stepSize',    // ±1 step on the type scale, never below the floor
  setWeight:  'setWeight',   // to a weight the family actually ships
  setCase:    'setCase',     // upper / lower / title / as-is
  setAlign:   'setAlign',    // within the part's own slot
  assignSlot: 'assignSlot',  // correct a low-confidence slot guess
  toggle:     'toggle'       // include or drop, honouring required slots
};

/** Every op carries the part it targets and the value it selects. Anything
 *  outside this set is refused by name, the same way an unmapped typed
 *  instruction is — never silently ignored. */
export const isPartOp = (op) =>
  !!op && typeof op === 'object' && Object.hasOwn(PART_OPS, op.type) && typeof op.partId === 'string';

/** The refusal an out-of-bounds edit produces. Carries what the customer CAN
 *  do instead, because an edit surface that only says no teaches nothing. */
export const refuseEdit = (reason, alternatives = []) =>
  ({ ok: false, reason, alternatives });
