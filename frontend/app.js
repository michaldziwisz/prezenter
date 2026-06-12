const publishForm = document.querySelector('#publish-form');
const statusBox = document.querySelector('#status');
const details = document.querySelector('#publication-details');
const bundleInput = document.querySelector('#bundle');
const bundleHint = document.querySelector('#bundle-hint');
const modeInputs = [...document.querySelectorAll('input[name="presentationMode"]')];
const presentationStatus = document.querySelector('#presentation-status');
const presentationStage = document.querySelector('#presentation-stage');
const slideCounter = document.querySelector('#slide-counter');
const slideVisual = document.querySelector('#slide-visual');
const slideImage = document.querySelector('#slide-image');
const slideText = document.querySelector('#slide-text');

const roomIdInput = document.querySelector('#room-id');
const presenterKeyInput = document.querySelector('#presenter-key');
const syncStatus = document.querySelector('#sync-status');
const followPresenterInput = document.querySelector('#follow-presenter');
const stateH = document.querySelector('#state-h');
const stateTotal = document.querySelector('#state-total');
const prevSlideButton = document.querySelector('#prev-slide');
const nextSlideButton = document.querySelector('#next-slide');
const endRoomButton = document.querySelector('#end-room');

const API_URL = 'https://api.prezenter.eu.org';

let socket;
let presenter = false;
let currentRoom = null;
let currentPresentation = null;
let currentDeck = null;
let deckLoadToken = 0;
let followPresenter = true;
let presenterState = {
  indexh: 0,
  indexv: 0,
  fragment: -1,
  paused: false
};
let slideState = {
  indexh: 0,
  indexv: 0,
  fragment: -1,
  paused: false
};

const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('room');
const presenterKeyFromHash = new URLSearchParams(window.location.hash.slice(1)).get('presenterKey');
if (roomFromUrl) document.body.classList.add('room-open');
if (roomFromUrl) roomIdInput.value = roomFromUrl;
if (presenterKeyFromHash) presenterKeyInput.value = presenterKeyFromHash;

modeInputs.forEach((input) => {
  input.addEventListener('change', updateBundleMode);
});
bundleInput.addEventListener('change', validateBundleForMode);
updateBundleMode();
updatePresenterControls();
if (roomFromUrl) {
  loadInitialRoom();
}

publishForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearDetails();
  validateBundleForMode();

  if (!publishForm.reportValidity()) {
    setStatus('Uzupełnij wymagane pola.', true);
    return;
  }

  const formData = new FormData();
  const bundle = bundleInput.files[0];
  formData.set('presentationMode', getPresentationMode());
  formData.set('title', document.querySelector('#title').value);
  formData.set('language', document.querySelector('#language').value);
  formData.set('license', document.querySelector('#license').value);
  formData.set('rightsConfirmed', String(document.querySelector('#rights-confirmed').checked));
  formData.set('publicConfirmed', String(document.querySelector('#public-confirmed').checked));
  formData.set('accessibilityConfirmed', String(document.querySelector('#a11y-confirmed').checked));
  formData.set('bundle', bundle);

  setStatus('Wysyłanie publikacji...');
  setFormDisabled(true);

  try {
    const response = await fetch(`${API_URL}/api/publish`, {
      method: 'POST',
      body: formData
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Nie udało się opublikować.');

    setStatus(`Publikacja przyjęta. Status: ${payload.status}.`);
    renderPublication(payload);
    applyPublicationRoom(payload);
    pollStatus(payload.id);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setFormDisabled(false);
  }
});

