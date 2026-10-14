import type { GameId, ScanHints } from '../types';

/**
 * Optional "AI scan": send the photo to Claude and have it read the card. Much more robust
 * than on-device OCR on holo foil, glare, angled photos and non-English cards. Needs an
 * Anthropic API key (Settings), which stays in this browser and is sent only to
 * api.anthropic.com.
 */
const MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  properties: {
    game: { type: 'string', enum: ['pokemon', 'yugioh', 'mtg', 'lorcana', 'other'], description: 'mtg = Magic: The Gathering, lorcana = Disney Lorcana.' },
    name: { type: 'string', description: 'Card name exactly as printed, in English if the card is English.' },
    collector_number: {
      type: 'string',
      description:
        'Pokémon: the number before the slash, e.g. "025", "TG05", or a promo number like "SWSH050". Magic: the collector number bottom-left, e.g. "0123" or "45". Lorcana: the number before the slash bottom-left, e.g. "12". Empty for Yu-Gi-Oh!.',
    },
    set_total: { type: 'string', description: 'Pokémon / Lorcana / older Magic: the number after the slash, e.g. "198". Empty if none.' },
    set_code: {
      type: 'string',
      description:
        'Pokémon: the 2-4 letter set code beside the number, e.g. "PAL". Yu-Gi-Oh!: the full code under the artwork, e.g. "LOB-EN005". Magic: the 3-5 character set code bottom-left, e.g. "M21". Lorcana: the set number after the language, e.g. "1" in "12/204 • EN • 1".',
    },
    set_name: {
      type: 'string',
      description:
        'The expansion this printing is from, if you can tell from the set symbol, set code or card design, e.g. "Brilliant Stars", "Crown Zenith", "151". Empty if unsure.',
    },
    passcode: { type: 'string', description: 'Yu-Gi-Oh!: the 8-digit number bottom-left. Empty for other games.' },
    variant: {
      type: 'string',
      enum: ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', '1st Edition Holofoil', 'Unlimited', 'Limited Edition', 'Foil', 'Etched Foil', ''],
      description:
        'The finish. Pokémon: "Holofoil" when only the artwork is shiny/rainbow foil (full arts and ex/V cards are foil all over), ' +
        '"Reverse Holofoil" when the card body and text box are foil but the artwork is not, "Normal" when nothing is foil; ' +
        'prefix "1st Edition" if the 1st Edition stamp is printed left of the artwork. Yu-Gi-Oh!: "1st Edition" or "Limited Edition" ' +
        'when printed under the artwork, else "Unlimited". Magic / Lorcana: "Foil" when the card is foil (Magic "Etched Foil" for etched), else "Normal". ' +
        'Use "" only if the photo does not show it.',
    },
    language: { type: 'string', description: 'Two-letter language code of the card text, e.g. "EN", "JP", "DE".' },
  },
  required: ['game', 'name', 'collector_number', 'set_total', 'set_code', 'set_name', 'passcode', 'variant', 'language'],
  additionalProperties: false,
} as const;

interface AiCard {
  game: GameId | 'other';
  name: string;
  collector_number: string;
  set_total: string;
  set_code: string;
  set_name: string;
  passcode: string;
  variant: string;
  language: string;
}

const PROMPT =
  'This photo shows one trading card. Read what is printed on it so it can be looked up in a card database. ' +
  'Copy numbers and codes character for character; leave a field empty rather than guessing.';

function toJpegBase64(canvas: HTMLCanvasElement): string {
  // ~1000 px tall is plenty for the small print and keeps the request small.
  const scale = Math.min(1, 1000 / canvas.height);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d')!.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88).split(',')[1]!;
}

export async function readCardWithClaude(canvas: HTMLCanvasElement, apiKey: string): Promise<ScanHints> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    // Card reading is a simple task: keep thinking light for speed and cost.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    // If a safety classifier ever declines, retry on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: toJpegBase64(canvas) } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to read this image.');
  const text = res.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Claude returned no reading.');
  const card = JSON.parse(text.text) as AiCard;
  if (card.game === 'other') throw new Error("That doesn't look like a Pokémon, Yu-Gi-Oh!, Magic or Lorcana card.");

  const blank = (s: string): string | undefined => s.trim() || undefined;
  const hints: ScanHints = {
    game: card.game,
    name: blank(card.name),
    nameText: blank(card.name),
    variant: blank(card.variant),
    variantConfidence: blank(card.variant) ? 0.8 : undefined,
    language: blank(card.language)?.toUpperCase(),
    setName: blank(card.set_name ?? ''),
    raw: { claude: text.text },
  };
  if (card.game === 'pokemon' || card.game === 'lorcana') {
    hints.number = blank(card.collector_number);
    hints.total = blank(card.set_total);
    hints.setCode = blank(card.set_code);
  } else if (card.game === 'mtg') {
    hints.number = blank(card.collector_number)?.replace(/^0+(?=\d)/, '');
    hints.total = blank(card.set_total);
    hints.setCode = blank(card.set_code)?.toUpperCase();
  } else {
    hints.setCode = blank(card.set_code)?.toUpperCase();
    hints.passcode = /^\d{8}$/.test(card.passcode) ? card.passcode : undefined;
  }
  return hints;
}
