import { GAME_LIST, isConfident } from '../games';
import { addCard } from '../db/store';
import { Camera, canvasFromFile } from '../scan/camera';
import { CARD_ASPECT } from '../scan/parse';
import { onOcrProgress, ocrWorker } from '../scan/ocr';
import { recognizeWithClaude, recognizeWithOcr, type Recognition } from '../scan/recognize';
import type { CollectionEntry, GameId } from '../types';
import { onSettings, settings, updateSettings } from '../util/settings';
import { addedToast, cardImg, openCandidatesSheet, openEntrySheet, pickVariant } from './cards';
import { clear, h, LANGUAGES } from './dom';
import { sheetOpen, toast } from './overlay';
import type { View } from './view';

export function scanView(nav: { search: (q: string, game: GameId) => void }): View {
  const video = h('video', { class: 'feed', autoplay: true, muted: true, playsinline: true });
  const guide = h('div', { class: 'guide', style: `aspect-ratio: ${CARD_ASPECT}` }, h('i', { class: 'c tl' }), h('i', { class: 'c tr' }), h('i', { class: 'c bl' }), h('i', { class: 'c br' }));
  const status = h('div', { class: 'scan-status' });
  const shot = h('div', { class: 'scan-shot' });
  const finder = h('div', { class: 'viewfinder' }, video, h('div', { class: 'guide-wrap' }, guide), status, shot);
  const camera = new Camera(video);
  const session = h('div', { class: 'session' });
  const sessionEntries: CollectionEntry[] = [];

  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const shutter = h('button', { type: 'button', class: 'shutter', 'aria-label': 'Scan card (Space)' }, h('span'));
  let torchOn = false;
  const torch = h('button', { type: 'button', class: 'round-btn', 'aria-label': 'Torch', title: 'Torch', hidden: true }, '🔦');

  const gameSwitch = h('div', { class: 'segmented', role: 'tablist' });
  const aiBadge = h('span', { class: 'ai-badge', title: 'Cards are read by Claude' }, 'AI scan');
  const renderTop = (): void => {
    const s = settings();
    aiBadge.hidden = !(s.useAi && s.anthropicApiKey);
    gameSwitch.hidden = !aiBadge.hidden;
    clear(
      gameSwitch,
      GAME_LIST.map((g) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(s.game === g.id), class: s.game === g.id ? 'on' : '', onclick: () => updateSettings({ game: g.id }) }, g.name),
      ),
    );
  };
  onSettings(renderTop);
  renderTop();

  let busy = false;
  const setStatus = (text: string, tone = ''): void => {
    status.textContent = text;
    status.className = `scan-status ${tone}`;
  };

  async function scan(card: HTMLCanvasElement): Promise<void> {
    if (busy) return;
    busy = true;
    finder.classList.add('busy');
    const preview = h('canvas', { width: card.width / 4, height: card.height / 4 });
    preview.getContext('2d')!.drawImage(card, 0, 0, preview.width, preview.height);
    clear(shot, preview);
    try {
      const s = settings();
      const rec: Recognition =
        s.useAi && s.anthropicApiKey ? await recognizeWithClaude(card, s.anthropicApiKey, setStatus) : await recognizeWithOcr(s.game, card, setStatus);
      await handle(rec);
    } catch (e) {
      console.error(e);
      setStatus(e instanceof Error ? e.message : 'Scan failed', 'warn');
      toast(`Scan failed: ${e instanceof Error ? e.message : String(e)}`, { tone: 'warn' });
    } finally {
      busy = false;
      finder.classList.remove('busy');
      setTimeout(() => clear(shot), 1200);
    }
  }

  async function handle(rec: Recognition): Promise<void> {
    console.debug('[scan]', rec.hints, rec.candidates.slice(0, 5));
    const top = rec.candidates[0];
    if (top && isConfident(rec.candidates) && settings().autoAdd) {
      const s = settings();
      const { entry, undo } = await addCard(top.card, {
        variant: pickVariant(top.card, rec.hints.variant),
        condition: s.defaultCondition,
        language: rec.hints.language && LANGUAGES.includes(rec.hints.language) ? rec.hints.language : s.defaultLanguage,
      });
      setStatus(`✓ ${top.card.name} · ${top.card.number}`, 'ok');
      navigator.vibrate?.(40);
      addedToast(entry, undo);
      remember(entry);
      return;
    }
    setStatus(rec.candidates.length ? `${rec.candidates.length} possible matches` : 'No match', rec.candidates.length ? '' : 'warn');
    openCandidatesSheet(rec, remember, (q) => nav.search(q, rec.game));
  }

  function remember(entry: CollectionEntry): void {
    sessionEntries.unshift(entry);
    clear(
      session,
      h('h3', null, `This session · ${sessionEntries.length}`),
      h(
        'div',
        { class: 'session-strip' },
        sessionEntries.slice(0, 30).map((e) => h('button', { type: 'button', class: 'mini', title: `${e.card.name} ${e.card.number}`, onclick: () => openEntrySheet(e) }, cardImg(e.card))),
      ),
    );
  }

  shutter.onclick = () => {
    if (!camera.running) return fileInput.click();
    void scan(camera.captureGuide(guide));
  };
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void scan(await canvasFromFile(f));
  };
  torch.onclick = async () => {
    torchOn = !torchOn;
    if (!(await camera.setTorch(torchOn))) torch.hidden = true;
    torch.classList.toggle('on', torchOn);
  };

  const onKey = (e: KeyboardEvent): void => {
    if ((e.code === 'Space' || e.key === 'Enter') && !sheetOpen() && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      shutter.click();
    }
  };

  const el = h(
    'section',
    { class: 'view scan-view' },
    h('div', { class: 'scan-top' }, gameSwitch, aiBadge),
    finder,
    h(
      'div',
      { class: 'scan-controls' },
      h('button', { type: 'button', class: 'round-btn', 'aria-label': 'Scan a photo', title: 'Scan a photo', onclick: () => fileInput.click() }, '🖼'),
      shutter,
      torch,
      fileInput,
    ),
    session,
  );

  return {
    el,
    async onShow() {
      document.addEventListener('keydown', onKey);
      if (!(settings().useAi && settings().anthropicApiKey)) {
        // Warm the OCR engine while the user lines up the first card.
        onOcrProgress((p, st) => {
          if (!busy && st.startsWith('loading')) setStatus(`Loading text reader… ${Math.round(p * 100)}%`);
        });
        void ocrWorker()
          .then(() => !busy && setStatus('Line the card up with the frame'))
          .catch(() => setStatus('Couldn’t load the text reader. Check your connection.', 'warn'));
      }
      if (!Camera.supported()) {
        finder.classList.add('no-camera');
        setStatus(window.isSecureContext ? 'No camera found. Tap the button to take or choose a photo.' : 'Camera needs HTTPS. Tap the button to take or choose a photo instead.');
        return;
      }
      try {
        await camera.start();
        finder.classList.remove('no-camera');
        torch.hidden = !(await camera.setTorch(false));
        if (!busy) setStatus('Line the card up with the frame');
      } catch (e) {
        console.warn(e);
        finder.classList.add('no-camera');
        setStatus('Camera unavailable. Tap the button to take or choose a photo.');
      }
    },
    onHide() {
      document.removeEventListener('keydown', onKey);
      camera.stop();
      torchOn = false;
    },
  };
}