document.querySelector('#create-room').addEventListener('click', async () => {
  setSyncStatus('Tworzenie pokoju...');
  try {
    const response = await fetch(`${API_URL}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Prezentacja' })
    });
    const room = await response.json();
    if (!response.ok) throw new Error(room.error || 'Nie udało się utworzyć pokoju.');
    applyRoom(room);
    setSyncStatus('Pokój utworzony.');
  } catch (error) {
    setSyncStatus(error.message, true);
  }
});

document.querySelector('#connect-presenter').addEventListener('click', () => connectLive(true));
document.querySelector('#connect-viewer').addEventListener('click', () => connectLive(false));
prevSlideButton.addEventListener('click', () => updateSlide({ indexh: slideIndex() - 1, fragment: -1 }));
nextSlideButton.addEventListener('click', () => updateSlide({ indexh: slideIndex() + 1, fragment: -1 }));
endRoomButton.addEventListener('click', endCurrentRoom);
followPresenterInput.addEventListener('change', () => {
  followPresenter = followPresenterInput.checked;
  if (followPresenter && !presenter) {
    slideState = sanitizeLocalSlideState(presenterState);
    renderSlideState();
    setSyncStatus('Podążanie za prezenterem włączone.');
  } else if (!presenter) {
    setSyncStatus('Podążanie za prezenterem wyłączone.');
  }
  updatePresenterControls();
});

async function pollStatus(publicationId) {
  for (let index = 0; index < 120; index += 1) {
    await wait(5000);
    try {
      const response = await fetch(`${API_URL}/api/publications/${publicationId}/status`);
      const payload = await response.json();
      if (response.ok) {
        setStatus(`Status: ${payload.status}.`);
        renderPublication(payload);
        applyPublicationRoom(payload);
        if (['published', 'failed', 'awaiting_configuration'].includes(payload.status)) return;
      }
    } catch {
      return;
    }
  }
}

async function connectLive(asPresenter) {
  const roomId = roomIdInput.value.trim();
  if (!roomId) {
    setSyncStatus('Podaj identyfikator pokoju.', true);
    roomIdInput.focus();
    return;
  }
  if (asPresenter && !presenterKeyInput.value.trim()) {
    setSyncStatus('Połączenie prezentera wymaga tokenu.', true);
    presenterKeyInput.focus();
    return;
  }

  if (socket) socket.close();
  presenter = asPresenter;
  updatePresenterControls();

  try {
    await loadRoom(roomId);
  } catch (error) {
    setSyncStatus(error.message, true);
    updatePresenterControls();
    return;
  }

  const wsBase = API_URL.replace(/^http/, 'ws');
  const url = new URL(`${wsBase}/ws/live`);
  url.searchParams.set('room', roomId);
  url.searchParams.set('role', asPresenter ? 'presenter' : 'viewer');
  if (asPresenter) url.searchParams.set('token', presenterKeyInput.value);

  socket = new WebSocket(url);
  setSyncStatus('Łączenie...');

  socket.addEventListener('open', () => {
    setSyncStatus(asPresenter ? 'Połączono jako prezenter.' : 'Połączono jako widz.');
    updatePresenterControls();
  });
  socket.addEventListener('close', () => {
    setSyncStatus('Połączenie zamknięte.');
    updatePresenterControls();
  });
  socket.addEventListener('error', () => {
    setSyncStatus('Błąd połączenia WebSocket.', true);
    updatePresenterControls();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'room') {
      applyRoom(message.room);
      if (message.room?.endedAt) {
        setSyncStatus('Pokój został zakończony.');
      }
      return;
    }
    if (message.type === 'state') {
      presenterState = normalizeIncomingSlideState(message.state, presenterState);
      if (presenter || followPresenter) {
        slideState = sanitizeLocalSlideState(presenterState);
        renderSlideState();
      } else {
        updatePresenterControls();
      }
    }
  });
}

function updateSlide(patch) {
  if (!presenter) {
    if (followPresenter) {
      setSyncStatus('Wyłącz podążanie za prezenterem, aby zmienić slajd lokalnie.', true);
      return;
    }
    slideState = sanitizeLocalSlideState({ ...slideState, ...patch });
    renderSlideState();
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setSyncStatus('Sterowanie wymaga połączenia jako prezenter.', true);
    return;
  }
  slideState = sanitizeLocalSlideState({ ...slideState, ...patch });
  presenterState = { ...slideState };
  socket.send(JSON.stringify({ type: 'state:update', state: slideState }));
  renderSlideState();
}

function renderSlideState() {
  const total = currentDeck?.slides.length ?? 0;
  const current = total ? slideIndex() + 1 : 0;
  stateH.textContent = String(current);
  stateTotal.textContent = String(total);
  renderCurrentSlide();
  updatePresenterControls();
}

function renderPublication(publication) {
  clearDetails();
  addDetail('Identyfikator', publication.id);
  addDetail('Status', publication.status);
  addDetail('Format', formatPresentationMode(publication.presentationMode));
  addDetail('Źródło IA', publication.sourceIdentifier);
  addDetail('Wynik IA', publication.outputIdentifier);
  if (publication.resultUrl) addLinkDetail('Publikacja', publication.resultUrl);
  if (publication.accessibilityReport) addLinkDetail('Raport dostępności', publication.accessibilityReport);
  if (publication.viewerUrl) addLinkDetail('Link widza', publication.viewerUrl);
  if (publication.presenterUrl) addLinkDetail('Link prezentera', publication.presenterUrl);
  if (publication.missingConfiguration?.length) {
    addDetail('Brak konfiguracji', publication.missingConfiguration.join(', '));
  }
}

async function loadInitialRoom() {
  try {
    await loadRoom(roomFromUrl);
    await connectLive(Boolean(presenterKeyFromHash));
  } catch (error) {
    setSyncStatus(error.message, true);
  }
}

async function loadRoom(roomId) {
  const response = await fetch(`${API_URL}/api/rooms/${encodeURIComponent(roomId)}`);
  const room = await response.json();
  if (!response.ok) throw new Error(room.error || 'Nie udało się pobrać pokoju.');
  applyRoom(room);
  return room;
}

function applyRoom(room) {
  if (!room) return;
  currentRoom = room;
  roomIdInput.value = room.roomId || roomIdInput.value;
  if (room.presenterKey) presenterKeyInput.value = room.presenterKey;
  if (!presenterKeyInput.value && room.presenterUrl) {
    const key = new URL(room.presenterUrl || window.location.href).hash.slice(1);
    presenterKeyInput.value = new URLSearchParams(key).get('presenterKey') || '';
  }
  if (room.endedAt) {
    renderEndedRoom(room);
    return;
  }
  renderPresentation(room.presentation);
}

function applyPublicationRoom(publication) {
  if (!publication?.roomId) return;
  roomIdInput.value = publication.roomId;
  if (!presenterKeyInput.value && publication.presenterUrl) {
    const key = new URL(publication.presenterUrl || window.location.href).hash.slice(1);
    presenterKeyInput.value = new URLSearchParams(key).get('presenterKey') || '';
  }
  if (publication.resultUrl || publication.status === 'failed') {
    renderPresentation(publicationToPresentation(publication));
  }
}

function publicationToPresentation(publication) {
  return {
    publicationId: publication.id,
    title: publication.title,
    presentationMode: publication.presentationMode,
    status: publication.status,
    resultUrl: publication.resultUrl,
    slidesUrl: publication.slidesUrl,
    accessibilityReport: publication.accessibilityReport,
    archiveIdentifier: publication.archiveIdentifier,
    updatedAt: publication.updatedAt
  };
}

function renderPresentation(presentation) {
  currentPresentation = presentation || null;
  currentDeck = null;
  deckLoadToken += 1;
  clearPresentationStage();

  if (!currentPresentation) {
    presentationStatus.textContent = 'Brak prezentacji przypiętej do pokoju.';
    updatePresenterControls();
    return;
  }

  const mode = formatPresentationMode(currentPresentation.presentationMode);
  if (!currentPresentation.resultUrl) {
    presentationStatus.textContent = currentPresentation.status === 'failed'
      ? 'Publikacja nie powiodła się.'
      : `Prezentacja ${mode} jest jeszcze przetwarzana.`;
    updatePresenterControls();
    return;
  }

  const token = deckLoadToken;
  presentationStage.hidden = false;
  presentationStage.setAttribute('aria-busy', 'true');
  presentationStatus.textContent = `Ładowanie prezentacji ${mode}.`;
  loadPresentationDeck(currentPresentation)
    .then((deck) => {
      if (token !== deckLoadToken) return;
      currentDeck = deck;
      presentationStage.setAttribute('aria-busy', 'false');
      presentationStatus.textContent = `Widoczna prezentacja: ${mode}.`;
      if (!presenter && followPresenter) {
        slideState = sanitizeLocalSlideState(presenterState);
      }
      renderSlideState();
    })
    .catch((error) => {
      if (token !== deckLoadToken) return;
      currentDeck = null;
      presentationStage.setAttribute('aria-busy', 'false');
      presentationStatus.textContent = error.message || 'Nie udało się załadować slajdów.';
      updatePresenterControls();
    });
}

function renderEndedRoom(room) {
  currentPresentation = null;
  currentDeck = null;
  deckLoadToken += 1;
  clearPresentationStage();
  presentationStatus.textContent = 'Pokój zakończony. Prezentacja nie jest już dostępna w tym pokoju.';
  stateH.textContent = '0';
  stateTotal.textContent = '0';
  updatePresenterControls();
  if (room.archiveDeletion?.some((entry) => entry.status === 'failed')) {
    setSyncStatus('Pokój zakończony, ale nie wszystkie pliki Archive udało się usunąć.', true);
  }
}

async function endCurrentRoom() {
  if (!presenter || !currentRoom?.roomId || currentRoom.endedAt) return;
  const presenterKey = presenterKeyInput.value.trim();
  if (!presenterKey) {
    setSyncStatus('Zakończenie pokoju wymaga tokenu prezentera.', true);
    presenterKeyInput.focus();
    return;
  }

  const confirmed = window.confirm('Zakończyć pokój i usunąć opublikowane pliki prezentacji?');
  if (!confirmed) return;

  endRoomButton.disabled = true;
  setSyncStatus('Kończenie pokoju i usuwanie prezentacji...');
  try {
    const response = await fetch(`${API_URL}/api/rooms/${encodeURIComponent(currentRoom.roomId)}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presenterKey })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Nie udało się zakończyć pokoju.');
    applyRoom(payload.room);
    const failed = (payload.archiveDeletion || []).filter((entry) => entry.status === 'failed');
    setSyncStatus(failed.length
      ? 'Pokój zakończony, ale część plików Archive wymaga ręcznego sprawdzenia.'
      : 'Pokój zakończony. Prezentacja została usunięta z pokoju.');
  } catch (error) {
    setSyncStatus(error.message, true);
    updatePresenterControls();
  }
}

