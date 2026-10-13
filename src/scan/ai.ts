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
    game: { type: 'string', enum: ['pokemon', 'yugioh', 'other'] },
    name: { type: 'string', description: 'Card name exactly as printed, in English if the card is English.' },
    collector_number: {
      type: 'string',
      description: 'Pokémon: the number before the slash, e.g. "025", "TG05", or a promo number like "SWSH050". Empty for Yu-Gi-Oh!.',
    },
    set_total: { type: 'string', description: 'Pokémon: the number after the slash, e.g. "198". Empty if none.' },
    set_code: {
      type: 'string',
      description: 'Pokémon: the 2-4 letter set code beside the number, e.g. "PAL". Yu-Gi-Oh!: the full code under the artwork, e.g. "LOB-EN005".',
    },
    passcode: { type: 'string', description: 'Yu-Gi-Oh!: the 8-digit number bottom-left. Empty for Pokémon.' },
    variant: {
      type: 'string',
      description: 'Visible finish or edition: "1st Edition", "Limited Edition", "Holofoil", "Reverse Holofoil", or "" if it cannot be told.',
    },
    language: { type: 'string', description: 'Two-letter language code of the card text, e.g. "EN", "JP", "DE".' },
  },
  required: ['game', 'name', 'collector_number', 'set_total', 'set_code', 'passcode', 'variant', 'language'],
  additionalProperties: false,
} as const;

interface AiCard {
  game: GameId | 'other';
  name: string;
  collector_number: string;
  set_total: string;
  set_code: string;
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
  if (card.game === 'other') throw new Error("That doesn't look like a Pokémon or Yu-Gi-Oh! card.");

  const blank = (s: string): string | undefined => s.trim() || undefined;
  const hints: ScanHints = {
    game: card.game,
    name: blank(card.name),
    nameText: blank(card.name),
    variant: blank(card.variant),
    language: blank(card.language)?.toUpperCase(),
    raw: { claude: text.text },
  };
  if (card.game === 'pokemon') {
    hints.number = blank(card.collector_number);
    hints.total = blank(card.set_total);
    hints.setCode = blank(card.set_code);
  } else {
    hints.setCode = blank(card.set_code)?.toUpperCase();
    hints.passcode = /^\d{8}$/.test(card.passcode) ? card.passcode : undefined;
  }
  return hints;
}