async function loadPresentationDeck(presentation) {
  const slidesUrl = presentation.slidesUrl || inferSlidesUrl(presentation.resultUrl);
  if (slidesUrl) {
    try {
      const response = await fetch(slidesUrl);
      if (response.ok) {
        return normalizeSlidesJson(await response.json(), slidesUrl, presentation);
      }
      if (response.status !== 404) {
        throw new Error(`Nie udało się pobrać danych slajdów: ${response.status}.`);
      }
    } catch (error) {
      if (!presentation.resultUrl) throw error;
    }
  }
  return loadDeckFromHtml(presentation);
}

function normalizeSlidesJson(payload, slidesUrl, presentation) {
  const baseUrl = new URL('.', slidesUrl).toString();
  const rawSlides = Array.isArray(payload?.slides) ? payload.slides : [];
  const slides = rawSlides.map((slide, index) => ({
    index: Number.isInteger(slide.index) ? slide.index : index + 1,
    title: cleanText(slide.title) || `Slajd ${index + 1}`,
    imageUrl: resolveAssetUrl(slide.image, baseUrl),
    paragraphs: normalizeParagraphs(slide.paragraphs),
    tables: normalizeTables(slide.tables),
    media: normalizeMedia(slide.media, baseUrl),
    nonTextShapes: Number.isInteger(slide.nonTextShapes) ? slide.nonTextShapes : 0
  }));

  if (!slides.length) throw new Error('Prezentacja nie zawiera slajdów.');
  return {
    title: cleanText(payload?.title) || presentation.title || 'Prezentacja',
    slides
  };
}

async function loadDeckFromHtml(presentation) {
  const response = await fetch(presentation.resultUrl);
  if (!response.ok) throw new Error(`Nie udało się pobrać prezentacji: ${response.status}.`);
  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sections = [...doc.querySelectorAll('.reveal .slides > section')];
  if (!sections.length) throw new Error('Nie znaleziono slajdów w prezentacji.');

  const slides = sections.map((section, index) => extractSlideFromHtml(section, index, presentation.resultUrl));
  if (!slides.length) throw new Error('Nie znaleziono treści slajdów.');
  return {
    title: presentation.title || doc.title || 'Prezentacja',
    slides
  };
}

function extractSlideFromHtml(section, index, baseUrl) {
  const textRoot = section.querySelector('.slide-text') || section;
  const heading = textRoot.querySelector('h1, h2, h3, h4, h5, h6');
  const image = section.querySelector('.slide-visual img') || section.querySelector('img');
  const title = cleanText(heading?.textContent) || `Slajd ${index + 1}`;
  const paragraphs = [...textRoot.querySelectorAll('p, li')]
    .filter((node) => !node.closest('table'))
    .map((node) => ({
      text: cleanText(node.textContent),
      level: indentLevelFromClass(node.className)
    }))
    .filter((item) => item.text);
  const tables = [...textRoot.querySelectorAll('table')]
    .map((table) => ({
      rows: [...table.querySelectorAll('tr')]
        .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cleanText(cell.textContent)))
        .filter((row) => row.some(Boolean))
    }))
    .filter((table) => table.rows.length);
  const media = [...section.querySelectorAll('audio, video')]
    .map((element, mediaIndex) => {
      const source = element.querySelector('source')?.getAttribute('src') || element.getAttribute('src');
      const figure = element.closest('figure');
      const caption = cleanText(figure?.querySelector('figcaption')?.textContent);
      const type = element.tagName.toLowerCase() === 'video' ? 'video' : 'audio';
      return {
        type,
        src: resolveAssetUrl(source, baseUrl),
        mimeType: element.querySelector('source')?.getAttribute('type') || '',
        title: element.getAttribute('aria-label') || caption || `${type === 'video' ? 'Wideo' : 'Audio'} ${mediaIndex + 1}`,
        description: caption
      };
    })
    .filter((item) => item.src);

  return {
    index: index + 1,
    title,
    imageUrl: resolveAssetUrl(image?.getAttribute('src'), baseUrl),
    paragraphs,
    tables,
    media,
    nonTextShapes: image ? 1 : 0
  };
}

function renderCurrentSlide() {
  if (!currentDeck?.slides.length) {
    clearPresentationStage();
    return;
  }

  const index = slideIndex();
  const total = currentDeck.slides.length;
  const slide = currentDeck.slides[index];
  presentationStage.hidden = false;
  slideCounter.textContent = `Slajd ${index + 1} z ${total}`;
  slideText.replaceChildren();

  const title = document.createElement('h3');
  title.id = 'slide-title';
  title.textContent = slide.title;
  slideText.append(title);

  let hasBody = false;
  for (const paragraph of slide.paragraphs) {
    const element = document.createElement('p');
    element.className = `indent-${Math.min(paragraph.level, 4)}`;
    element.textContent = paragraph.text;
    slideText.append(element);
    hasBody = true;
  }

  slide.tables.forEach((table, tableIndex) => {
    slideText.append(renderTable(table.rows, index, tableIndex));
    hasBody = true;
  });

  if (slide.media.length) {
    slideText.append(renderMediaSection(slide.media));
    hasBody = true;
  }

  if (!hasBody) {
    const empty = document.createElement('p');
    empty.textContent = 'Brak tekstu możliwego do automatycznego wyciągnięcia z tego slajdu.';
    slideText.append(empty);
  }

  if (slide.imageUrl) {
    slideImage.src = slide.imageUrl;
    slideImage.alt = '';
    slideVisual.hidden = false;
  } else {
    slideImage.removeAttribute('src');
    slideVisual.hidden = true;
  }
}

function renderTable(rows, slideIndexValue, tableIndex) {
  const table = document.createElement('table');
  const caption = document.createElement('caption');
  caption.textContent = `Tabela ${tableIndex + 1} na slajdzie ${slideIndexValue + 1}`;
  table.append(caption);
  const tbody = document.createElement('tbody');
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    row.forEach((cell) => {
      const element = rowIndex === 0 && rows.length > 1
        ? document.createElement('th')
        : document.createElement('td');
      if (element.tagName === 'TH') element.scope = 'col';
      element.textContent = cell;
      tr.append(element);
    });
    tbody.append(tr);
  });
  table.append(tbody);
  return table;
}

function renderMediaSection(mediaItems) {
  const section = document.createElement('section');
  section.className = 'slide-media-list';
  const heading = document.createElement('h4');
  heading.textContent = 'Multimedia';
  section.append(heading);

  mediaItems.forEach((media, index) => {
    const figure = document.createElement('figure');
    figure.className = 'slide-media';
    const player = document.createElement(media.type === 'video' ? 'video' : 'audio');
    player.controls = true;
    player.preload = 'metadata';
    player.setAttribute('aria-label', media.title || mediaLabel(media.type, index));

    const source = document.createElement('source');
    source.src = media.src;
    if (media.mimeType) source.type = media.mimeType;
    player.append(source);
    player.append(document.createTextNode('Twoja przeglądarka nie może odtworzyć tego materiału.'));

    const caption = document.createElement('figcaption');
    const title = document.createElement('strong');
    title.textContent = media.title || mediaLabel(media.type, index);
    caption.append(title);
    if (media.description) {
      caption.append(document.createElement('br'), document.createTextNode(media.description));
    }

    figure.append(player, caption);
    section.append(figure);
  });

  return section;
}

function mediaLabel(type, index) {
  return `${type === 'video' ? 'Wideo' : 'Audio'} ${index + 1}`;
}

function clearPresentationStage() {
  presentationStage.hidden = true;
  presentationStage.setAttribute('aria-busy', 'false');
  slideCounter.textContent = '';
  slideText.replaceChildren();
  slideImage.removeAttribute('src');
  slideVisual.hidden = true;
  stateH.textContent = '0';
  stateTotal.textContent = '0';
}

function updatePresenterControls() {
  const hasDeck = Boolean(currentDeck?.slides.length);
  const roomOpen = !currentRoom?.endedAt;
  const canControl = hasDeck && (
    (presenter && socket?.readyState === WebSocket.OPEN && roomOpen)
    || (!presenter && !followPresenter && roomOpen)
  );
  const index = slideIndex();
  prevSlideButton.disabled = !canControl || index <= 0;
  nextSlideButton.disabled = !canControl || index >= (currentDeck?.slides.length ?? 0) - 1;
  endRoomButton.disabled = !(
    presenter
    && socket?.readyState === WebSocket.OPEN
    && currentRoom?.roomId
    && roomOpen
  );
  followPresenterInput.disabled = presenter;
  followPresenterInput.checked = followPresenter;
}

function normalizeIncomingSlideState(state, fallback) {
  const next = { ...fallback };
  if (Number.isInteger(state?.indexh) && state.indexh >= 0 && state.indexh <= 10000) {
    next.indexh = state.indexh;
  }
  next.indexv = 0;
  next.fragment = -1;
  next.paused = false;
  return next;
}

function sanitizeLocalSlideState(state) {
  return {
    ...state,
    indexh: clampSlideIndex(state.indexh),
    indexv: 0,
    fragment: -1,
    paused: false
  };
}

function slideIndex() {
  return clampSlideIndex(slideState.indexh);
}

function clampSlideIndex(value) {
  const raw = Number.isInteger(value) ? value : Number.parseInt(value, 10);
  const index = Number.isFinite(raw) ? raw : 0;
  const max = currentDeck?.slides.length ? currentDeck.slides.length - 1 : 0;
  return Math.max(0, Math.min(index, max));
}

function inferSlidesUrl(resultUrl) {
  if (!resultUrl) return '';
  try {
    const url = new URL(resultUrl, window.location.href);
    if (!url.pathname.endsWith('/index.html')) return '';
    url.pathname = url.pathname.replace(/\/index\.html$/, '/slides.json');
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeParagraphs(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      text: cleanText(item?.text ?? item),
      level: clampIndent(item?.level)
    }))
    .filter((item) => item.text);
}

function normalizeTables(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      rows: Array.isArray(item?.rows)
        ? item.rows.map((row) => Array.isArray(row) ? row.map(cleanText) : [])
        : []
    }))
    .filter((item) => item.rows.some((row) => row.some(Boolean)));
}

function normalizeMedia(items, baseUrl) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => {
      const type = item?.type === 'video' ? 'video' : item?.type === 'audio' ? 'audio' : '';
      const src = resolveAssetUrl(item?.src, baseUrl);
      if (!type || !src) return null;
      return {
        type,
        src,
        mimeType: cleanText(item?.mimeType),
        title: cleanText(item?.title) || mediaLabel(type, index),
        description: cleanText(item?.description)
      };
    })
    .filter(Boolean);
}

function indentLevelFromClass(className) {
  const match = String(className ?? '').match(/\bindent-(\d+)\b/);
  return clampIndent(match ? Number(match[1]) : 0);
}

function clampIndent(value) {
  return Math.max(0, Math.min(Number.isInteger(value) ? value : 0, 4));
}

function resolveAssetUrl(value, baseUrl) {
  if (!value) return '';
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    if (url.protocol === 'data:' && url.pathname.startsWith('image/')) return url.toString();
  } catch {
    return '';
  }
  return '';
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function addDetail(label, value) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const desc = document.createElement('dd');
  term.textContent = label;
  desc.textContent = value || '-';
  row.append(term, desc);
  details.append(row);
}

function addLinkDetail(label, href) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const desc = document.createElement('dd');
  const link = document.createElement('a');
  term.textContent = label;
  link.href = href;
  link.textContent = href;
  desc.append(link);
  row.append(term, desc);
  details.append(row);
}

function clearDetails() {
  details.replaceChildren();
}

function updateBundleMode() {
  const mode = getPresentationMode();
  bundleInput.accept = mode === 'pptx' ? '.pptx' : '.zip,.tar,.gz,.tgz,.md';
  bundleHint.textContent = mode === 'pptx'
    ? 'Obsługiwane: pojedynczy plik PPTX.'
    : 'Obsługiwane: ZIP, TAR, TGZ albo pojedynczy plik Markdown.';
  validateBundleForMode();
}

function validateBundleForMode() {
  const file = bundleInput.files[0];
  if (!file) {
    bundleInput.setCustomValidity('');
    bundleInput.removeAttribute('aria-invalid');
    return;
  }

  const name = file.name.toLowerCase();
  const mode = getPresentationMode();
  const valid = mode === 'pptx'
    ? name.endsWith('.pptx')
    : /\.(zip|tar|tar\.gz|tgz|md)$/.test(name);

  if (valid) {
    bundleInput.removeAttribute('aria-invalid');
  } else {
    bundleInput.setAttribute('aria-invalid', 'true');
  }

  bundleInput.setCustomValidity(valid
    ? ''
    : mode === 'pptx'
      ? 'Wybierz plik PPTX.'
      : 'Wybierz plik ZIP, TAR, TGZ albo Markdown.');
}

function getPresentationMode() {
  return modeInputs.find((input) => input.checked)?.value || 'markdown';
}

function formatPresentationMode(mode) {
  if (mode === 'pptx') return 'PPTX / HTML';
  return 'Markdown / HTML';
}

function setStatus(message, error = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle('error', error);
}

function setSyncStatus(message, error = false) {
  syncStatus.textContent = message;
  syncStatus.classList.toggle('error', error);
}

function setFormDisabled(disabled) {
  publishForm.querySelectorAll('button, input, select').forEach((element) => {
    element.disabled = disabled;
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
